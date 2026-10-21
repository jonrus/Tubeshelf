# Tubeshelf

## Product spec

`docs/app_idea.md` is the source of truth for the product itself — problem statement,
feature scope, architecture, data model. It changes rarely. When a spec refines or
supersedes something in it, that gets a small inline pointer there (e.g.
`(refined in docs/specs/003-ignore-rules-v2.md)`) rather than a rewrite.

## Running commands

Claude Code runs on the host, not inside the editor's devcontainer, and `bun` isn't
installed on the host. Every `bun`/project command (`bun test`, `bun run lint`,
`bun run db:generate`, etc.) goes through the devcontainer via podman:

```
devcontainer up --docker-path podman --workspace-folder .    # idempotent, safe to rerun
devcontainer exec --docker-path podman --workspace-folder . <command>
```

`up` exits non-zero if `postCreateCommand` fails (e.g. before `package.json` exists), but
the container keeps running, so `exec` still works. Task files list bare commands
(`bun test`, etc.) for readability; they always mean "via `devcontainer exec`".

Gotchas that only apply to driving the container from the CLI (not the editor workflow):

- **No port forwarding.** `forwardPorts` only works through an editor's Dev Containers
  proxy, so `curl http://localhost:3000` from the host fails even while the dev server
  runs. Curl from inside: `devcontainer exec --docker-path podman --workspace-folder . curl
  http://localhost:3000/...`.
- **No `ps`/`pkill` in the `oven/bun:1` image.** To stop a dev server, find its PID by
  scanning `/proc/[0-9]*/cmdline` for the command (`grep -l src/index.ts /proc/[0-9]*/cmdline`)
  and `kill <pid>` (`kill` is a shell builtin). Don't run the scan inline via
  `sh -c '… grep … src/index.ts …'` — that `sh`'s own cmdline matches, so it kills itself
  and the rest of the command silently never runs. Put the scan in a script file in the
  container (`devcontainer exec … sh -c "cat > /tmp/x.sh" < local-file`, since the
  container's `/tmp` is separate from the host's) and run `sh /tmp/x.sh`.
- **Weird container state** (e.g. an orphaned process left by a killed `devcontainer
  exec`): don't debug inside it. `podman stop <container-id>` (find it with `podman ps`),
  then rerun `devcontainer up …`. The container is disposable; no data volume.
- **Commands needing a real TTY** (e.g. `drizzle-kit generate` prompting "renamed vs. new
  table" on an ambiguous schema diff) can't be answered from `devcontainer exec`. Don't
  work around it with `script`/pty wrappers — that leaves orphaned processes. Hand the
  user the exact command to run in their own terminal and wait for the result.
- **`fallow` type-aware analysis hangs in the container** (the image's `node` is a symlink
  to `bun`, which lacks an API the sidecar needs). `.fallowrc.json` deliberately leaves
  `typeAware` off (`docs/specs/026-fallow-adoption.md`), so `bun run fallow` works
  normally. If it's ever turned on, run fallow directly on the host instead (it has real
  Node, and `node_modules` is bind-mounted).

## Development pattern: Spec-Driven Development

This project does not vibe-code. Every scoped piece of work gets a spec before
implementation; decisions live in tracked files, not conversation history. The skills are
personal (`~/.claude/skills/`: `new-feature`, `new-spec`, `spec-tasks`, `work-task`,
plus `work-loop` to run a task file hands-off via per-step subagents); this file pins the
project-specific paths.

1. `/new-feature` (optional, for larger or ambiguous asks) — copy
   `docs/features/000-feature_template.md` to `docs/features/NNN-slug.md`; the skill
   researches the codebase, asks clarifying questions, and edits the file in place
   (`Resolved Decisions` grows, `status: draft` → `refined`). Skip for small/obvious work.
2. `/new-spec` — write `docs/specs/NNN-name.md`, the committed source of truth for that
   scope. Given a `refined` feature file, it starts from that scope, reuses its slug, and
   flips the feature file to `status: promoted` with a pointer to the spec.
   `docs/features/` and `docs/specs/` are numbered **independently** (a feature can split
   into several specs or never be promoted); don't expect numbers to match. Promoted
   feature files stay in the repo.
