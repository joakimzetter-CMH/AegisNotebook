import asyncio
import json
import traceback
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from loguru import logger
from pydantic import BaseModel, Field

from api.routers._chat_shared import (
    ChatMessage,
    SuccessResponse,
    extract_chat_messages,
    get_session_or_404,
)
from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.domain.notebook import ChatSession, Notebook
from open_notebook.exceptions import (
    NotFoundError,
    OpenNotebookError,
)
from open_notebook.graphs.chat import get_graph as get_chat_graph
from open_notebook.utils import token_count
from open_notebook.utils.context_builder import build_notebook_context
from open_notebook.utils.text_utils import extract_text_content

router = APIRouter()


async def _get_chat_state_values(session_id: str) -> dict:
    """Fetch the current LangGraph state values for a chat session.

    Mirrors research_sessions.py's _get_session_state_values - the chat graph
    is async (AsyncSqliteSaver-backed), so this is a plain await, no thread
    wrapping needed.
    """
    graph = await get_chat_graph()
    state = await graph.aget_state(
        config=RunnableConfig(configurable={"thread_id": session_id})
    )
    return dict(state.values) if state and state.values else {}


# Request/Response models
class CreateSessionRequest(BaseModel):
    notebook_id: str = Field(..., description="Notebook ID to create session for")
    title: Optional[str] = Field(None, description="Optional session title")
    model_override: Optional[str] = Field(
        None, description="Optional model override for this session"
    )


class UpdateSessionRequest(BaseModel):
    title: Optional[str] = Field(None, description="New session title")
    model_override: Optional[str] = Field(
        None, description="Model override for this session"
    )


class ChatSessionResponse(BaseModel):
    id: str = Field(..., description="Session ID")
    title: str = Field(..., description="Session title")
    notebook_id: Optional[str] = Field(None, description="Notebook ID")
    created: str = Field(..., description="Creation timestamp")
    updated: str = Field(..., description="Last update timestamp")
    message_count: Optional[int] = Field(
        None, description="Number of messages in session"
    )
    model_override: Optional[str] = Field(
        None, description="Model override for this session"
    )


class ChatSessionWithMessagesResponse(ChatSessionResponse):
    messages: List[ChatMessage] = Field(
        default_factory=list, description="Session messages"
    )


class ExecuteChatRequest(BaseModel):
    session_id: str = Field(..., description="Chat session ID")
    message: str = Field(..., description="User message content")
    context: Dict[str, Any] = Field(
        ..., description="Chat context with sources and notes"
    )
    model_override: Optional[str] = Field(
        None, description="Optional model override for this message"
    )


class ExecuteChatResponse(BaseModel):
    session_id: str = Field(..., description="Session ID")
    messages: List[ChatMessage] = Field(..., description="Updated message list")


class StreamChatRequest(BaseModel):
    message: str = Field(..., description="User message content")
    context: Dict[str, Any] = Field(
        ..., description="Chat context with sources and notes"
    )
    model_override: Optional[str] = Field(
        None, description="Optional model override for this message"
    )


class BuildContextRequest(BaseModel):
    notebook_id: str = Field(..., description="Notebook ID")
    context_config: Dict[str, Any] = Field(..., description="Context configuration")


class BuildContextResponse(BaseModel):
    context: Dict[str, Any] = Field(..., description="Built context data")
    token_count: int = Field(..., description="Estimated token count")
    char_count: int = Field(..., description="Character count")


@router.get("/chat/sessions", response_model=List[ChatSessionResponse])
async def get_sessions(notebook_id: str = Query(..., description="Notebook ID")):
    """Get all chat sessions for a notebook."""
    try:
        # Get notebook to verify it exists
        notebook = await Notebook.get(notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found")

        # Get sessions for this notebook
        sessions_list = await notebook.get_chat_sessions()

        results = []
        for session in sessions_list:
            session_id = str(session.id)

            # Get message count from LangGraph state
            state_values = await _get_chat_state_values(session_id)
            msg_count = len(state_values.get("messages", []))

            results.append(
                ChatSessionResponse(
                    id=session.id or "",
                    title=session.title or "Untitled Session",
                    notebook_id=notebook_id,
                    created=str(session.created),
                    updated=str(session.updated),
                    message_count=msg_count,
                    model_override=getattr(session, "model_override", None),
                )
            )

        return results
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching chat sessions: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching chat sessions: {str(e)}"
        )


