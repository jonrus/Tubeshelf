# Tubeshelf

## Product spec

`docs/app_idea.md` is the source of truth for the product itself — problem statement,
feature scope, architecture, data model. It changes rarely. When a spec below refines or
supersedes something in it, that gets a small inline pointer there (e.g.
`(refined in docs/specs/003-ignore-rules-v2.md)`) rather than rewriting its content.

## Running commands

Claude Code runs on the host, not inside the editor-integrated devcontainer, and `bun`
isn't installed on the host — every `bun`/project command (`bun test`, `bun run lint`,
`bun run db:generate`, etc.) must go through the devcontainer via podman:

```
devcontainer up --docker-path podman --workspace-folder .    # idempotent, safe to rerun
devcontainer exec --docker-path podman --workspace-folder . <command>
```

`up` exits non-zero if `postCreateCommand` fails (e.g. before `package.json` exists) but
the container keeps running regardless, so `exec` still works. This applies in every
session, including `/work-task` — task files list bare commands (`bun test`, etc.) for
readability, but they mean "run via `devcontainer exec` as above," not "run directly on
host." See `.devcontainer/devcontainer.json` and `README.md` for the container setup
itself.

Two more gotchas specific to driving the container this way (confirmed still true
2026-07-22), neither of which apply to the human's normal editor-integrated Dev Containers
workflow, only to a Claude Code session using the CLI directly:

- **No port forwarding.** `forwardPorts`/`portsAttributes` in `devcontainer.json` only take
  effect through an editor's Dev Containers extension proxy — there's no such proxy here.
  `curl http://localhost:3000` from the host hangs/fails even while `bun run dev` is
  running fine inside the container. To check the running app, `curl` (or similar) from
  *inside* the container: `devcontainer exec --docker-path podman --workspace-folder . curl
  http://localhost:3000/...`.
- **No `ps`/`pkill` in the `oven/bun:1` base image.** To stop a dev server started inside
  the container, find its PID by scanning `/proc/[0-9]*/cmdline` for the matching command
  (`grep -l src/index.ts /proc/[0-9]*/cmdline`) and `kill <pid>` directly — `kill` itself is
  a shell builtin and works fine, it's just `ps`/`pkill` that are missing.
- **If the container gets into a weird state** (e.g. an orphaned/stuck process left behind
  by a killed `devcontainer exec` — confirmed with a `drizzle-kit generate` process wedged
  waiting on a TTY prompt that would never come, 2026-07-22), don't chase it down inside the
  container. It's disposable: `podman stop <container-id>` (find it with `podman ps`) then
  rerun `devcontainer up --docker-path podman --workspace-folder .`, which restarts the same
  container cleanly. No data-loss concern — this is the dev environment, not a data volume.
- **Some commands need a real interactive TTY** (confirmed with `drizzle-kit generate`,
  which prompts to disambiguate "renamed table" vs. "new table" when the schema diff is
  ambiguous — e.g. spec002's `channels` → `youtube_channels` split). `devcontainer exec`
  run from a Claude Code session has no TTY to answer that with, and piping input doesn't
  substitute for one (the prompt library checks `stdin.isTTY` directly). Don't try to work
  around this with `script`, a pty wrapper, etc. — that risks leaving an orphaned process
  waiting on a pty nothing is attached to (see the gotcha above). Instead, hand the user the
  exact command to run in their own terminal and wait for them to report the result back.

## Development pattern: Spec-Driven Development

This project does not vibe-code. Every scoped piece of work gets a spec before
implementation, and decisions live in tracked files instead of conversation history:

1. `/new-spec` — write a spec to `docs/specs/NNN-name.md` (committed, versioned, the single
   source of truth for that scope of work).
2. `/spec-tasks` — derive an execution checklist at `docs/specs/tasks/name.md`. Committed
   while the spec is `in-progress` — that's what makes it possible to resume work from a
   different machine, not just a different session. Kept in the repo once every step is
   checked off and the spec reaches `implemented`; the spec is the durable record of what
   and why, but the task file remains as a record of how the work was broken down.
3. `/work-task` — resume the checklist in a **fresh session**, execute only the next
   unchecked step, check it off, stop. One step per session, deliberately, to avoid context
   drift across a long-running conversation.

These are personal skills (`~/.claude/skills/`), so the same pattern carries over to other
projects — this file just pins the project-specific paths above.

A spec's frontmatter `status` progresses `draft` → `in-progress` (once tasks exist) →
`implemented` (once `/work-task` finishes the last step). Don't hand-write code against a
spec without going through a task file — that's what defeats the point of the pattern.

## Memory vs. version control

This project is developed from two separate machines (see the devcontainer note above).
Claude Code's cross-session memory is local to whichever machine a session happens to run
on — it does not sync between them. So for any durable project decision, plan, or
non-obvious reasoning worth keeping (roadmap sequencing, a design tradeoff, anything a
future session on *either* machine would want to know), default to writing it into a
version-controlled repo doc — a spec, `docs/app_idea.md`, a task file — not only into
assistant memory. Treat memory as a same-machine convenience/pointer at most, never the
source of truth for something that matters project-wide.
