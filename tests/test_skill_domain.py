"""Unit tests for the open_notebook.domain.skill module."""

from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from open_notebook.domain.skill import Skill


class TestSkillValidation:
    """Test suite for Skill field validation."""

    def test_skill_requires_core_fields(self):
        with pytest.raises(ValidationError):
            Skill()  # type: ignore[call-arg]

    def test_skill_enabled_defaults_true(self):
        skill = Skill(
            name="swedish-tax",
            title="Swedish Tax Rules",
            description="Knows Swedish tax law",
            instructions="Answer using current Swedish tax regulations.",
        )
        assert skill.enabled is True

    def test_skill_enabled_can_be_disabled(self):
        skill = Skill(
            name="swedish-tax",
            title="Swedish Tax Rules",
            description="Knows Swedish tax law",
            instructions="Answer using current Swedish tax regulations.",
            enabled=False,
        )
        assert skill.enabled is False


class TestSkillVectorize:
    """Test suite for Skill.vectorize()."""

    @pytest.mark.asyncio
    async def test_vectorize_raises_valueerror_when_no_content(self):
        skill = Skill(
            id="skill:test_empty",
            name="s",
            title="S",
            description="d",
            instructions="i",
        )
        with pytest.raises(ValueError, match="has no content to vectorize"):
            await skill.vectorize("")

    @pytest.mark.asyncio
    async def test_vectorize_raises_valueerror_when_whitespace_only(self):
        skill = Skill(
            id="skill:test_ws",
            name="s",
            title="S",
            description="d",
            instructions="i",
        )
        with pytest.raises(ValueError, match="has no content to vectorize"):
            await skill.vectorize("   \n\t  ")

    @pytest.mark.asyncio
    async def test_vectorize_submits_command_with_valid_content(self):
        skill = Skill(
            id="skill:test_valid",
            name="s",
            title="S",
            description="d",
            instructions="i",
        )
        with patch(
            "open_notebook.domain.skill.submit_command", return_value="command:123"
        ) as mock_submit:
            result = await skill.vectorize("Real content", title="notes.md")
            mock_submit.assert_called_once_with(
                "open_notebook",
                "embed_skill_knowledge",
                {
                    "skill_id": "skill:test_valid",
                    "content": "Real content",
                    "title": "notes.md",
                },
            )
            assert result == "command:123"


class TestSkillKnowledgeChunks:
    """Test suite for Skill.get_knowledge_chunks()."""

    @pytest.mark.asyncio
    async def test_get_knowledge_chunks_returns_count(self):
        skill = Skill(
            id="skill:test_count",
            name="s",
            title="S",
            description="d",
            instructions="i",
        )
        with patch(
            "open_notebook.domain.skill.repo_query",
            new=AsyncMock(return_value=[{"chunks": 4}]),
        ):
            assert await skill.get_knowledge_chunks() == 4

    @pytest.mark.asyncio
    async def test_get_knowledge_chunks_returns_zero_when_empty(self):
        skill = Skill(
            id="skill:test_zero",
            name="s",
            title="S",
            description="d",
            instructions="i",
        )
        with patch(
            "open_notebook.domain.skill.repo_query", new=AsyncMock(return_value=[])
        ):
            assert await skill.get_knowledge_chunks() == 0