3. `/spec-tasks` — derive a checklist at `docs/specs/tasks/name.md`, committed while the
   spec is `in-progress` so work can resume from either machine. Kept after completion as
   a record of how the work was broken down.
4. `/work-task` — in a **fresh session**, execute only the next unchecked step, check it
   off, stop. One step per session, to avoid context drift.

Spec `status` progresses `draft` → `in-progress` (tasks exist) → `implemented` (last step
done). Don't hand-write code against a spec without going through a task file.

### Git workflow

`main` is protected by GitHub Rulesets with an empty bypass list: no direct pushes, not
even from the owner. One branch and PR per spec.

- **Branch.** Off `main`, named `spec/<slug>` with **no number prefix**, created at the
  first step that produces a file for the work (`/new-feature` if used, else `/new-spec`).
  The slug is reused verbatim for the promoted spec, so the branch never needs renaming.
  Slugs aren't backstopped by a filename number, so check the slug isn't already used by
  another branch/spec/feature file.
- **Commits.** Ask before every commit. Write a descriptive message with the
  Co-Authored-By trailer; no `Claude-Session:` trailer. `/work-task` commits its one step
  per session.
- **Pushing.** Never push without asking, every time (which machine the user switches to
  varies). Ask whether they're pushing themselves or want Claude to.
- **Finishing a spec.** Set the spec to `status: implemented` on the same branch. The task
  file's final step opens the PR (summary + test plan). Check that final box *before*
  pushing — the reverse of `/work-task`'s usual order — so the pushed branch and PR carry
  a fully checked-off task file with nothing left uncommitted.
- **CI and merge.** `pr.yml`'s five required checks (`lint`, `test`, `typecheck`,
  `docker-build-check`, `fallow`) must be green. Merging is always manual in the GitHub UI;
  Claude never runs `gh pr merge`.

### Final verification

Every spec's final task-file step (and its manual-verification section, if any) must run
all four of `bun test`, `bun run lint`, `bunx tsc --noEmit`, **and `bun run fallow`**
clean across the repo. `test`/`lint` don't type-check, and `fallow` catches cross-file dead
code and duplication; skipping any of them lets problems sit unnoticed for several specs.

### Manual verification sections in task files

Split a "Manual end-to-end verification" section into two labeled parts:

- **Claude performs directly** — anything checkable via `curl` from inside the container
  or a direct SQLite read/write against the dev DB: server-rendered HTML, status/error
  text, DB state. For routes behind `requireAuth`, get a cookie jar first with
  `scripts/dev-login.sh`, which logs in as `admin` / `AUTH_RECOVERY_PASSWORD`
  (`dev-password-change-me`, from `.devcontainer/devcontainer.json`) and writes
  `/tmp/tubeshelf-dev-cookies.txt`:
  `devcontainer exec --docker-path podman --workspace-folder . scripts/dev-login.sh`, then
  `curl -b /tmp/tubeshelf-dev-cookies.txt http://localhost:3000/queue` (also inside the
  container). The script isn't in the Docker image (the Dockerfile `COPY`s an explicit
  allowlist).
- **User performs live in a browser** — what `curl` can't observe: HTMX partial swaps,
  visual layout, click-through feel. Give the exact URL and click/type target for each
  step and what to look for; the user reports back.

Worked example: `docs/specs/tasks/008-mvp-completion-gaps.md`.

For throwaway DB rows, write the `bun:sqlite` query to a script file (e.g. a
`cat > /tmp/foo.mjs <<'EOF'` heredoc through `devcontainer exec`) instead of `bun -e "…"`;
inline SQL gets mangled by the nested shell/JS quoting and can silently match nothing.
Delete the file and rows afterward.

## Memory vs. version control

This project is developed from two machines, and Claude Code memory is local to each. Put
anything durable and project-wide (decisions, roadmap, non-obvious reasoning) in a
version-controlled doc — a spec, `docs/app_idea.md`, a task file — not only in memory.
