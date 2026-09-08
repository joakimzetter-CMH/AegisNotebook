from typing import List, Literal, Optional

from ai_prompter import Prompter
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from open_notebook.ai.provision import provision_langchain_model
from open_notebook.domain.notebook import GeneratedDocument, vector_search
from open_notebook.exceptions import OpenNotebookError
from open_notebook.utils import clean_thinking_content
from open_notebook.utils.error_classifier import classify_error
from open_notebook.utils.text_utils import extract_text_content


class GenerateState(TypedDict):
    topic: str
    notebook_ids: List[str]
    language: Literal["en", "sv", "bilingual"]
    previous_content: Optional[str]
    session_history: Optional[str]
    session_id: Optional[str]
    retrieved_context: str
    draft: str
    document_id: Optional[str]
    version: int


def _format_search_results(results: list) -> str:
    blocks = []
    for r in results:
        title = r.get("title") or "Untitled"
        matches = r.get("matches")
        if isinstance(matches, list):
            content = "\n".join(str(m) for m in matches)
        else:
            content = str(matches or "")
        if content.strip():
            blocks.append(f"[Source: {title}]\n{content}")
    return "\n\n".join(blocks)


async def gather_context(state: GenerateState, config: RunnableConfig) -> dict:
    try:
        get_stream_writer()({"type": "status", "stage": "gathering_context"})
        results = await vector_search(
            state["topic"], 8, True, True, notebook_ids=state.get("notebook_ids")
        )
        return {"retrieved_context": _format_search_results(results)}
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


async def draft_document(state: GenerateState, config: RunnableConfig) -> dict:
    try:
        writer = get_stream_writer()
        writer({"type": "status", "stage": "drafting"})
        system_prompt = Prompter(prompt_template="generate/architecture_doc").render(
            data=state  # type: ignore[arg-type]
        )
        model = await provision_langchain_model(
            system_prompt,
            config.get("configurable", {}).get("model_id"),
            "chat",
            max_tokens=8192,
        )
        full = None
        async for chunk in model.astream(system_prompt):
            full = chunk if full is None else full + chunk
            delta = extract_text_content(chunk.content) if chunk is not None else ""
            if delta:
                writer({"type": "token", "content": delta})
        content = extract_text_content(full.content) if full is not None else ""
        return {"draft": clean_thinking_content(content)}
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


async def persist_document(state: GenerateState, config: RunnableConfig) -> dict:
    try:
        get_stream_writer()({"type": "status", "stage": "saving"})
        existing_id = state.get("document_id")
        if existing_id:
            document = await GeneratedDocument.get(existing_id)
            document.content = state["draft"]
            document.version = (document.version or 1) + 1
        else:
            document = GeneratedDocument(
                title=state["topic"][:100],
                content=state["draft"],
                language=state.get("language", "bilingual"),
                version=1,
                source_session=state.get("session_id"),
            )
        await document.save()

        for notebook_id in state.get("notebook_ids") or []:
            await document.compile_from_notebook(notebook_id)

        return {"document_id": str(document.id), "version": document.version}
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


agent_state = StateGraph(GenerateState)
agent_state.add_node("gather_context", gather_context)
agent_state.add_node("draft_document", draft_document)
agent_state.add_node("persist_document", persist_document)
agent_state.add_edge(START, "gather_context")
agent_state.add_edge("gather_context", "draft_document")
agent_state.add_edge("draft_document", "persist_document")
agent_state.add_edge("persist_document", END)

graph = agent_state.compile()
