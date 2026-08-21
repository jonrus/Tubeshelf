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
- **`fallow`'s type-aware analysis (`typeAware.enabled: true` in `.fallowrc.json`) hangs
  forever inside the devcontainer** (confirmed 2026-08-20) — any command that triggers it
  spawns a `fallow-type-aware` sidecar that shells out to what it expects is real Node.js
  to run `tsc --api`. The `oven/bun:1` base image has no real Node.js; its `node` on `PATH`
  is a symlink straight to `bun`
  (`/usr/local/bun-node-fallback-bin/node -> /usr/local/bin/bun`), and the sidecar calls a
  Node-internal API (`stdout._handle.fd`) that Bun doesn't implement, throwing inside a
  context whose rejection never surfaces — the parent just hangs (confirmed reproducing
  identically after a full container destroy/recreate, and confirmed *not* a TTY issue: it
  hangs the same way in the user's own interactive terminal, only revealing the real error,
  `stdout._handle.fd` on `undefined`, once force-killed with Ctrl+C). **This project's
  `.fallowrc.json` deliberately leaves `typeAware` off** (per
  `docs/specs/026-fallow-adoption.md`'s Design → `typeAware` subsection: enabling it didn't
  measurably improve this repo's findings, so paying an ongoing devcontainer exception for
  it wasn't worth it) — so plain `bun run fallow`/`bunx fallow` don't hit this hang and run
  fine inside the devcontainer like any other project command; no exception needed for
  routine use. If `typeAware` is ever turned back on for some reason, run that command
  directly on the host instead of via `devcontainer exec` (the host has real Node.js and the
  repo's `node_modules` is bind-mounted from the container, so `node_modules/.bin/fallow`
  works as-is); this is also not a CI risk either way, since GitHub's `ubuntu-latest` runner
  ships real Node.js regardless of `oven-sh/setup-bun@v2`.

## Development pattern: Spec-Driven Development

This project does not vibe-code. Every scoped piece of work gets a spec before
implementation, and decisions live in tracked files instead of conversation history:

1. `/new-feature` (optional, for larger or ambiguous asks) — copy
   `docs/features/000-feature_template.md` to `docs/features/NNN-slug.md` and fill in what
   you can yourself first. The skill reads that file, researches the current codebase, asks
   batched clarifying questions grounded in what it finds, and edits the file in place (a
   `Resolved Decisions` section grows, `status: draft` → `refined`) until scope is fully
   settled — durable and resumable across sessions/machines, same as a task file. Skip this
   step entirely for smaller/obvious work; `/new-spec` below works exactly as it always has
   when invoked directly, with no feature file involved.
2. `/new-spec` — write a spec to `docs/specs/NNN-name.md` (committed, versioned, the single
   source of truth for that scope of work). When pointed at a `refined` feature file
   (`/new-spec docs/features/NNN-slug.md`), it starts from that file's resolved scope
   instead of interviewing from scratch, reuses its slug for the spec's title, and — once
   the spec is written — updates the feature file to `status: promoted` with a pointer to
   the new spec. `docs/features/` and `docs/specs/` are numbered **independently**; a
   feature can split into multiple specs, get deferred, or never be promoted, so don't
   expect their numbers to match. Promoted feature files are kept in the repo permanently,
   same rationale as task files below.
3. `/spec-tasks` — derive an execution checklist at `docs/specs/tasks/name.md`. Committed
   while the spec is `in-progress` — that's what makes it possible to resume work from a
   different machine, not just a different session. Kept in the repo once every step is
   checked off and the spec reaches `implemented`; the spec is the durable record of what
   and why, but the task file remains as a record of how the work was broken down.
4. `/work-task` — resume the checklist in a **fresh session**, execute only the next
   unchecked step, check it off, stop. One step per session, deliberately, to avoid context
   drift across a long-running conversation.

These are personal skills (`~/.claude/skills/`: `new-feature`, `new-spec`, `spec-tasks`,
`work-task`), so the same pattern carries over to other projects — this file just pins the
project-specific paths above.

A spec's frontmatter `status` progresses `draft` → `in-progress` (once tasks exist) →
`implemented` (once `/work-task` finishes the last step). Don't hand-write code against a
spec without going through a task file — that's what defeats the point of the pattern.

### Git workflow: branches and PRs (post spec015)

Since spec015 (`docs/specs/015-github-buildout.md`), `main` is protected by two GitHub
Rulesets, one of which (`main-checks`) has an **empty bypass list** — direct pushes to
`main` are blocked for everyone, including the repo owner. All work now goes through one
branch/PR per spec, layered on top of the four steps above (this isn't part of the shared
`~/.claude/skills/` themselves, since those are reused across other projects — it's applied
here as a project-specific pin, the same way the devcontainer paths above are):

- **Branch creation.** Off `main`, named `spec/<slug>` — **no number prefix.** Created at
  whichever step first produces a file for that unit of work: `/new-feature`, if used (the
  feature file is the first artifact); otherwise `/new-spec`. Deliberately excludes the
  `NNN` (from either the feature file's own number or the eventual spec's — see step 2
  above, they're independent sequences) specifically so the branch never needs renaming
  later: a feature file's slug is already reused verbatim for its promoted spec's title, so
  `spec/<slug>` is stable from the moment `/new-feature` first names it, through promotion,
  through the PR — including across a feature file created on one machine and continued via
  `/new-spec`/`/work-task` on the other, where a local-only rename wouldn't be visible
  anyway. The tradeoff: slug uniqueness is no longer backstopped by a filename number, so
  `/new-feature` and `/new-spec` should check the slug isn't already in use by another
  branch/spec/feature file before settling on it.
- **Commits during `/work-task`.** Each session commits its one step to the branch as
  usual. Never push without asking first — default assumption is the user pushes manually,
  but confirm explicitly at whatever point a push would actually matter (end of a
  `/work-task` session, or the branch-push-and-PR step below): ask whether the user is
  pushing it themselves or wants Claude to, and only push if they say so. This isn't a
  one-time authorization — ask every time, since which machine the user is about to switch
  to varies session to session.
- **Finishing a spec.** Flip the spec's frontmatter to `status: implemented` as part of the
  same branch (not a separate trailing PR after merge — that split only happened in
  spec015 itself as a one-time artifact of branch protection not existing yet when it
  started, not the steady-state pattern going forward). The task file's final step is to
  open the PR, filled out (summary + test plan) — but check that final step's own box
  *before* pushing, deliberately inverting `/work-task`'s normal "do the work, then check
  it off" order (steps 4→6) for this one step only. Otherwise the box-check commit trails
  the push with nothing to carry it to the remote, leaving a dangling local commit the user
  has to notice and push separately. Checking it off first means the push — whenever it
  happens, see above — carries a task file that's already fully checked off, so the pushed
  branch and the opened PR both reflect a complete state with nothing left uncommitted
  afterward.
- **CI and merge.** `pr.yml`'s five required checks (`lint`, `test`, `typecheck`,
  `docker-build-check`, `fallow`) must be green. Merging is always manual — the user reviews and
  clicks merge in the GitHub UI; Claude never runs `gh pr merge` or otherwise merges a PR
  itself.

### Manual verification sections in task files

When a task file has a "Manual end-to-end verification" section, split it explicitly into
two labeled parts instead of one blended "confirm in a browser" list — that ambiguity (who
does which step) has caused rework before.

- **Claude performs directly** — anything checkable via `curl` from inside the devcontainer
  (per the port-forwarding gotcha above) or a direct SQLite read/write against the dev DB
  file. This covers server-rendered HTML content, response status/error text, and DB state
  — i.e. everything except how it actually looks/feels live in a browser. Claude runs these
  itself; no user action needed.
- **User performs live in a browser** — anything `curl` genuinely can't observe: real HTMX
  partial-swap behavior (no full-page reload), visual layout/rendering, and the actual
  click-through experience. Claude gives the exact URL and click/type target for each step
  and says what to look for; the user drives the browser and reports back what they saw.

See spec008's task file (`docs/specs/tasks/008-mvp-completion-gaps.md`) for a worked example
of the split.

Every spec's final task-file step (and matching manual-verification section, if the spec
has one) must run all four of `bun test`, `bun run lint`, `bunx tsc --noEmit`, **and
`bun run fallow`** clean across the repo — not just the first two or three. `bun test`/
`bun run lint` don't do a full type-check, so type errors (e.g. ones caused by
`tsconfig.json`'s `noUncheckedIndexedAccess`) can sit unnoticed for multiple specs' worth
of commits until someone runs `tsc --noEmit` by hand (confirmed happening in spec006: a
`match[1]: string | undefined` error introduced by spec005 wasn't caught until spec006's
final verification pass, several commits later). `bun run fallow` (added in
`docs/specs/026-fallow-adoption.md`) closes the same class of gap one level further out —
cross-file dead code and duplication that none of the other three touch — and belongs in
this list for the same reason: catch it locally before push, not only after CI runs
`main-checks`.

## Memory vs. version control

This project is developed from two separate machines (see the devcontainer note above).
Claude Code's cross-session memory is local to whichever machine a session happens to run
on — it does not sync between them. So for any durable project decision, plan, or
non-obvious reasoning worth keeping (roadmap sequencing, a design tradeoff, anything a
future session on *either* machine would want to know), default to writing it into a
version-controlled repo doc — a spec, `docs/app_idea.md`, a task file — not only into
assistant memory. Treat memory as a same-machine convenience/pointer at most, never the
source of truth for something that matters project-wide.
