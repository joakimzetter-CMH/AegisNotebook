from typing import List

from fastapi import APIRouter, HTTPException
from loguru import logger

from api.models import (
    SkillCreate,
    SkillKnowledgeAttachResponse,
    SkillKnowledgeCreate,
    SkillResponse,
    SkillUpdate,
)
from open_notebook.domain.skill import Skill
from open_notebook.exceptions import InvalidInputError, OpenNotebookError

router = APIRouter()


async def _skill_response(skill: Skill) -> SkillResponse:
    return SkillResponse(
        id=skill.id or "",
        name=skill.name,
        title=skill.title,
        description=skill.description,
        instructions=skill.instructions,
        enabled=skill.enabled,
        knowledge_chunk_count=await skill.get_knowledge_chunks(),
        created=str(skill.created),
        updated=str(skill.updated),
    )


@router.get("/skills", response_model=List[SkillResponse])
async def get_skills():
    """Get all skills."""
    try:
        skills = await Skill.get_all(order_by="name asc")
        return [await _skill_response(skill) for skill in skills]
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching skills: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error fetching skills: {str(e)}")


@router.post("/skills", response_model=SkillResponse)
async def create_skill(skill_data: SkillCreate):
    """Create a new skill."""
    try:
        new_skill = Skill(
            name=skill_data.name,
            title=skill_data.title,
            description=skill_data.description,
            instructions=skill_data.instructions,
            enabled=skill_data.enabled,
        )
        await new_skill.save()

        return await _skill_response(new_skill)
    except HTTPException:
        raise
    except InvalidInputError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error creating skill: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error creating skill: {str(e)}")


@router.get("/skills/{skill_id}", response_model=SkillResponse)
async def get_skill(skill_id: str):
    """Get a specific skill by ID."""
    try:
        skill = await Skill.get(skill_id)
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        return await _skill_response(skill)
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching skill {skill_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error fetching skill: {str(e)}")


@router.put("/skills/{skill_id}", response_model=SkillResponse)
async def update_skill(skill_id: str, skill_update: SkillUpdate):
    """Update a skill."""
    try:
        skill = await Skill.get(skill_id)
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        if skill_update.name is not None:
            skill.name = skill_update.name
        if skill_update.title is not None:
            skill.title = skill_update.title
        if skill_update.description is not None:
            skill.description = skill_update.description
        if skill_update.instructions is not None:
            skill.instructions = skill_update.instructions
        if skill_update.enabled is not None:
            skill.enabled = skill_update.enabled

        await skill.save()

        return await _skill_response(skill)
    except HTTPException:
        raise
    except InvalidInputError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating skill {skill_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error updating skill: {str(e)}")


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str):
    """Delete a skill and its embedded knowledge."""
    try:
        skill = await Skill.get(skill_id)
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        await skill.delete()

        return {"message": "Skill deleted successfully"}
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error deleting skill {skill_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error deleting skill: {str(e)}")


@router.post("/skills/{skill_id}/knowledge", response_model=SkillKnowledgeAttachResponse)
async def attach_skill_knowledge(skill_id: str, knowledge: SkillKnowledgeCreate):
    """Attach a chunk of knowledge text to a skill (chunked + embedded async)."""
    try:
        skill = await Skill.get(skill_id)
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        command_id = await skill.vectorize(knowledge.content, title=knowledge.title)

        return SkillKnowledgeAttachResponse(command_id=command_id)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error attaching knowledge to skill {skill_id}: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error attaching knowledge to skill: {str(e)}"
        )
