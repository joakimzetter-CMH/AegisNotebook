import asyncio
from typing import Annotated, Optional

import aiosqlite
from ai_prompter import Prompter
from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from open_notebook.ai.provision import provision_langchain_model
from open_notebook.config import LANGGRAPH_CHECKPOINT_FILE
from open_notebook.domain.notebook import Notebook
from open_notebook.exceptions import OpenNotebookError
from open_notebook.utils import clean_thinking_content
from open_notebook.utils.context_builder import build_skill_context
from open_notebook.utils.error_classifier import classify_error
from open_notebook.utils.text_utils import extract_text_content


class ThreadState(TypedDict):
    messages: Annotated[list, add_messages]
    notebook: Optional[Notebook]
    context: Optional[str]
    context_config: Optional[dict]
    model_override: Optional[str]
    skill_context: Optional[str]


def _latest_human_message(state: ThreadState) -> str:
    for message in reversed(state.get("messages", [])):
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content
    return ""


async def call_model_with_messages(state: ThreadState, config: RunnableConfig) -> dict:
    try:
        query = _latest_human_message(state)
        skill_context = await build_skill_context(query) if query else ""
        system_prompt = Prompter(prompt_template="chat/system").render(  # type: ignore[arg-type]
            data={**state, "skill_context": skill_context}
        )
        payload = [SystemMessage(content=system_prompt)] + state.get("messages", [])
        model_id = config.get("configurable", {}).get("model_id") or state.get(
            "model_override"
        )

        model = await provision_langchain_model(
            str(payload), model_id, "chat", max_tokens=8192
        )

        # Stream the model call (rather than a single .ainvoke()) so that
        # LangGraph's stream_mode="messages" has token-level chunks to relay
        # to the streaming chat endpoint as they're generated.
        full = None
        async for chunk in model.astream(payload):
            full = chunk if full is None else full + chunk

        # `full` is an AIMessageChunk here, whose .type is the literal
        # "AIMessageChunk", not "ai" - every downstream `msg.type == "ai"`
        # check (extract_chat_messages, ChatPanel.tsx) would silently break
        # if this were returned as-is, so rebuild a real AIMessage.
        raw_content = extract_text_content(full.content) if full is not None else ""
        cleaned_content = clean_thinking_content(raw_content)
        ai_message = AIMessage(
            content=cleaned_content,
            id=full.id if full is not None else None,
            response_metadata=getattr(full, "response_metadata", {}) or {},
        )

        return {"messages": ai_message}
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


agent_state = StateGraph(ThreadState)
agent_state.add_node("agent", call_model_with_messages)
agent_state.add_edge(START, "agent")
agent_state.add_edge("agent", END)

_compiled_graph = None
_compiled_graph_lock = asyncio.Lock()


async def get_graph():
    """Lazily compile the chat graph with an AsyncSqliteSaver checkpoint.

    Mirrors open_notebook/graphs/session.py's get_graph(). The node is fully
    async (it calls model.astream() directly), so the checkpointer must be
    async too - LangGraph's sync SqliteSaver raises "does not support async
    methods" here. The connection is opened lazily because aiosqlite.connect()
    is itself a coroutine and can't run at plain module-import time.
    """
    global _compiled_graph
    if _compiled_graph is None:
        async with _compiled_graph_lock:
            if _compiled_graph is None:
                conn = await aiosqlite.connect(LANGGRAPH_CHECKPOINT_FILE)
                memory = AsyncSqliteSaver(conn)
                _compiled_graph = agent_state.compile(checkpointer=memory)
    return _compiled_graph
