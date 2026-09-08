import asyncio
import json
import traceback
from typing import AsyncGenerator, List, Literal, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from loguru import logger
from pydantic import BaseModel, Field

from api.routers._chat_shared import (
    ChatMessage,
    SuccessResponse,
    extract_chat_messages,
    normalize_record_id,
)
from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.domain.notebook import GeneratedDocument, ResearchSession
from open_notebook.exceptions import NotFoundError, OpenNotebookError
from open_notebook.graphs.session import get_graph as get_session_graph
from open_notebook.utils.text_utils import extract_text_content

router = APIRouter()


# Request/Response models (local to this router, mirroring api/routers/chat.py's
# convention rather than living in api/models.py)
class CreateResearchSessionRequest(BaseModel):
    notebook_ids: List[str] = Field(
        ..., min_length=1, description="Notebook IDs this session is scoped to"
    )
    title: Optional[str] = Field(None, description="Optional session title")
    model_override: Optional[str] = Field(
        None, description="Optional model override for this session"
    )


class UpdateResearchSessionRequest(BaseModel):
    title: Optional[str] = Field(None, description="New session title")
    model_override: Optional[str] = Field(
        None, description="Model override for this session"
    )


class ResearchSessionResponse(BaseModel):
    id: str = Field(..., description="Session ID")
    title: str = Field(..., description="Session title")
    notebook_ids: List[str] = Field(
        default_factory=list, description="Notebook IDs this session is scoped to"
    )
    created: str = Field(..., description="Creation timestamp")
    updated: str = Field(..., description="Last update timestamp")
    message_count: Optional[int] = Field(
        None, description="Number of messages in session"
    )
    model_override: Optional[str] = Field(None, description="Model override")
    active_document_id: Optional[str] = Field(
        None, description="Most recently generated/refined document in this session"
    )


class ResearchSessionWithMessagesResponse(ResearchSessionResponse):
    messages: List[ChatMessage] = Field(default_factory=list)


class ExecuteResearchSessionRequest(BaseModel):
    session_id: str = Field(..., description="Research session ID")
    message: str = Field(..., description="User message content")
    mode: Literal["ask", "generate"] = Field(
        "ask",
        description="Whether this turn asks a question or generates/refines a document",
    )
    language: Optional[Literal["en", "sv", "bilingual"]] = Field(
        None,
        description="Document language (generate mode only, defaults to bilingual)",
    )
    model_override: Optional[str] = Field(
        None, description="Optional model override for this turn"
    )


class StreamResearchSessionRequest(BaseModel):
    message: str = Field(..., description="User message content")
    mode: Literal["ask", "generate"] = Field(
        "ask",
        description="Whether this turn asks a question or generates/refines a document",
    )
    language: Optional[Literal["en", "sv", "bilingual"]] = Field(
        None,
        description="Document language (generate mode only, defaults to bilingual)",
    )
    model_override: Optional[str] = Field(
        None, description="Optional model override for this turn"
    )


class ExecuteResearchSessionResponse(BaseModel):
    session_id: str
    messages: List[ChatMessage]
    active_document_id: Optional[str] = None


class GeneratedDocumentResponse(BaseModel):
    id: str
    title: str
    content: str
    version: int
    language: str
    status: str
    notebook_ids: List[str] = Field(default_factory=list)
    source_session: Optional[str] = None
    created: str
    updated: str


async def get_research_session_or_404(session_id: str) -> Tuple[str, ResearchSession]:
    full_session_id = normalize_record_id("research_session", session_id)
    session = await ResearchSession.get(full_session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Research session not found")
    return full_session_id, session


async def _get_session_state_values(session_id: str) -> dict:
    graph = await get_session_graph()
    state = await graph.aget_state(
        config=RunnableConfig(configurable={"thread_id": session_id})
    )
    return dict(state.values) if state and state.values else {}


async def _document_to_response(document: GeneratedDocument) -> GeneratedDocumentResponse:
    notebook_ids = await document.get_notebook_ids()
    return GeneratedDocumentResponse(
        id=document.id or "",
        title=document.title,
        content=document.content,
        version=document.version,
        language=document.language,
        status=document.status,
        notebook_ids=notebook_ids,
        source_session=document.source_session,
        created=str(document.created),
        updated=str(document.updated),
    )


@router.get("/research-sessions", response_model=List[ResearchSessionResponse])
async def list_research_sessions():
    """List all research sessions."""
    try:
        sessions = await ResearchSession.get_all(order_by="updated desc")
        results = []
        for session in sessions:
            notebook_ids = await session.get_notebook_ids()
            state_values = await _get_session_state_values(session.id or "")
            msg_count = len(state_values.get("messages", []))
            active_document_id = state_values.get("active_document_id")
            results.append(
                ResearchSessionResponse(
                    id=session.id or "",
                    title=session.title or "Untitled Session",
                    notebook_ids=notebook_ids,
                    created=str(session.created),
                    updated=str(session.updated),
                    message_count=msg_count,
                    model_override=session.model_override,
                    active_document_id=active_document_id,
                )
            )
        return results
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error listing research sessions: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error listing research sessions: {str(e)}"
        )