@router.post("/chat/sessions", response_model=ChatSessionResponse)
async def create_session(request: CreateSessionRequest):
    """Create a new chat session."""
    try:
        # Verify notebook exists
        notebook = await Notebook.get(request.notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found")

        # Create new session
        session = ChatSession(
            title=request.title
            or f"Chat Session {asyncio.get_event_loop().time():.0f}",
            model_override=request.model_override,
        )
        await session.save()

        # Relate session to notebook
        await session.relate_to_notebook(request.notebook_id)

        return ChatSessionResponse(
            id=session.id or "",
            title=session.title or "",
            notebook_id=request.notebook_id,
            created=str(session.created),
            updated=str(session.updated),
            message_count=0,
            model_override=session.model_override,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error creating chat session: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error creating chat session: {str(e)}"
        )


@router.get(
    "/chat/sessions/{session_id}", response_model=ChatSessionWithMessagesResponse
)
async def get_session(session_id: str):
    """Get a specific session with its messages."""
    try:
        # Get session (normalizes the ID and 404s if missing)
        full_session_id, session = await get_session_or_404(session_id)

        # Get session state from LangGraph to retrieve messages
        state_values = await _get_chat_state_values(full_session_id)
        messages: list[ChatMessage] = extract_chat_messages(
            state_values.get("messages", [])
        )

        # Find notebook_id (we need to query the relationship)
        notebook_query = await repo_query(
            "SELECT out FROM refers_to WHERE in = $session_id",
            {"session_id": ensure_record_id(full_session_id)},
        )

        notebook_id = notebook_query[0]["out"] if notebook_query else None

        if not notebook_id:
            # This might be an old session created before API migration
            logger.warning(
                f"No notebook relationship found for session {session_id} - may be an orphaned session"
            )

        return ChatSessionWithMessagesResponse(
            id=session.id or "",
            title=session.title or "Untitled Session",
            notebook_id=notebook_id,
            created=str(session.created),
            updated=str(session.updated),
            message_count=len(messages),
            messages=messages,
            model_override=getattr(session, "model_override", None),
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching session: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error fetching session: {str(e)}")


@router.put("/chat/sessions/{session_id}", response_model=ChatSessionResponse)
async def update_session(session_id: str, request: UpdateSessionRequest):
    """Update session title."""
    try:
        # Get session (normalizes the ID and 404s if missing)
        full_session_id, session = await get_session_or_404(session_id)

        update_data = request.model_dump(exclude_unset=True)

        if "title" in update_data:
            session.title = update_data["title"]

        if "model_override" in update_data:
            session.model_override = update_data["model_override"]

        await session.save()

        # Find notebook_id
        notebook_query = await repo_query(
            "SELECT out FROM refers_to WHERE in = $session_id",
            {"session_id": ensure_record_id(full_session_id)},
        )
        notebook_id = notebook_query[0]["out"] if notebook_query else None

        # Get message count from LangGraph state
        state_values = await _get_chat_state_values(full_session_id)
        msg_count = len(state_values.get("messages", []))

        return ChatSessionResponse(
            id=session.id or "",
            title=session.title or "",
            notebook_id=notebook_id,
            created=str(session.created),
            updated=str(session.updated),
            message_count=msg_count,
            model_override=session.model_override,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating session: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error updating session: {str(e)}")


@router.delete("/chat/sessions/{session_id}", response_model=SuccessResponse)
async def delete_session(session_id: str):
    """Delete a chat session."""
    try:
        # Get session (normalizes the ID and 404s if missing)
        _full_session_id, session = await get_session_or_404(session_id)

        await session.delete()

        return SuccessResponse(success=True, message="Session deleted successfully")
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error deleting session: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error deleting session: {str(e)}")


@router.post("/chat/execute", response_model=ExecuteChatResponse)
async def execute_chat(request: ExecuteChatRequest):
    """Execute a chat request and get AI response."""
    try:
        # Verify session exists (normalizes the ID and 404s if missing)
        full_session_id, session = await get_session_or_404(request.session_id)

        # Fetch notebook linked to this session
        notebook_query = await repo_query(
            "SELECT out FROM refers_to WHERE in = $session_id",
            {"session_id": ensure_record_id(full_session_id)},
        )
        notebook = None
        if notebook_query:
            notebook = await Notebook.get(notebook_query[0]["out"])

        # Determine model override (per-request override takes precedence over session-level)
        model_override = (
            request.model_override
            if request.model_override is not None
            else getattr(session, "model_override", None)
        )

        # Get current state and execute the graph
        graph = await get_chat_graph()
        state_values = await _get_chat_state_values(full_session_id)
        state_values["messages"] = state_values.get("messages", [])
        state_values["context"] = request.context
        state_values["notebook"] = notebook
        state_values["model_override"] = model_override
        state_values["messages"].append(HumanMessage(content=request.message))

        result = await graph.ainvoke(
            input=state_values,  # type: ignore[arg-type]
            config=RunnableConfig(
                configurable={
                    "thread_id": full_session_id,
                    "model_id": model_override,
                }
            ),
        )

        # Update session timestamp
        await session.save()

        # Convert messages to response format
        messages = extract_chat_messages(result.get("messages", []))

        return ExecuteChatResponse(session_id=request.session_id, messages=messages)
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        # Log detailed error with context for debugging
        logger.error(
            f"Error executing chat: {str(e)}\n"
            f"  Session ID: {request.session_id}\n"
            f"  Model override: {request.model_override}\n"
            f"  Traceback:\n{traceback.format_exc()}"
        )
        raise HTTPException(status_code=500, detail=f"Error executing chat: {str(e)}")


async def stream_chat_response(
    session_id: str,
    notebook: Optional[Notebook],
    message: str,
    context: Dict[str, Any],
    model_override: Optional[str],
) -> AsyncGenerator[str, None]:
    """Stream notebook chat as Server-Sent Events.

    Emits: user_message -> N x token_delta -> ai_message -> complete
    (or an error event in place of the rest if something fails).
    """
    try:
        graph = await get_chat_graph()
        state_values = await _get_chat_state_values(session_id)
        state_values["messages"] = state_values.get("messages", [])
        state_values["context"] = context
        state_values["notebook"] = notebook
        state_values["model_override"] = model_override
        state_values["messages"].append(HumanMessage(content=message))

        yield f"data: {json.dumps({'type': 'user_message', 'content': message, 'timestamp': None})}\n\n"

        config = RunnableConfig(
            configurable={"thread_id": session_id, "model_id": model_override}
        )
        async for chunk_msg, _metadata in graph.astream(
            input=state_values,  # type: ignore[arg-type]
            config=config,
            stream_mode="messages",
        ):
            delta = getattr(chunk_msg, "content", "") or ""
            if not isinstance(delta, str):
                delta = extract_text_content(delta)
            if delta:
                yield f"data: {json.dumps({'type': 'token_delta', 'content': delta})}\n\n"

        # Re-fetch the persisted, cleaned final message rather than
        # re-deriving it from the accumulated deltas here - guarantees this
        # event is identical to what GET /chat/sessions/{id} returns later.
        final_state = await graph.aget_state(config)
        final_messages = (
            (final_state.values or {}).get("messages", []) if final_state else []
        )
        final_content = final_messages[-1].content if final_messages else ""

        yield f"data: {json.dumps({'type': 'ai_message', 'content': final_content, 'timestamp': None})}\n\n"
        yield f"data: {json.dumps({'type': 'complete'})}\n\n"

    except (asyncio.CancelledError, GeneratorExit):
        # Client disconnected (nav away / tab close) - the socket is already
        # gone, don't try to emit an error event over it.
        raise
    except Exception as e:
        from open_notebook.utils.error_classifier import classify_error

        _, error_message = classify_error(e)
        logger.error(f"Error in notebook chat streaming: {str(e)}")
        yield f"data: {json.dumps({'type': 'error', 'message': error_message})}\n\n"


@router.post("/chat/sessions/{session_id}/stream")
async def stream_chat(session_id: str, request: StreamChatRequest):
    """Send a message to a notebook chat session with token-level SSE streaming."""
    try:
        full_session_id, session = await get_session_or_404(session_id)

        notebook_query = await repo_query(
            "SELECT out FROM refers_to WHERE in = $session_id",
            {"session_id": ensure_record_id(full_session_id)},
        )
        notebook = None
        if notebook_query:
            notebook = await Notebook.get(notebook_query[0]["out"])

        model_override = (
            request.model_override
            if request.model_override is not None
            else getattr(session, "model_override", None)
        )

        # Update session timestamp
        await session.save()

        return StreamingResponse(
            stream_chat_response(
                session_id=full_session_id,
                notebook=notebook,
                message=request.message,
                context=request.context,
                model_override=model_override,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error starting chat stream: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error starting chat stream: {str(e)}"
        )


@router.post("/chat/context", response_model=BuildContextResponse)
async def build_context(request: BuildContextRequest):
    """Build context for a notebook based on context configuration."""
    try:
        # Verify notebook exists
        notebook = await Notebook.get(request.notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found")

        context_data, total_content = await build_notebook_context(
            notebook, request.context_config
        )

        char_count = len(total_content)
        estimated_tokens = token_count(total_content) if total_content else 0

        return BuildContextResponse(
            context=context_data, token_count=estimated_tokens, char_count=char_count
        )
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error building context: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error building context: {str(e)}")
