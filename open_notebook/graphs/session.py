import asyncio
from typing import Annotated, List, Literal, Optional

import aiosqlite
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from open_notebook.config import SESSION_CHECKPOINT_FILE
from open_notebook.domain.notebook import GeneratedDocument
from open_notebook.exceptions import OpenNotebookError
from open_notebook.graphs.ask import graph as ask_graph
from open_notebook.graphs.generate_document import graph as generate_graph
from open_notebook.utils.error_classifier import classify_error
from open_notebook.utils.text_utils import extract_text_content


class SessionState(TypedDict):
    messages: Annotated[list, add_messages]
    notebook_ids: List[str]
    mode_hint: Optional[Literal["ask", "generate"]]
    active_document_id: Optional[str]
    language: Optional[Literal["en", "sv", "bilingual"]]


def _latest_human_text(state: SessionState) -> str:
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage):
            return extract_text_content(message.content)
    return ""


def _format_session_history(state: SessionState) -> Optional[str]:
    """Every prior message (Q&A exchanges and past generation summaries) in
    this session, excluding the human message that triggered the current
    turn - lets a generate turn use facts established earlier as clarified
    requirements, mirroring Aegis's shared chat_history across its
    generate/QA modes."""
    messages = state.get("messages", [])
    if len(messages) <= 1:
        return None
    lines = []
    for message in messages[:-1]:
        role = "User" if isinstance(message, HumanMessage) else "Assistant"
        content = extract_text_content(message.content)
        if content:
            lines.append(f"{role}: {content}")
    return "\n\n".join(lines) if lines else None


def route_turn(state: SessionState, config: RunnableConfig) -> str:
    """Explicit mode routing (UI toggle / configurable), not LLM
    classification - reliable and avoids an extra model call misclassifying
    the turn before any real work happens."""
    return state.get("mode_hint") or "ask"


async def ask_turn(state: SessionState, config: RunnableConfig) -> dict:
    try:
        writer = get_stream_writer()
        question = _latest_human_text(state)
        configurable = config.get("configurable", {})

        final_answer = None
        async for mode, chunk in ask_graph.astream(  # type: ignore[call-overload]
            input=dict(question=question, notebook_ids=state.get("notebook_ids")),
            config=RunnableConfig(configurable=configurable),
            stream_mode=["updates", "custom"],
        ):
            if mode == "updates" and "write_final_answer" in chunk:
                final_answer = chunk["write_final_answer"]["final_answer"]
            elif mode == "custom":
                writer(chunk)

        answer = final_answer or "I could not find an answer to that question."
        return {"messages": AIMessage(content=answer)}
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


async def generate_turn(state: SessionState, config: RunnableConfig) -> dict:
    try:
        writer = get_stream_writer()
        topic = _latest_human_text(state)
        session_history = _format_session_history(state)
        configurable = config.get("configurable", {})
        notebook_ids = state.get("notebook_ids") or []
        language = state.get("language") or "bilingual"
        active_document_id = state.get("active_document_id")

        previous_content = None
        if active_document_id:
            existing = await GeneratedDocument.get(active_document_id)
            previous_content = existing.content

        document_id = active_document_id
        version = None
        draft = ""
        async for mode, chunk in generate_graph.astream(  # type: ignore[call-overload]
            {
                "topic": topic,
                "notebook_ids": notebook_ids,
                "language": language,
                "previous_content": previous_content,
                "session_history": session_history,
                "session_id": configurable.get("thread_id"),
                "document_id": active_document_id,
            },
            config=RunnableConfig(configurable=configurable),
            stream_mode=["updates", "custom"],
        ):
            if mode == "updates":
                if "draft_document" in chunk:
                    draft = chunk["draft_document"].get("draft", draft)
                if "persist_document" in chunk:
                    document_id = chunk["persist_document"].get("document_id", document_id)
                    version = chunk["persist_document"].get("version", version)
            elif mode == "custom":
                writer(chunk)

        summary = f"Generated document (v{version}, id: {document_id}):\n\n{draft}"

        return {
            "messages": AIMessage(content=summary),
            "active_document_id": document_id,
        }
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


agent_state = StateGraph(SessionState)
agent_state.add_node("ask_turn", ask_turn)
agent_state.add_node("generate_turn", generate_turn)
agent_state.add_conditional_edges(
    START, route_turn, {"ask": "ask_turn", "generate": "generate_turn"}
)
agent_state.add_edge("ask_turn", END)
agent_state.add_edge("generate_turn", END)

_compiled_graph = None
_compiled_graph_lock = asyncio.Lock()


async def get_graph():
    """Lazily compile the session graph with an AsyncSqliteSaver checkpoint.

    The graph and its ask/generate nodes are fully async (they call
    ask_graph.astream()/generate_graph.ainvoke() directly), so the
    checkpointer must be async too - LangGraph's sync SqliteSaver (used by
    chat.py) raises "does not support async methods" here. The connection
    is opened lazily because aiosqlite.connect() is itself a coroutine and
    can't run at plain module-import time.
    """
    global _compiled_graph
    if _compiled_graph is None:
        async with _compiled_graph_lock:
            if _compiled_graph is None:
                conn = await aiosqlite.connect(SESSION_CHECKPOINT_FILE)
                memory = AsyncSqliteSaver(conn)
                _compiled_graph = agent_state.compile(checkpointer=memory)
    return _compiled_graph
