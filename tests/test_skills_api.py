from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create test client after environment variables have been cleared by conftest."""
    from api.main import app

    return TestClient(app)


def _mock_skill(**overrides):
    skill = AsyncMock()
    skill.id = "skill:abc123"
    skill.name = "swedish-tax"
    skill.title = "Swedish Tax Rules"
    skill.description = "Knows Swedish tax law"
    skill.instructions = "Answer using current Swedish tax regulations."
    skill.enabled = True
    skill.created = "2026-01-01T00:00:00Z"
    skill.updated = "2026-01-01T00:00:00Z"
    skill.get_knowledge_chunks = AsyncMock(return_value=0)
    for key, value in overrides.items():
        setattr(skill, key, value)
    return skill


class TestSkillCreation:
    @patch("api.routers.skills.Skill")
    def test_create_skill_returns_response(self, mock_skill_cls, client):
        mock_skill = _mock_skill()
        mock_skill.save = AsyncMock()
        mock_skill_cls.return_value = mock_skill

        response = client.post(
            "/api/skills",
            json={
                "name": "swedish-tax",
                "title": "Swedish Tax Rules",
                "description": "Knows Swedish tax law",
                "instructions": "Answer using current Swedish tax regulations.",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "skill:abc123"
        assert data["enabled"] is True
        assert data["knowledge_chunk_count"] == 0


class TestSkillList:
    @patch("api.routers.skills.Skill")
    def test_get_skills_returns_list(self, mock_skill_cls, client):
        mock_skill_cls.get_all = AsyncMock(return_value=[_mock_skill()])

        response = client.get("/api/skills")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["name"] == "swedish-tax"


class TestSkillGet:
    @patch("api.routers.skills.Skill")
    def test_get_skill_not_found(self, mock_skill_cls, client):
        mock_skill_cls.get = AsyncMock(side_effect=Exception("not found"))

        response = client.get("/api/skills/skill:missing")

        assert response.status_code == 500


class TestSkillUpdate:
    @patch("api.routers.skills.Skill")
    def test_update_skill_partial_fields(self, mock_skill_cls, client):
        mock_skill = _mock_skill()
        mock_skill.save = AsyncMock()
        mock_skill_cls.get = AsyncMock(return_value=mock_skill)

        response = client.put(
            "/api/skills/skill:abc123",
            json={"enabled": False},
        )

        assert response.status_code == 200
        assert mock_skill.enabled is False


class TestSkillDelete:
    @patch("api.routers.skills.Skill")
    def test_delete_skill(self, mock_skill_cls, client):
        mock_skill = _mock_skill()
        mock_skill.delete = AsyncMock()
        mock_skill_cls.get = AsyncMock(return_value=mock_skill)

        response = client.delete("/api/skills/skill:abc123")

        assert response.status_code == 200
        mock_skill.delete.assert_called_once()


class TestSkillKnowledgeAttach:
    @patch("api.routers.skills.Skill")
    def test_attach_knowledge_returns_command_id(self, mock_skill_cls, client):
        mock_skill = _mock_skill()
        mock_skill.vectorize = AsyncMock(return_value="command:embed456")
        mock_skill_cls.get = AsyncMock(return_value=mock_skill)

        response = client.post(
            "/api/skills/skill:abc123/knowledge",
            json={"content": "Some knowledge text", "title": "notes.md"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["command_id"] == "command:embed456"
        mock_skill.vectorize.assert_called_once_with(
            "Some knowledge text", title="notes.md"
        )

    @patch("api.routers.skills.Skill")
    def test_attach_knowledge_empty_content_returns_400(self, mock_skill_cls, client):
        mock_skill = _mock_skill()
        mock_skill.vectorize = AsyncMock(
            side_effect=ValueError("Skill skill:abc123 has no content to vectorize")
        )
        mock_skill_cls.get = AsyncMock(return_value=mock_skill)

        response = client.post(
            "/api/skills/skill:abc123/knowledge",
            json={"content": ""},
        )

        assert response.status_code == 400