@router.post("/research-sessions", response_model=ResearchSessionResponse)
async def create_research_session(request: CreateResearchSessionRequest):
    """Create a new research session scoped to one or more notebooks."""
    try:
        session = ResearchSession(
            title=request.title
            or f"Research Session {asyncio.get_event_loop().time():.0f}",
            model_override=request.model_override,
        )
        await session.save()

        for notebook_id in request.notebook_ids:
            await session.scope_to_notebook(notebook_id)

        return ResearchSessionResponse(
            id=session.id or "",
            title=session.title or "",
            notebook_ids=request.notebook_ids,
            created=str(session.created),
            updated=str(session.updated),
            message_count=0,
            model_override=session.model_override,
            active_document_id=None,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="One or more notebooks not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error creating research session: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error creating research session: {str(e)}"
        )


@router.get(
    "/research-sessions/{session_id}",
    response_model=ResearchSessionWithMessagesResponse,
)
async def get_research_session(session_id: str):
    """Get a research session with its message history."""
    try:
        full_session_id, session = await get_research_session_or_404(session_id)

        state_values = await _get_session_state_values(full_session_id)
        messages: List[ChatMessage] = []
        if "messages" in state_values:
            messages = extract_chat_messages(state_values["messages"])
        active_document_id = state_values.get("active_document_id")

        notebook_ids = await session.get_notebook_ids()

        return ResearchSessionWithMessagesResponse(
            id=session.id or "",
            title=session.title or "Untitled Session",
            notebook_ids=notebook_ids,
            created=str(session.created),
            updated=str(session.updated),
            message_count=len(messages),
            messages=messages,
            model_override=session.model_override,
            active_document_id=active_document_id,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching research session: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching research session: {str(e)}"
        )


@router.put("/research-sessions/{session_id}", response_model=ResearchSessionResponse)
async def update_research_session(session_id: str, request: UpdateResearchSessionRequest):
    """Update a research session's title/model override."""
    try:
        full_session_id, session = await get_research_session_or_404(session_id)

        update_data = request.model_dump(exclude_unset=True)
        if "title" in update_data:
            session.title = update_data["title"]
        if "model_override" in update_data:
            session.model_override = update_data["model_override"]
        await session.save()

        notebook_ids = await session.get_notebook_ids()
        state_values = await _get_session_state_values(full_session_id)
        msg_count = len(state_values.get("messages", []))
        active_document_id = state_values.get("active_document_id")

        return ResearchSessionResponse(
            id=session.id or "",
            title=session.title or "",
            notebook_ids=notebook_ids,
            created=str(session.created),
            updated=str(session.updated),
            message_count=msg_count,
            model_override=session.model_override,
            active_document_id=active_document_id,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating research session: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error updating research session: {str(e)}"
        )


@router.delete("/research-sessions/{session_id}", response_model=SuccessResponse)
async def delete_research_session(session_id: str):
    """Delete a research session (generated documents are kept)."""
    try:
        _full_session_id, session = await get_research_session_or_404(session_id)
        await session.delete()
        return SuccessResponse(
            success=True, message="Research session deleted successfully"
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error deleting research session: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error deleting research session: {str(e)}"
        )


