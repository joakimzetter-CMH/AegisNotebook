"""Characterization tests for the chat and source-chat routers.

These pin down the behaviors shared (via copy-paste) between
`api/routers/chat.py` and `api/routers/source_chat.py` before/after extracting
them into `api/routers/_chat_shared.py`:

- record-ID normalization (bare id vs already-prefixed id)
- session/source verification (missing record -> 404, missing `refers_to`
  relation -> 404 on every method now that the routers re-raise HTTPException
  instead of swallowing it into a 500)
- LangGraph state -> `ChatMessage` extraction shapes (type/content fallbacks)

DB access and LangGraph state are mocked following the style of
tests/test_crud_404.py.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from open_notebook.exceptions import NotFoundError


@pytest.fixture
def client():
    from api.main import app

    return TestClient(app)


def _nf(*_args, **_kwargs):
    raise NotFoundError("not found")


def _session(**overrides):
    """A ChatSession-like object with the attributes the routers read."""
    defaults = dict(
        id="chat_session:abc",
        title="My Session",
        created="2026-01-01T00:00:00",
        updated="2026-01-02T00:00:00",
        model_override=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _source(**overrides):
    defaults = dict(id="source:xyz", title="My Source")
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _graph_state(values):
    state = MagicMock()
    state.values = values
    return state


def _async_graph(state_values):
    """A get_chat_graph()-shaped mock: chat.py's graph is async now
    (AsyncSqliteSaver-backed), so .aget_state is an AsyncMock, not a plain
    sync .get_state like the old SqliteSaver-backed graph had."""
    graph = MagicMock()
    graph.aget_state = AsyncMock(return_value=_graph_state(state_values))
    return graph


class _Msg:
    """A LangChain-like message with id/type/content."""

    def __init__(self, id, type, content):
        self.id = id
        self.type = type
        self.content = content


class _Bare:
    """An object with no type/content attributes (exercises the fallbacks)."""

    def __str__(self):
        return "bare-repr"


# --- chat.py: ID normalization ------------------------------------------------


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.ChatSession.get", new_callable=AsyncMock)
async def test_get_chat_session_bare_id_gets_prefixed(
    mock_get, mock_get_chat_graph, mock_repo, client
):
    mock_get.return_value = _session()
    mock_get_chat_graph.return_value = _async_graph({"messages": []})
    mock_repo.return_value = [{"out": "notebook:1"}]

    resp = client.get("/api/chat/sessions/abc")

    assert resp.status_code == 200
    mock_get.assert_awaited_once_with("chat_session:abc")


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.ChatSession.get", new_callable=AsyncMock)
async def test_get_chat_session_prefixed_id_kept_as_is(
    mock_get, mock_get_chat_graph, mock_repo, client
):
    mock_get.return_value = _session()
    mock_get_chat_graph.return_value = _async_graph({"messages": []})
    mock_repo.return_value = [{"out": "notebook:1"}]

    resp = client.get("/api/chat/sessions/chat_session:abc")

    assert resp.status_code == 200
    mock_get.assert_awaited_once_with("chat_session:abc")


@pytest.mark.asyncio
@patch("api.routers.chat.ChatSession.get", new_callable=AsyncMock)
async def test_delete_chat_session_missing_returns_404(mock_get, client):
    mock_get.side_effect = _nf
    resp = client.delete("/api/chat/sessions/gone")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found"
    mock_get.assert_awaited_once_with("chat_session:gone")


# --- chat.py: message extraction shape ----------------------------------------


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.ChatSession.get", new_callable=AsyncMock)
async def test_get_chat_session_message_shapes(
    mock_get, mock_get_chat_graph, mock_repo, client
):
    mock_get.return_value = _session()
    mock_get_chat_graph.return_value = _async_graph(
        {"messages": [_Msg("m1", "human", "hello"), _Msg("m2", "ai", "hi"), _Bare()]}
    )
    mock_repo.return_value = [{"out": "notebook:1"}]

    resp = client.get("/api/chat/sessions/abc")

    assert resp.status_code == 200
    body = resp.json()
    assert body["message_count"] == 3
    assert body["messages"][0] == {
        "id": "m1",
        "type": "human",
        "content": "hello",
        "timestamp": None,
    }
    assert body["messages"][1]["type"] == "ai"
    # Object without type/content falls back to "unknown" / str(msg); the id
    # fallback is positional (msg_<index>).
    assert body["messages"][2] == {
        "id": "msg_2",
        "type": "unknown",
        "content": "bare-repr",
        "timestamp": None,
    }


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.ChatSession.get", new_callable=AsyncMock)
async def test_get_chat_session_no_state_yields_empty_messages(
    mock_get, mock_get_chat_graph, mock_repo, client
):
    mock_get.return_value = _session()
    mock_get_chat_graph.return_value = _async_graph(None)
    mock_repo.return_value = []

    resp = client.get("/api/chat/sessions/abc")

    assert resp.status_code == 200
    body = resp.json()
    assert body["messages"] == []
    assert body["message_count"] == 0
    assert body["notebook_id"] is None


# --- chat.py: streaming endpoint ------------------------------------------------


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.get_session_or_404", new_callable=AsyncMock)
async def test_stream_chat_emits_token_deltas_then_complete(
    mock_get_session, mock_get_chat_graph, mock_repo, client
):
    session = _session()
    session.save = AsyncMock()
    mock_get_session.return_value = ("chat_session:abc", session)
    mock_repo.return_value = []

    async def fake_astream(*_args, **_kwargs):
        from langchain_core.messages import AIMessageChunk

        for tok in ["Hel", "lo"]:
            yield AIMessageChunk(content=tok, id="run-1"), {}

    graph = MagicMock()
    # aget_state is called twice: once for the pre-stream state (empty
    # history) and once after streaming to read back the persisted result.
    # Distinct objects, since the router appends to the messages list in
    # place - a single shared mock would let that mutation leak between them.
    graph.aget_state = AsyncMock(
        side_effect=[
            _graph_state({"messages": []}),
            _graph_state(
                {"messages": [_Msg("m1", "human", "hi"), _Msg("run-1", "ai", "Hello")]}
            ),
        ]
    )
    graph.astream = fake_astream
    mock_get_chat_graph.return_value = graph

    resp = client.post(
        "/api/chat/sessions/abc/stream", json={"message": "hi", "context": {}}
    )

    assert resp.status_code == 200
    body = resp.text
    assert '"type": "user_message"' in body
    assert '"type": "token_delta"' in body
    assert '"content": "Hel"' in body
    assert '"content": "lo"' in body
    assert '"type": "ai_message"' in body and '"content": "Hello"' in body
    assert '"type": "complete"' in body


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.get_session_or_404", new_callable=AsyncMock)
async def test_stream_chat_emits_error_event_on_failure(
    mock_get_session, mock_get_chat_graph, mock_repo, client
):
    session = _session()
    session.save = AsyncMock()
    mock_get_session.return_value = ("chat_session:abc", session)
    mock_repo.return_value = []

    async def failing_astream(*_args, **_kwargs):
        raise RuntimeError("boom")
        yield  # pragma: no cover - unreachable, makes this a generator

    graph = MagicMock()
    graph.aget_state = AsyncMock(return_value=_graph_state({"messages": []}))
    graph.astream = failing_astream
    mock_get_chat_graph.return_value = graph

    resp = client.post(
        "/api/chat/sessions/abc/stream", json={"message": "hi", "context": {}}
    )

    assert resp.status_code == 200
    body = resp.text
    assert '"type": "user_message"' in body
    assert '"type": "error"' in body
    assert '"type": "complete"' not in body


# --- chat.py: execute_chat (non-streaming fallback) -----------------------------


@pytest.mark.asyncio
@patch("api.routers.chat.repo_query", new_callable=AsyncMock)
@patch("api.routers.chat.get_chat_graph", new_callable=AsyncMock)
@patch("api.routers.chat.get_session_or_404", new_callable=AsyncMock)
async def test_execute_chat_returns_ai_message(
    mock_get_session, mock_get_chat_graph, mock_repo, client
):
    session = _session()
    session.save = AsyncMock()
    mock_get_session.return_value = ("chat_session:abc", session)
    mock_repo.return_value = []

    graph = MagicMock()
    graph.aget_state = AsyncMock(return_value=_graph_state({"messages": []}))
    graph.ainvoke = AsyncMock(
        return_value={
            "messages": [_Msg("m1", "human", "hi"), _Msg("m2", "ai", "hello there")]
        }
    )
    mock_get_chat_graph.return_value = graph

    resp = client.post(
        "/api/chat/execute",
        json={"session_id": "abc", "message": "hi", "context": {}},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["session_id"] == "abc"
    assert body["messages"][-1] == {
        "id": "m2",
        "type": "ai",
        "content": "hello there",
        "timestamp": None,
    }
    graph.ainvoke.assert_awaited_once()


# --- source_chat.py: source verification --------------------------------------


@pytest.mark.asyncio
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_create_source_chat_session_missing_source_returns_404(mock_get, client):
    mock_get.side_effect = _nf
    resp = client.post(
        "/api/sources/gone/chat/sessions", json={"source_id": "gone"}
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Source not found"
    mock_get.assert_awaited_once_with("source:gone")


@pytest.mark.asyncio
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_list_source_chat_sessions_missing_source_returns_404(mock_get, client):
    mock_get.side_effect = _nf
    resp = client.get("/api/sources/source:gone/chat/sessions")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Source not found"
    mock_get.assert_awaited_once_with("source:gone")


# --- source_chat.py: session + relation verification ---------------------------


@pytest.mark.asyncio
@patch("api.routers._chat_shared.repo_query", new_callable=AsyncMock)
@patch("api.routers._chat_shared.ChatSession.get", new_callable=AsyncMock)
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_get_source_chat_session_missing_session_returns_404(
    mock_source_get, mock_session_get, mock_repo, client
):
    mock_source_get.return_value = _source()
    mock_session_get.side_effect = _nf

    resp = client.get("/api/sources/xyz/chat/sessions/gone")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Source or session not found"
    mock_source_get.assert_awaited_once_with("source:xyz")
    mock_session_get.assert_awaited_once_with("chat_session:gone")


@pytest.mark.asyncio
@patch("api.routers._chat_shared.repo_query", new_callable=AsyncMock)
@patch("api.routers._chat_shared.ChatSession.get", new_callable=AsyncMock)
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_get_source_chat_session_missing_relation_behavior(
    mock_source_get, mock_session_get, mock_repo, client
):
    """Session exists but is not related to the source.

    Intentional behavior change: the router now re-raises HTTPException before
    its broad `except Exception`, so the inner 404 surfaces as a real 404
    instead of being swallowed and re-raised as a 500 embedding the original
    404 message.
    """
    mock_source_get.return_value = _source()
    mock_session_get.return_value = _session()
    mock_repo.return_value = []  # no refers_to relation

    resp = client.get("/api/sources/xyz/chat/sessions/abc")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found for this source"


@pytest.mark.asyncio
@patch("api.routers._chat_shared.repo_query", new_callable=AsyncMock)
@patch("api.routers._chat_shared.ChatSession.get", new_callable=AsyncMock)
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_delete_source_chat_session_missing_relation_behavior(
    mock_source_get, mock_session_get, mock_repo, client
):
    # Intentional behavior change: the inner 404 is no longer swallowed into a
    # 500 by the broad `except Exception` (see the get test above).
    mock_source_get.return_value = _source()
    mock_session_get.return_value = _session()
    mock_repo.return_value = []

    resp = client.delete("/api/sources/xyz/chat/sessions/abc")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found for this source"


@pytest.mark.asyncio
@patch("api.routers._chat_shared.repo_query", new_callable=AsyncMock)
@patch("api.routers._chat_shared.ChatSession.get", new_callable=AsyncMock)
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_send_message_missing_relation_returns_404(
    mock_source_get, mock_session_get, mock_repo, client
):
    """send_message re-raises HTTPException before its broad handler, so the
    missing-relation case surfaces as a real 404 here (unlike get/put/delete)."""
    mock_source_get.return_value = _source()
    mock_session_get.return_value = _session()
    mock_repo.return_value = []

    resp = client.post(
        "/api/sources/xyz/chat/sessions/abc/messages", json={"message": "hi"}
    )

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found for this source"


@pytest.mark.asyncio
@patch("api.routers.source_chat.source_chat_graph")
@patch("api.routers._chat_shared.repo_query", new_callable=AsyncMock)
@patch("api.routers._chat_shared.ChatSession.get", new_callable=AsyncMock)
@patch("api.routers._chat_shared.Source.get", new_callable=AsyncMock)
async def test_get_source_chat_session_happy_path_shapes(
    mock_source_get, mock_session_get, mock_repo, mock_graph, client
):
    mock_source_get.return_value = _source()
    mock_session_get.return_value = _session()
    mock_repo.return_value = [{"in": "chat_session:abc", "out": "source:xyz"}]
    mock_graph.get_state.return_value = _graph_state(
        {
            "messages": [_Msg("m1", "human", "hello"), _Bare()],
            "context_indicators": {"sources": ["source:xyz"], "insights": []},
        }
    )

    resp = client.get("/api/sources/xyz/chat/sessions/abc")

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "chat_session:abc"
    assert body["source_id"] == "xyz"
    assert body["message_count"] == 2
    assert body["messages"][0] == {
        "id": "m1",
        "type": "human",
        "content": "hello",
        "timestamp": None,
    }
    assert body["messages"][1] == {
        "id": "msg_1",
        "type": "unknown",
        "content": "bare-repr",
        "timestamp": None,
    }
    assert body["context_indicators"] == {
        "sources": ["source:xyz"],
        "insights": [],
        "notes": [],
    }
