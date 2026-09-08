import time
from typing import Optional

from loguru import logger
from surreal_commands import CommandInput, CommandOutput, command

from open_notebook.database.repository import ensure_record_id, repo_insert, repo_query
from open_notebook.utils.chunking import chunk_text, detect_content_type
from open_notebook.utils.embedding import generate_embeddings

from .embedding_commands import EMBED_RETRY_CONFIG, get_command_id


class EmbedSkillKnowledgeInput(CommandInput):
    """Input for embedding a skill's knowledge text (creates multiple chunk
    embeddings, mirroring EmbedSourceInput / embed_source_command)."""

    skill_id: str
    content: str
    title: Optional[str] = None


class EmbedSkillKnowledgeOutput(CommandOutput):
    """Output from skill knowledge embedding command."""

    success: bool
    skill_id: str
    chunks_created: int
    processing_time: float
    error_message: Optional[str] = None


@command("embed_skill_knowledge", app="open_notebook", retry=EMBED_RETRY_CONFIG)
async def embed_skill_knowledge_command(
    input_data: EmbedSkillKnowledgeInput,
) -> EmbedSkillKnowledgeOutput:
    """
    Generate and store embeddings for a chunk of skill knowledge.

    Creates multiple chunk embeddings stored in the skill_knowledge table.
    Mirrors embed_source_command: content-type aware chunking, batch
    embedding, bulk insert. Existing chunks with this same title are
    replaced first, so re-submitting the same attachment is idempotent.

    Retry Strategy:
    - Retries up to 5 times for transient failures (network, timeout, etc.)
    - Uses exponential-jitter backoff (1-60s)
    - Does NOT retry permanent failures (ValueError for validation errors)
    """
    start_time = time.time()

    try:
        logger.info(f"Starting knowledge embedding for skill: {input_data.skill_id}")

        if not input_data.content or not input_data.content.strip():
            raise ValueError(f"Skill '{input_data.skill_id}' has no text to embed")

        skill_id = ensure_record_id(input_data.skill_id)

        # Idempotency: replace any existing chunks under the same title before
        # re-inserting, same delete-then-reinsert pattern as embed_source_command.
        await repo_query(
            "DELETE skill_knowledge WHERE skill = $skill_id AND title = $title",
            {"skill_id": skill_id, "title": input_data.title},
        )

        content_type = detect_content_type(input_data.content)
        chunks = chunk_text(input_data.content, content_type=content_type)
        total_chunks = len(chunks)

        if total_chunks == 0:
            raise ValueError("No chunks created after splitting text")

        cmd_id = get_command_id(input_data)
        embeddings = await generate_embeddings(chunks, command_id=cmd_id)

        if len(embeddings) != len(chunks):
            raise ValueError(
                f"Embedding count mismatch: got {len(embeddings)} embeddings "
                f"for {len(chunks)} chunks"
            )

        records = [
            {
                "skill": skill_id,
                "title": input_data.title,
                "order": idx,
                "content": chunk,
                "embedding": embedding,
            }
            for idx, (chunk, embedding) in enumerate(zip(chunks, embeddings))
        ]

        await repo_insert("skill_knowledge", records)

        processing_time = time.time() - start_time
        logger.info(
            f"Successfully embedded knowledge for skill {input_data.skill_id}: "
            f"{total_chunks} chunks in {processing_time:.2f}s"
        )

        return EmbedSkillKnowledgeOutput(
            success=True,
            skill_id=input_data.skill_id,
            chunks_created=total_chunks,
            processing_time=processing_time,
        )

    except ValueError as e:
        processing_time = time.time() - start_time
        cmd_id = get_command_id(input_data)
        logger.error(
            f"Failed to embed knowledge for skill {input_data.skill_id} "
            f"(command: {cmd_id}): {e}"
        )
        return EmbedSkillKnowledgeOutput(
            success=False,
            skill_id=input_data.skill_id,
            chunks_created=0,
            processing_time=processing_time,
            error_message=str(e),
        )
    except Exception as e:
        cmd_id = get_command_id(input_data)
        logger.debug(
            f"Transient error embedding knowledge for skill "
            f"{input_data.skill_id} (command: {cmd_id}): {e}"
        )
        raise
