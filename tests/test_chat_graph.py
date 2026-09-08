"""Tests for the async notebook chat graph (open_notebook/graphs/chat.py).

Covers the AsyncSqliteSaver migration: the graph must compile lazily, stream
token-level chunks via stream_mode="messages", and persist a real AIMessage
(type == "ai", not the AIMessageChunk's own "AIMessageChunk" type) at the end.
"""

from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

import open_notebook.graphs.chat as chat_module


@pytest.fixture(autouse=True)
def _reset_chat_graph_singleton(tmp_path, monkeypatch):
    """Each test gets its own checkpoint file and a fresh compiled graph -
    the module-level singleton must not leak between tests."""
    monkeypatch.setattr(chat_module, "_compiled_graph", None)
    monkeypatch.setattr(
        chat_module, "LANGGRAPH_CHECKPOINT_FILE", str(tmp_path / "checkpoints.sqlite")
    )
    yield
    chat_module._compiled_graph = None


def _fake_model(reply: str) -> GenericFakeChatModel:
    return GenericFakeChatModel(messages=iter([AIMessage(content=reply)]))


@pytest.mark.asyncio
async def test_stream_mode_messages_yields_token_chunks_and_persists_ai_message():
    with patch.object(
        chat_module,
        "provision_langchain_model",
        new=AsyncMock(return_value=_fake_model("Hello there, world!")),
    ):
        graph = await chat_module.get_graph()
        config = RunnableConfig(configurable={"thread_id": "thread-1"})
        state_values = {
            "messages": [HumanMessage(content="hi")],
            "notebook": None,
            "context": None,
            "context_config": None,
            "model_override": None,
        }

        chunks = [
            item
            async for item in graph.astream(
                input=state_values, config=config, stream_mode="messages"
            )
        ]

        # Multiple token-level chunks, not one big blob.
        assert len(chunks) > 1
        for msg, metadata in chunks:
            assert isinstance(metadata, dict)
            assert hasattr(msg, "content")

        final_state = await graph.aget_state(config)
        final_messages = final_state.values["messages"]
        ai_messages = [m for m in final_messages if m.type == "ai"]
        assert len(ai_messages) == 1
        assert ai_messages[0].content == "Hello there, world!"
        # Regression guard: must be a real AIMessage, not an unmerged chunk.
        assert type(ai_messages[0]).__name__ == "AIMessage"


@pytest.mark.asyncio
async def test_get_graph_returns_same_instance_across_calls():
    with patch.object(
        chat_module, "provision_langchain_model", new=AsyncMock(return_value=_fake_model("hi"))
    ):
        graph_a = await chat_module.get_graph()
        graph_b = await chat_module.get_graph()
        assert graph_a is graph_b
