# Research Sessions

A research session is AegisNotebook's cross-notebook workspace. It lets you
connect one or more notebooks to the same conversation and move from research
questions to a generated deliverable without losing the context established in
the conversation.

## How it differs from notebook chat

Notebook chat is tied to one notebook and uses the sources and notes that you
explicitly select as context. A research session is a separate, many-to-many
workspace:

| Capability | Notebook chat | Research session |
|---|---|---|
| Scope | One notebook | One or more notebooks |
| Main use | Explore selected content conversationally | Research across projects and produce a deliverable |
| Retrieval | Explicit context selection | Semantic retrieval scoped to connected notebooks |
| Output | Conversation, optionally saved as a note | Conversation plus versioned generated documents |

## Typical workflow

```text
Select notebooks
      ↓
Create a research session
      ↓
Ask questions in Ask mode
      ↓
Clarify requirements and constraints
      ↓
Switch to Generate mode
      ↓
Create or refine a document
```

The session keeps its conversation history in a LangGraph checkpoint. Every
turn can use either `ask` or `generate` mode. The frontend receives status and
text events over Server-Sent Events, so the user can see whether the system is
planning, searching, writing, gathering context, drafting, or saving.

## Generated documents

Generated documents are separate from notes because they can be compiled from
multiple notebooks. They have their own title, content, language, status and
version. The current generator supports:

- English (`en`)
- Swedish (`sv`)
- English and Swedish (`bilingual`)

The built-in prompt currently produces an IT architecture design document with
sections for strategy, infrastructure, security, source material and a Mermaid
diagram. A later generation turn can use the active document as its previous
draft and produce a complete revised version.

Documents are also embedded asynchronously and can therefore be returned by
semantic search after embedding has completed.

## Data model

Research sessions use their own `research_session` record and `scopes`
relationships to notebooks. Generated documents use `generated_document` and
`compiled_from` relationships. This keeps the existing single-notebook
`chat_session` behavior intact while allowing cross-notebook research.

Relevant API endpoints are:

- `POST /api/research-sessions`
- `GET /api/research-sessions/{id}`
- `POST /api/research-sessions/{id}/stream`
- `GET /api/research-sessions/{id}/documents`
- `GET /api/generated-documents/{id}`

