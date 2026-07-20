# Tasks: Bootstrap Repo Scaffold
Spec: docs/specs/001-bootstrap-repo-scaffold.md
Generated: 2026-07-18

**Environment note:** `bun` is not installed on the host, and Claude Code itself always
runs on the host — there's no way to launch a `/work-task` session from inside an
editor-integrated devcontainer for this workflow. Step 2 (devcontainer config) runs
directly on the host. Steps 3 onward need `bun`, reached via the `devcontainer` CLI
(`@devcontainers/cli`, installed on this host via `brew install devcontainer`, which pulls
in `node`) pointed at podman:

- Bring the container up (idempotent, safe to rerun every session):
  `devcontainer up --docker-path podman --workspace-folder .`
- Run any command inside it: `devcontainer exec --docker-path podman --workspace-folder . <command>`,
  e.g. `devcontainer exec --docker-path podman --workspace-folder . bun --version` (expect `1.3.14`).

Known quirk: `devcontainer up` exits non-zero if `postCreateCommand`
(`bun install && bun run css:build`) fails — which it will on every `up` until step 3
creates `package.json`. That failure is expected pre-step-3 and does **not** mean the
container failed to start; it stays running (confirm with
`podman ps --filter "label=devcontainer.local_folder=$(pwd)"` if unsure) and `exec` still
works. A cold `/work-task` session should run `devcontainer up` first, tolerate that
exit-code-1 while `package.json` doesn't exist yet, then confirm access with
`devcontainer exec --docker-path podman --workspace-folder . bun --version` before
attempting any other `bun` command.

- [x] 1. Extend `.gitignore` with `node_modules/`, `data/*.db*`, `public/css/tailwind.css`,
  and `.env`, on new lines below the existing `docs/specs/tasks/` entry (don't remove or
  reorder what's already there) — done when: `git check-ignore -v node_modules/x data/tubeshelf.db public/css/tailwind.css .env`
  reports all four as ignored, and `git diff .gitignore` shows only additions.

- [x] 2. Create `.devcontainer/devcontainer.json` with the exact content specified in the
  spec's Design → Devcontainer section (`image: oven/bun:1`, `git`/`github-cli` features,
  vscode customizations/extensions/settings, `postCreateCommand: "bun install && bun run css:build"`,
  `forwardPorts: [3000]`). Before finalizing, check whether the `oven/bun:1` image has a
  non-root user (e.g. `podman run --rm oven/bun:1 whoami`, if `podman` is available on the
  host — this repo's dev machines run Bazzite/Fedora, which use podman rather than
  docker) — if it does, add `"remoteUser": "<that user>"`; if `podman` isn't available to
  check, leave `remoteUser` unset and add a one-line JSON comment flagging it as
  unverified. This resolves the spec's first Open Question. Done when: the file exists,
  is valid JSON(C), and the devcontainer builds/opens successfully via the editor's Dev
  Containers extension (already configured to use podman as its backend on this machine)
  with a `bun --version` check passing inside it.

- [x] 3. Inside the devcontainer, run `bun init -y` if no `package.json` exists yet, then
  `bun add hono drizzle-orm` and `bun add -D drizzle-kit tailwindcss @tailwindcss/cli
  concurrently @biomejs/biome @types/bun typescript`. Set `package.json`'s `scripts` block
  to exactly match the spec's Design → package.json scripts section (`dev`, `dev:server`,
  `start`, `css:build`, `css:watch`, `lint`, `lint:fix`, `format`, `test`, `db:generate`,
  `db:migrate`, `db:studio`). Create `tsconfig.json` with the key fields listed in the spec
  (`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`, `"moduleResolution": "bundler"`,
  `"strict": true`, `"types": ["bun-types"]`). Done when: `package.json` contains all
  listed deps/devDeps and scripts, `bun.lock` exists, and `bunx tsc --noEmit` runs without
  a "cannot find tsconfig" error (type errors are expected/fine — no source files exist
  yet).

- [x] 4. Create `biome.json`: `recommended` preset only, 2-space indent, double quotes,
  semicolons, with `drizzle/**` and `public/css/**` excluded from formatting/linting. Done
  when: `bun run lint` and `bun run format` both execute without error against the
  currently-empty `src/` (no files to flag yet, but the commands must not crash on config).

- [x] 5. Create `drizzle.config.ts` with the exact content from the spec's Design section
  (`dialect: "sqlite"`, `schema: "./src/db/schema.ts"`, `out: "./drizzle"`,
  `dbCredentials.url` from `DB_FILE_NAME` env var or `./data/tubeshelf.db`). Done when: the
  file exists and `bunx drizzle-kit generate --help` runs without a config-parsing error
  (schema.ts doesn't exist yet — that's fine for this step).

- [x] 6. Create `src/db/schema.ts` with the exact table definitions from the spec's Design
  → Database schema section: `users`, `categories`, `channels`, `videos` (with the two
  `check()` CHECK constraints), `ignoreRules`. If the installed Drizzle version's
  `check()`/callback syntax differs from the spec's snippet (`(t) => [check(...), ...]`),
  adapt to whatever the installed version's docs specify and note the actual syntax used
  in a one-line comment — this resolves the spec's second Open Question. Done when:
  `bunx tsc --noEmit` reports no type errors in this file.

