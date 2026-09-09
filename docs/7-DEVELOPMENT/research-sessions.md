# Research Sessions — Developer Guide

Research sessions are the AegisNotebook extension for cross-notebook
conversation and document generation.

## Components

| Layer | Implementation |
|---|---|
| Domain | `ResearchSession` and `GeneratedDocument` in `open_notebook/domain/notebook.py` |
| API | `api/routers/research_sessions.py` |
| Session graph | `open_notebook/graphs/session.py` |
| Ask graph | `open_notebook/graphs/ask.py` |
| Document graph | `open_notebook/graphs/generate_document.py` |
| Frontend page | `frontend/src/app/(dashboard)/sessions/[id]/page.tsx` |
| Frontend streaming | `frontend/src/lib/hooks/use-research-session-stream.ts` |
| Schema | Migrations 25–29 in `open_notebook/database/migrations/` |

## Execution flow

1. The API loads the session and resolves its `scopes` relationships to
   notebook IDs.
2. The session graph restores the conversation from its async SQLite
   checkpoint.
3. `ask` mode invokes the Ask graph with the notebook IDs. Vector retrieval is
   filtered through the notebook relationships.
4. `generate` mode invokes the document graph. It retrieves context, streams a
   complete draft from the configured model, then persists a new document or a
   new version of the active document.
5. The generated document is linked to every contributing notebook through
   `compiled_from` and an embedding job is submitted to the worker.

The streaming endpoint emits JSON SSE events. Status and token events from the
nested graphs are forwarded unchanged, followed by `ai_message` and `complete`.

## Important invariants

- A session must be scoped to at least one existing notebook.
- The session graph is separate from `chat_session`; existing notebook-chat
  consumers assume a single notebook.
- A generated document is not a `Note` and has no single owning notebook.
- Refinement replaces the document content and increments its version.
- Deleting a session keeps generated documents; they are durable outputs.
- Embedding is fire-and-forget and requires the `surreal-commands` worker.

## Adding behavior

Keep routing and persistence in the existing session/document layers. New
long-running model work belongs in a graph node and must stream progress where
possible. Use the existing model provisioning, error classification and async
patterns. If the data model changes, add both migration directions and register
the migration in `AsyncMigrationManager`.

