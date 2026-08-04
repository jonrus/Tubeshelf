---
status: draft
created: 2026-08-04
---

# Deployment / Docker Packaging

## Context

Per `docs/app_idea.md`'s "Path to v1.0", step 3 (DB squash + admin rename, spec013) is
`implemented`. Step 4 — deployment/Docker packaging — is next: the app has only ever run in
the dev-only devcontainer image (`.devcontainer/devcontainer.json`, `oven/bun:1`, `bun`
installed as a devcontainer feature/base) and has never been packaged for anything a
self-hoster could actually run. This spec produces a production Dockerfile, a
`docker-compose.yml`, and `docs/DEPLOYMENT.md` — enough for a reader comfortable with
Docker Compose in general (not necessarily this project, not necessarily Bun) to get the
app running unassisted.

This spec originates from `docs/features/005-deployment-docker-packaging.md`
(`status: refined`), which resolved scope through a `/new-feature` pass including three
`AskUserQuestion` rounds (runtime base image, `/healthz` depth, reverse-proxy doc depth).
That file's `Resolved Decisions` are taken as settled; this spec's Design section adds the
concrete mechanics needed to actually build the thing (exact Dockerfile stages, compose
service shape, code changes) the same way spec013's Design section added squash mechanics
on top of feature file 004.

Explicitly sequenced *before* `docs/app_idea.md`'s Path to v1.0 step 5 (GitHub CI/registry
image publishing): there is no published image yet, so this spec's compose file builds from
local source (`build: .`), not `image: ghcr.io/...`.

## Scope

**In scope:**
- A production `Dockerfile` at the repo root: multi-stage, `oven/bun:1-alpine` base for both
  stages, non-root runtime user.
- `.dockerignore` at the repo root.
- `docker-compose.yml` at the repo root: builds the above image, bind-mounts SQLite storage,
  `restart: unless-stopped`, host port binding, `env_file`-based secrets, a `healthcheck`
  block.
- A new `GET /healthz` route (`src/routes/health.ts`) that checks DB reachability, not just
  process liveness.
- Wrapping `runMigrations()` in `src/index.ts` in a try/catch that prints actionable
  guidance on failure instead of a raw stack trace, then exits non-zero.
- Rewriting `.env.example` to document every env var the app actually reads
  (`AUTH_RECOVERY_PASSWORD`, `TRUSTED_ORIGINS`, `DB_FILE_NAME`), each with a one-line
  comment.
- New `docs/DEPLOYMENT.md`, written generically (not tied to Jon's own NPM + Cloudflare
  Tunnel homelab topology, which sits in front of, not inside, this project's compose
  file), plus a short new "Deployment" section in `README.md` linking to it.
- Minimal test coverage for the new `/healthz` route (see Design).

**Explicitly out of scope** (all already logged in `docs/app_idea.md`'s Future Roadmap
(v2.0), added during the `/new-feature` pass — commit `0d95767`):
- Bun standalone binary (`bun build --compile`).
- `PUID`/`PGID` env var support for arbitrary host UID/GID.
- Graceful shutdown (SIGTERM handling) for the HTTP server / scheduler.
- A broader structured-logging pass beyond the one migration-failure message this spec
  adds.

**Also explicitly out of scope** (deferred to later Path to v1.0 steps, not the roadmap):
- GitHub CI/CD, release image publishing to a registry — Path to v1.0 step 5, comes after
  this spec.
- Any change to `src/db/seed.ts` — confirmed already idempotent during the feature file's
  brainstorming; not reopened here.
- Any real multi-user support / password-reset flow — still v2.0.

## Design

### Dockerfile