- [x] 7. Create `src/db/client.ts` with the exact content from the spec (opens
  `./data/tubeshelf.db` or `$DB_FILE_NAME`, sets `PRAGMA journal_mode = WAL` and
  `PRAGMA foreign_keys = ON`, exports `db` via `drizzle(sqlite)` and `sqlite`). Done when:
  running `bun -e "import './src/db/client'; console.log('ok')"` prints `ok` and creates
  `data/tubeshelf.db`, `data/tubeshelf.db-wal`, `data/tubeshelf.db-shm` on disk.

- [ ] 8. Run `bun run db:generate`. Done when: `drizzle/0000_*.sql` exists and contains
  `CREATE TABLE` statements for all five tables, including both CHECK constraints on
  `videos` (`status_check`, `ignore_method_check`); `drizzle/meta/_journal.json` exists;
  both are staged for commit (this migration output is the one part of `drizzle/` that
  *is* version-controlled, per the spec's repo layout).

- [ ] 9. Create `src/db/migrate.ts`: a thin wrapper that imports `migrate` from
  `drizzle-orm/bun-sqlite/migrator`, calls it with the `db` client from `src/db/client.ts`
  and `{ migrationsFolder: "./drizzle" }`, and exports a `runMigrations()` function. Done
  when: calling `runMigrations()` against a fresh empty `data/tubeshelf.db` creates all
  five tables (verify via `sqlite3 data/tubeshelf.db .tables` or an equivalent query), and
  calling it a second time against the same file is a no-op (no error, no duplicate
  tables).

- [ ] 10. Create `src/db/seed.ts` with the exact `seed()` function from the spec's Design →
  Seed strategy section (checks for an existing "Uncategorized" category and any user row
  before inserting either). Done when: calling `seed(db)` twice in a row against the same
  DB results in exactly one `isSystem` category named "Uncategorized" and exactly one row
  in `users`.

- [ ] 11. Create `src/styles/input.css` containing `@import "tailwindcss";`. Done when:
  `bun run css:build` produces a non-empty `public/css/tailwind.css`.

- [ ] 12. Create `src/views/layout.tsx` (HTML shell linking `/css/tailwind.css` and the
  pinned htmx CDN script `https://unpkg.com/htmx.org@2.0.4`), `src/views/categories-list.tsx`
  (a `<div id="category-list">` partial: `<ul>` of categories — system row first tagged
  `[system]`, then the rest alphabetically — plus an add-category `<form>` with
  `hx-post="/categories" hx-target="#category-list" hx-swap="outerHTML"`), and
  `src/views/categories-page.tsx` (full page wrapping the list partial in `layout.tsx`).
  Done when: `bunx tsc --noEmit` reports no type errors across these three files.

- [ ] 13. Create `src/routes/categories.ts`: `GET /` renders `categories-page.tsx` with all
  categories queried via Drizzle (system row first, then alphabetical); `POST /categories`
  trims the submitted name, rejects empty and case-insensitive `"uncategorized"` with an
  inline error (not a 500), catches the unique-constraint violation on duplicate names the
  same way, and on success re-queries and returns just the `categories-list.tsx` partial.
  Done when: with a running server (see step 14), `curl -s -X POST localhost:3000/categories
  -d name=Podcasts` returns 200 with HTML containing "Podcasts" and no error; the same
  request with `name=uncategorized` or `name=` returns an inline error string, not a 500.

- [ ] 14. Create `src/index.ts`: on startup, calls `runMigrations()` then `seed(db)`, mounts
  `serveStatic` (`hono/bun`) at `/css/*` pointing at `public/css`, mounts the categories
  routes, and starts listening on port 3000. Done when: `bun run dev:server` logs
  migration/seed completion and listens on port 3000 without throwing.

- [ ] 15. Create `test/smoke.test.ts` per the spec's Design → Testing section: spins up an
  isolated in-memory `bun:sqlite` database (not `./data/tubeshelf.db`), runs the real
  committed migrations from `./drizzle` against it, calls `seed()` twice, and asserts
  exactly one `isSystem` category named "Uncategorized" and exactly one user row. Done
  when: `bun test` passes, and passes again after manually corrupting/deleting
  `data/tubeshelf.db` (proving the test doesn't depend on dev-time DB state).

- [ ] 16. Create `.env.example` (empty or a single comment noting no env vars are required
  for MVP, per `docs/app_idea.md` §6) and a minimal `README.md` covering: opening the repo
  in the devcontainer, `bun install`, `bun run dev`, and `bun test`. Include a one-line note
  that the devcontainer is used with **podman** rather than Docker on this project's dev
  machines (Bazzite/Fedora) — no setup instructions needed beyond that note, since the Dev
  Containers extension is already configured for podman on both machines. Done when: both
  files exist and a reader with no prior context could get the dev server running from the
  README alone.

- [ ] 17. Run the full 12-step verification sequence from the spec's Design → Verification
  subsection, in order, exactly as written (install → generate migration → build CSS → run
  dev server → visually confirm the page and Tailwind styling → submit a category via the
  HTMX partial swap → full reload persists it → restart persists it → confirm WAL-mode
  files on disk and via `PRAGMA journal_mode` → confirm the reserved-name/duplicate error
  handling → `bun test` passes → `bun run lint` and `bun run format` are clean). Done when:
  all 12 steps pass with no deviation; update this spec's frontmatter to
  `status: implemented` once they do (that update belongs to whichever `/work-task` session
  finishes this step, per the SDD pattern in `CLAUDE.md`).