@router.post("/research-sessions/execute", response_model=ExecuteResearchSessionResponse)
async def execute_research_session(request: ExecuteResearchSessionRequest):
    """Execute one turn (ask or generate) in a research session."""
    try:
        full_session_id, session = await get_research_session_or_404(
            request.session_id
        )
        notebook_ids = await session.get_notebook_ids()

        model_override = (
            request.model_override
            if request.model_override is not None
            else session.model_override
        )

        state_values = await _get_session_state_values(full_session_id)
        state_values["messages"] = state_values.get("messages", []) + [
            HumanMessage(content=request.message)
        ]
        state_values["notebook_ids"] = notebook_ids
        state_values["mode_hint"] = request.mode
        if request.language:
            state_values["language"] = request.language

        configurable = {
            "thread_id": full_session_id,
            "model_id": model_override,
            "strategy_model": model_override,
            "answer_model": model_override,
            "final_answer_model": model_override,
        }

        graph = await get_session_graph()
        result = await graph.ainvoke(
            input=state_values,  # type: ignore[arg-type]
            config=RunnableConfig(configurable=configurable),
        )

        await session.save()  # bump `updated`

        messages = extract_chat_messages(result.get("messages", []))
        return ExecuteResearchSessionResponse(
            session_id=request.session_id,
            messages=messages,
            active_document_id=result.get("active_document_id"),
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(
            f"Error executing research session turn: {str(e)}\n"
            f"  Session ID: {request.session_id}\n"
            f"  Traceback:\n{traceback.format_exc()}"
        )
        raise HTTPException(
            status_code=500, detail=f"Error executing research session turn: {str(e)}"
        )


async def stream_research_session_response(
    session_id: str,
    session: ResearchSession,
    message: str,
    mode: Literal["ask", "generate"],
    language: Optional[Literal["en", "sv", "bilingual"]],
    model_override: Optional[str],
    notebook_ids: List[str],
) -> AsyncGenerator[str, None]:
    """Stream a research session turn as Server-Sent Events.

    Emits: user_message -> N x (status | token) -> ai_message -> complete
    (or an error event in place of the rest if something fails). Mirrors
    api/routers/chat.py's stream_chat_response - the outer session graph is
    invoked with stream_mode="custom" so the status/token events that
    ask_turn/generate_turn relay from their nested ask_graph/generate_graph
    calls pass straight through unchanged.
    """
    try:
        yield f"data: {json.dumps({'type': 'user_message', 'content': message, 'timestamp': None})}\n\n"

        state_values = await _get_session_state_values(session_id)
        state_values["messages"] = state_values.get("messages", []) + [
            HumanMessage(content=message)
        ]
        state_values["notebook_ids"] = notebook_ids
        state_values["mode_hint"] = mode
        if language:
            state_values["language"] = language

        configurable = {
            "thread_id": session_id,
            "model_id": model_override,
            "strategy_model": model_override,
            "answer_model": model_override,
            "final_answer_model": model_override,
        }

        graph = await get_session_graph()
        config = RunnableConfig(configurable=configurable)
        async for chunk in graph.astream(  # type: ignore[call-overload]
            input=state_values,  # type: ignore[arg-type]
            config=config,
            stream_mode="custom",
        ):
            yield f"data: {json.dumps(chunk)}\n\n"

        await session.save()  # bump `updated`

        final_state = await graph.aget_state(config)
        final_values = final_state.values if final_state and final_state.values else {}
        final_messages = final_values.get("messages", [])
        final_content = (
            extract_text_content(final_messages[-1].content) if final_messages else ""
        )
        active_document_id = final_values.get("active_document_id")

        yield f"data: {json.dumps({'type': 'ai_message', 'content': final_content, 'timestamp': None})}\n\n"
        yield f"data: {json.dumps({'type': 'complete', 'active_document_id': active_document_id})}\n\n"

    except (asyncio.CancelledError, GeneratorExit):
        # Client disconnected (nav away / tab close) - the socket is already
        # gone, don't try to emit an error event over it.
        raise
    except Exception as e:
        from open_notebook.utils.error_classifier import classify_error

        _, error_message = classify_error(e)
        logger.error(
            f"Error in research session streaming: {str(e)}\n"
            f"  Session ID: {session_id}\n"
            f"  Traceback:\n{traceback.format_exc()}"
        )
        yield f"data: {json.dumps({'type': 'error', 'message': error_message})}\n\n"


@router.post("/research-sessions/{session_id}/stream")
async def stream_research_session(session_id: str, request: StreamResearchSessionRequest):
    """Send a message to a research session with SSE streaming (status +
    token-level events)."""
    try:
        full_session_id, session = await get_research_session_or_404(session_id)
        notebook_ids = await session.get_notebook_ids()

        model_override = (
            request.model_override
            if request.model_override is not None
            else session.model_override
        )

        return StreamingResponse(
            stream_research_session_response(
                session_id=full_session_id,
                session=session,
                message=request.message,
                mode=request.mode,
                language=request.language,
                model_override=model_override,
                notebook_ids=notebook_ids,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error starting research session stream: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error starting research session stream: {str(e)}"
        )


@router.get(
    "/research-sessions/{session_id}/documents",
    response_model=List[GeneratedDocumentResponse],
)
async def list_session_documents(session_id: str):
    """List generated documents produced by a research session."""
    try:
        full_session_id, _session = await get_research_session_or_404(session_id)
        rows = await repo_query(
            "SELECT * FROM generated_document WHERE source_session = $session_id "
            "ORDER BY updated DESC",
            {"session_id": ensure_record_id(full_session_id)},
        )
        documents = [GeneratedDocument(**row) for row in rows] if rows else []
        return [await _document_to_response(doc) for doc in documents]
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Research session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error listing session documents: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error listing session documents: {str(e)}"
        )


@router.get(
    "/generated-documents/{document_id}", response_model=GeneratedDocumentResponse
)
async def get_generated_document(document_id: str):
    """Get a single generated document."""
    try:
        full_document_id = normalize_record_id("generated_document", document_id)
        document = await GeneratedDocument.get(full_document_id)
        if not document:
            raise HTTPException(status_code=404, detail="Document not found")
        return await _document_to_response(document)
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching generated document: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching generated document: {str(e)}"
        )
