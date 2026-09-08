from typing import Any, ClassVar, Dict, List, Optional

from loguru import logger
from surreal_commands import submit_command

from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.domain.base import ObjectModel
from open_notebook.exceptions import DatabaseOperationError, InvalidInputError


class Skill(ObjectModel):
    """A reusable, cross-notebook capability: operating instructions plus a
    small embedded knowledge base (SkillKnowledge), retrievable by relevance
    from any notebook's chat via skill_search() - unlike Source, which is
    embedded and searched only within the notebook(s) it belongs to.
    """

    table_name: ClassVar[str] = "skill"
    name: str
    title: str
    description: str
    instructions: str
    enabled: bool = True

    async def vectorize(self, content: str, title: Optional[str] = None) -> str:
        """
        Submit knowledge embedding as a background job (embed_skill_knowledge),
        mirroring Source.vectorize(). Fire-and-forget: chunks the content,
        embeds each chunk, and bulk-inserts skill_knowledge rows.

        Returns:
            str: The command/job ID that can be used to track progress.

        Raises:
            ValueError: If there is no content to vectorize.
        """
        if not content or not content.strip():
            raise ValueError(f"Skill {self.id} has no content to vectorize")

        logger.info(f"Submitting embed_skill_knowledge job for skill {self.id}")
        try:
            command_id = submit_command(
                "open_notebook",
                "embed_skill_knowledge",
                {"skill_id": str(self.id), "content": content, "title": title},
            )
            command_id_str = str(command_id)
            logger.info(
                f"Embed skill knowledge job submitted for skill {self.id}: "
                f"command_id={command_id_str}"
            )
            return command_id_str
        except Exception as e:
            logger.error(
                f"Failed to submit embed_skill_knowledge job for skill {self.id}: {e}"
            )
            raise DatabaseOperationError(e)

    async def get_knowledge_chunks(self) -> int:
        """Count of skill_knowledge rows currently stored for this skill."""
        if self.id is None:
            raise InvalidInputError("Cannot count knowledge chunks without an ID")
        try:
            result = await repo_query(
                "select count() as chunks from skill_knowledge where skill=$id GROUP ALL",
                {"id": ensure_record_id(self.id)},
            )
            if len(result) == 0:
                return 0
            return result[0]["chunks"]
        except Exception as e:
            logger.error(f"Error counting knowledge chunks for skill {self.id}: {e}")
            logger.exception(e)
            raise DatabaseOperationError(e)

    async def delete(self) -> bool:
        if self.id is None:
            raise InvalidInputError("Cannot delete object without an ID")
        try:
            await repo_query(
                "DELETE skill_knowledge WHERE skill = $skill_id",
                {"skill_id": ensure_record_id(self.id)},
            )
        except Exception as e:
            logger.warning(
                f"Failed to delete skill_knowledge rows for skill {self.id}: {e}. "
                "Continuing with skill deletion."
            )
        return await super().delete()


class SkillKnowledge(ObjectModel):
    table_name: ClassVar[str] = "skill_knowledge"
    content: str


async def skill_search(
    query: str, match_count: int = 3, min_similarity: float = 0.65
) -> List[Dict[str, Any]]:
    """
    Semantic search over all enabled skills' knowledge, always global
    (no notebook scoping) - mirrors vector_search()/text_search() in
    open_notebook/domain/notebook.py.
    """
    if not query:
        raise InvalidInputError("Search query cannot be empty")
    try:
        from open_notebook.utils.embedding import generate_embedding

        embed = await generate_embedding(query)
        return await repo_query(
            """
            SELECT * FROM fn::skill_search($embed, $match_count, $min_similarity);
            """,
            {
                "embed": embed,
                "match_count": match_count,
                "min_similarity": min_similarity,
            },
        )
    except Exception as e:
        logger.error(f"Error performing skill search: {str(e)}")
        logger.exception(e)
        raise DatabaseOperationError(e)
