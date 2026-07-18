# Tubeshelf

## Product spec

`docs/app_idea.md` is the source of truth for the product itself — problem statement,
feature scope, architecture, data model. It changes rarely. When a spec below refines or
supersedes something in it, that gets a small inline pointer there (e.g.
`(refined in docs/specs/003-ignore-rules-v2.md)`) rather than rewriting its content.

## Development pattern: Spec-Driven Development

This project does not vibe-code. Every scoped piece of work gets a spec before
implementation, and decisions live in tracked files instead of conversation history:

1. `/new-spec` — write a spec to `docs/specs/NNN-name.md` (committed, versioned, the single
   source of truth for that scope of work).
2. `/spec-tasks` — derive an execution checklist at `docs/specs/tasks/name.md` (gitignored,
   disposable — expected to go stale once its spec is implemented).
3. `/work-task` — resume the checklist in a **fresh session**, execute only the next
   unchecked step, check it off, stop. One step per session, deliberately, to avoid context
   drift across a long-running conversation.

These are personal skills (`~/.claude/skills/`), so the same pattern carries over to other
projects — this file just pins the project-specific paths above.

A spec's frontmatter `status` progresses `draft` → `in-progress` (once tasks exist) →
`implemented` (once `/work-task` finishes the last step). Don't hand-write code against a
spec without going through a task file — that's what defeats the point of the pattern.