Two stages, both `oven/bun:1-alpine` (per the feature file's resolved decision: none of the
app's runtime deps — `drizzle-orm`, `fast-xml-parser`, `hono`, and `bun:sqlite`, which is
built into Bun itself rather than a native npm module — have known musl/alpine issues, so
there's no reason for the build stage to use a different, larger variant):

```dockerfile
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run css:build

FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle ./drizzle
COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
```

Notes:
- `bun install --frozen-lockfile` (not a bare `bun install`) in both stages, so the build
  fails loudly if `bun.lock` (checked into the repo, text-format) and `package.json` drift
  out of sync, rather than silently resolving something different than local dev used.
- The build stage's `bun install --frozen-lockfile` (no `--production`) pulls in
  `tailwindcss`/`@tailwindcss/cli` (both devDependencies) since `css:build` needs them; the
  runtime stage's separate `--production` install starts from a clean `node_modules` that
  never includes `drizzle-kit`/`biome`/`typescript`/`tailwindcss`/`@tailwindcss/cli`/
  `concurrently` — none of which the running app needs, since migrations run through
  `drizzle-orm/bun-sqlite/migrator`'s `migrate()` function (`src/db/migrate.ts`) directly,
  never the `drizzle-kit` CLI.
- `public/` only ever contains the generated `css/tailwind.css` (confirmed — no other
  static files exist under `public/` today); the runtime stage copies just that one
  generated file from the build stage rather than the whole `public/` tree, so there's
  nothing to accidentally miss if that changes later without this Dockerfile being updated
  in lockstep — a `COPY public ./public` from the *build* stage would silently work too, but
  copying the one specific generated artifact makes the dependency between `css:build`'s
  output and what actually ships explicit.
- The runtime stage's `COPY` list also includes `tsconfig.json` alongside `package.json`/
  `bun.lock`, not just `src`/`drizzle`/the built CSS. **Corrected during this spec's
  red-team pass:** the first draft omitted it, on the assumption only `.ts`/`.tsx` source
  and the lockfile mattered at runtime. Bun reads `tsconfig.json` at execution time to
  resolve the JSX transform (`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`) for
  every `.tsx` file — 17 of them under `src/`, including `src/routes/auth.tsx`, imported
  directly by `src/index.ts`. Without a discoverable `tsconfig.json`, Bun falls back to the
  classic React JSX transform and tries to resolve `react/jsx-dev-runtime`, which isn't a
  dependency (`react` isn't in `package.json` — `hono/jsx` is the actual runtime); the
  container crashes immediately on boot with `Cannot find module 'react/jsx-dev-runtime'`.
  Verified by building the Dockerfile as originally drafted (reproduced the crash), then
  rebuilding with `tsconfig.json` added (boots cleanly, runs migrations, seeds, serves on
  port 3000).
- `USER bun` is set explicitly in the runtime stage, with no `--chown` needed on the
  preceding `COPY` instructions — verified by building and running the image; file
  ownership was never the problem (this also matches Bun's own official multi-stage Docker
  example, which likewise omits `--chown`). The `bun` user itself is confirmed to exist on
  `oven/bun:1-alpine` specifically (`podman run --rm docker.io/oven/bun:1-alpine sh -c 'id
  bun'` → `uid=1000(bun) gid=1000(bun)`) — note this is a different tag than
  `.devcontainer/devcontainer.json`'s non-alpine `oven/bun:1`, so that file isn't itself
  evidence for the alpine tag; verified directly against alpine instead. The base image's
  own default user is root until an image explicitly switches, so being explicit here is
  required, not redundant. The one real bind-mount permission hazard is the host-side
  `/data` directory, not the app files — already covered by `docs/DEPLOYMENT.md` §4 below
  (confirmed necessary: an unchowned bind mount produces `SQLiteError: SQLITE_CANTOPEN`).
- No `HEALTHCHECK` instruction in the Dockerfile itself — the healthcheck lives in
  `docker-compose.yml` only (see below). `docs/app_idea.md`'s Infrastructure line commits to
  Docker Compose as the delivery mechanism ("Self-hosted via a Docker container via a
  compose file"), so there's no bare `docker run` usage path to support separately.
- `CMD ["bun", "run", "start"]` reuses the existing `package.json` `"start"` script
  (`bun run src/index.ts`) rather than hardcoding the entrypoint path a second time.

### `.dockerignore`

```
node_modules
.git
test
docs
data
.devcontainer
*.md
.env
```

Keeps the build context small and, more importantly, keeps `.env` (real secrets, already
gitignored) from ever being sent to the Docker daemon as build context — `docker-compose.yml`
supplies it at *run* time via `env_file`, not at build time, so it has no reason to be in
the image layer history at all.

### `docker-compose.yml`

```yaml
services:
  tubeshelf:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      - DB_FILE_NAME=/data/tubeshelf.db
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

Notes:
- `DB_FILE_NAME=/data/tubeshelf.db` is set directly in `environment:` (not left to
  `src/db/client.ts`'s `./data/tubeshelf.db` relative-path default) so it points at the
  bind-mounted absolute path `/data` rather than a path relative to the container's
  `WORKDIR`. Deployment docs tell the reader to change the *left*-hand side of the
  `./data:/data` volume mapping if they want the host-side data directory somewhere else,
  never the right-hand `/data` — that side matches `DB_FILE_NAME` and is not meant to be
  edited per-deployment.
- Bind mount (`./data:/data`), not a named volume — per the feature file's resolved
  decision, so a reader's backup procedure is "copy the file(s) out of `./data`," no
  `docker volume inspect`/`docker cp` detour needed.
- Healthcheck command uses `bun -e` to make the HTTP request itself rather than `curl`/
  `wget` — `oven/bun:1-alpine` isn't guaranteed to ship either, and there's no reason to add
  a package just for this when Bun can do it directly.
- `start_period: 15s` gives the container's migration-on-boot + seed step room to finish
  before an unready response starts counting toward `retries`.
- `ports: ["3000:3000"]` is a documented example, not a fixed requirement — `docs/DEPLOYMENT.md`
  tells the reader they can freely change the host-side (left) port; the container-side
  (right) `3000` should stay matched to `EXPOSE 3000`/`Bun.serve({ port: 3000 })` in
  `src/index.ts`, which this spec does not change.
- `env_file: [.env]` keeps `AUTH_RECOVERY_PASSWORD`/`TRUSTED_ORIGINS` out of
  `docker-compose.yml` itself; `docs/DEPLOYMENT.md` tells the reader to create their own
  `.env` (gitignored already) from a checked-in `.env.example`.

### Startup migration failure handling (`src/index.ts`)

```ts
try {
  runMigrations();
} catch (err) {
  console.error("Database migration failed:", err);
  console.error(
    "The database may be partially migrated: each migration file runs in its own " +
      "transaction, so an earlier file's changes are not automatically undone by a " +
      "later file's failure. Restore your previous container image and/or your most " +
      "recent database backup, then retry.",
  );
  process.exit(1);
}
console.log("Migrations complete.");
```

`process.exit(1)` is called explicitly after the guidance is printed, rather than
re-throwing and letting it surface as an uncaught exception — an uncaught throw would still
exit non-zero, but Bun would also print its own raw stack trace *after* the friendly
message, defeating the point of adding one. This is a message-quality change only: an
uncaught throw from `runMigrations()` already crashes the process (non-zero exit) before
`Bun.serve()` runs today, so "the app refuses to boot on a bad migration" is existing
behavior, not new behavior introduced by this spec.

### `GET /healthz` (`src/routes/health.ts`, new file)

```ts
import { Hono } from "hono";
import { sqlite } from "../db/client";

export const healthRoute = new Hono();

healthRoute.get("/healthz", (c) => {
  try {
    sqlite.query("SELECT 1").get();
    return c.text("ok", 200);
  } catch {
    return c.text("unhealthy", 503);
  }
});
```

Mounted in `src/index.ts` via `app.route("/", healthRoute)`, alongside the existing route
mounts. Every existing protected route file applies its own `csrfCheck`/`requireAuth`
middleware locally (confirmed: `queueRoute.use("*", csrfCheck, requireAuth)` in
`src/routes/queue.tsx`, `authRoute.use("*", csrfCheck)` in `src/routes/auth.tsx` — there is
no global auth/CSRF middleware applied at the `app` level in `src/index.ts`). `healthRoute`
simply never calls `.use(...)`, so it's outside both by construction — no bypass logic is
needed, and there's nothing to accidentally leave unprotected on some other route by
contrast, since every other route file's protection is opt-in the same way.

Queries the raw `sqlite` handle directly (`src/db/client.ts`'s exported `bun:sqlite`
`Database` instance) rather than going through `db` (the drizzle wrapper), to keep the
check as cheap as possible. WAL mode (`PRAGMA journal_mode = WAL`, already set in
`client.ts`) allows concurrent readers alongside the scheduler's writes, so this read never
contends with ingestion.

### Test coverage

- `test/routes/health.test.ts` (new): asserts `GET /healthz` returns `200` with a working
  DB. A failure-path test (DB unreachable) is not practical to add cheaply — the route's
  `catch` branch is exercised by closing/corrupting the `bun:sqlite` handle mid-test, which
  risks destabilizing whatever test file runs next against the same shared pattern other
  test files use; left uncovered by an automated test, relying on the `try`/`catch`'s
  correctness being obvious from inspection instead.
- No automated test is added for the `runMigrations()` try/catch — triggering a genuine
  migration failure requires a malformed migration file, which isn't something worth
  fabricating just to exercise a `console.error` + `process.exit(1)` path. Verified manually
  instead (left to `/spec-tasks`' manual-verification section).
- The Dockerfile/`docker-compose.yml`/`docs/DEPLOYMENT.md` have no automated test surface by
  nature — verification is manual (building the image, running the compose stack, hitting
  `/healthz`, confirming the bind mount survives a container recreate). `/spec-tasks` should
  build this out as this spec's "Manual end-to-end verification" section per CLAUDE.md's
  convention.

### Operational note: building/running the production image doesn't go through the devcontainer

CLAUDE.md's `devcontainer exec --docker-path podman ...` pattern is specific to running
*this project's own dev tooling* (`bun test`, `bun run lint`, etc.) inside the `oven/bun:1`
devcontainer image, because `bun` isn't installed on the host. Building and running *this
spec's* production Dockerfile/`docker-compose.yml` is a different, unrelated use of
Docker/podman — it happens directly on the host via plain `podman build`/`podman compose`
(or `docker`, `docker compose`, for a reader who has Docker rather than podman), since
`podman` itself is already present on the host (it's what backs `devcontainer up
--docker-path podman` in the first place). `/spec-tasks` and `/work-task` should treat these
as two separate container invocations, not conflate "run it in the devcontainer" with "build
the deployment image."

### `.env.example`

Rewritten to document all three vars the app reads, each with a one-line comment, grouped
under a short heading per var rather than the current two-var ad hoc layout:

```
# DB_FILE_NAME: path to the SQLite database file. Defaults to ./data/tubeshelf.db if unset.
# In docker-compose.yml this is set to /data/tubeshelf.db to match the bind mount — leave
# unset for local dev.
# DB_FILE_NAME=./data/tubeshelf.db

# AUTH_RECOVERY_PASSWORD: if set, applied to the admin user's password on every startup.
# Use only to recover access after a lost password; leaving it set overwrites any UI-set
# password on next restart. Not required for MVP if you don't need recovery.
# AUTH_RECOVERY_PASSWORD=your-recovery-password

# TRUSTED_ORIGINS: comma-separated list of exact scheme://host[:port] origins allowed for
# CSRF-protected requests. Defaults to http://localhost:3000 if unset. In production, set
# this to whatever public origin(s) your reverse proxy fronts the app with.
# TRUSTED_ORIGINS=http://localhost:3000,https://tubeshelf.example.com
```

### `docs/DEPLOYMENT.md` (new)

Sections, per the feature file's resolved scope:
1. **Quick start** — clone, create `.env` from `.env.example`, `docker compose up -d`.
2. **Configuration** — table of the three env vars (cross-referencing the rewritten
   `.env.example`).
3. **Initial login** — `AUTH_RECOVERY_PASSWORD` is currently the only way to set a
   password; walk through setting it, logging in, then unsetting it (real signup/password
   reset is v2.0, per `docs/app_idea.md`'s Future Roadmap).
4. **Bind-mount permissions** — the container runs as the non-root `bun` user; `chown` the
   host `./data` directory to match before first run. (`PUID`/`PGID` support is noted as
   deferred, with a pointer to the Future Roadmap entry.)
5. **Backups** — WAL mode means a live DB is `tubeshelf.db` plus `-wal`/`-shm`; stop the
   container, then copy all three files. Explains *why* (a live copy of just the main file
   can be inconsistent) rather than just asserting the steps.
6. **Updating** — `docker compose pull && docker compose up -d --build` for now (source
   build, no registry yet — this section gets revisited once Path to v1.0 step 5 publishes
   an image, at which point `pull` alone becomes accurate without `--build`).
7. **Reverse proxy** — prose only, no example configs for a specific tool (per the feature
   file's resolved decision): explains that a reverse proxy is the reader's own
   responsibility, and that `TRUSTED_ORIGINS` must list whatever public origin(s) they front
   the app with, or CSRF-protected requests will be rejected.

### `README.md`

New short "Deployment" section (separate from the existing "Development" section), a few
sentences pointing at `docs/DEPLOYMENT.md` rather than duplicating its content.

## Open Questions

None remaining — the feature file's `/new-feature` pass resolved the three genuine
ambiguities (runtime base image, `/healthz` depth, reverse-proxy doc depth) via
`AskUserQuestion`; this spec's Design section resolves the remaining mechanical questions
(exact Dockerfile/compose shape, code changes, doc outline) directly, as each had a single
clearly-correct answer given those resolved decisions rather than a further tradeoff to
weigh with the user.

**Red-team retrospective:** One independent pass (general-purpose agent, no memory of the
drafting conversation) was run against the first draft — it went further than a read-only
review, actually building the drafted Dockerfile with `podman build` and running the
resulting image. It caught one critical bug: the runtime stage's `COPY` list omitted
`tsconfig.json`, so Bun couldn't resolve the `hono/jsx` JSX transform for any `.tsx` file at
runtime and the container crashed immediately on boot (`Cannot find module
'react/jsx-dev-runtime'`) — reproduced directly, then confirmed fixed by adding
`tsconfig.json` to that `COPY` line (rebuilt image boots, migrates, seeds, and serves
cleanly). Fixed in the Dockerfile snippet and its Notes above. It also caught one minor
issue: the `USER bun` justification cited `.devcontainer/devcontainer.json`'s
`remoteUser: bun` as evidence, but that file uses the non-alpine `oven/bun:1` tag while the
production Dockerfile uses `oven/bun:1-alpine` — a different image, not "this exact base
image" as originally worded. Fixed by verifying the `bun` user directly against the alpine
tag instead and correcting the citation. Everything else checked (the `USER bun`/`--chown`
question, the `sqlite.query("SELECT 1").get()` API call, the "no global auth/CSRF
middleware" claim, `DB_FILE_NAME` override reasoning, `public/`'s actual contents, the
lockfile format, consistency against the feature file's `Resolved Decisions` and
`docs/app_idea.md`, and the spec numbering/cross-reference) held up under direct
verification. No second full pass was run: the one substantive finding's fix was already
empirically verified (image rebuilt and run successfully) by the same pass that found it,
which stands in for a narrower follow-up check scoped to that fix.
