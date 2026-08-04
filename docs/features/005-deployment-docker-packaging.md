---
status: promoted
created: 2026-08-04
promoted_to: docs/specs/014-deployment-docker-packaging.md
---

# Deployment / Docker Packaging

## Problem / Motivation
Per `docs/app_idea.md`'s "Path to v1.0", step 3 (DB squash + admin rename, spec013) just
reached `implemented`. Step 4 — deployment/Docker packaging — is next: the app has never
been packaged for anything beyond the dev-only devcontainer image
(`.devcontainer/devcontainer.json`, `oven/bun:1`), and needs a production-shaped Dockerfile,
a `docker-compose.yml`, and enough documentation that a self-hoster comfortable with Docker
Compose (not necessarily this project or Bun specifically) can get it running unassisted.
This is deliberately scoped *before* step 5 (GitHub CI/registry image publishing) — there is
no published image yet, so this feature's compose file builds from local source.

## Firm Scope
- **Multi-stage Dockerfile.** Build stage installs full deps (`bun install`, needed for
  `tailwindcss`/`@tailwindcss/cli`, both devDependencies, to run `css:build`) and produces
  the Tailwind CSS bundle; final runtime stage installs only production deps
  (`bun install --production`, which excludes `drizzle-kit`/`biome`/`typescript`/
  `tailwindcss`/`concurrently` — none of which the running app needs, since migrations run
  via `drizzle-orm/bun-sqlite/migrator`'s `migrate()` function directly, not the
  `drizzle-kit` CLI).
- **`docker-compose.yml`** at the repo root: `build: .` (no registry image yet — that's step
  5), `restart: unless-stopped`, a bind mount for the SQLite file(s), the container's port
  bound to the host, and `env_file: .env` (gitignored) rather than inlined secrets.
- **Bind-mounted SQLite storage**, not a named volume — deliberately, so a self-hoster's
  backup is "copy the file(s)," no `docker volume` inspection needed. Path:
  `/data/tubeshelf.db`, matching `src/db/client.ts`'s existing `DB_FILE_NAME` default
  (`./data/tubeshelf.db`) — this is already the code's default, not a new choice.
- **Startup migration failure handling.** Wrap `runMigrations()` in `src/index.ts` in a
  try/catch: on failure, print an actionable message (this DB may be partially migrated —
  drizzle's SQLite migrator wraps each *individual* migration file in its own transaction,
  so a multi-file run can partially apply; restore the previous image and/or your last DB
  backup before retrying) instead of a raw stack trace, then exit non-zero. This is a
  message-quality improvement, not new fail-fast behavior — an uncaught throw already
  crashes the process before `Bun.serve()` runs today.
- **New `GET /healthz` route** — no auth/CSRF middleware (deliberately not reusing the
  login route: spec012's lockout/rate-limiting and CSRF middleware sit on auth routes, and a
  healthcheck hitting that path risks tripping lockout counters or getting a non-200
  depending on session state). Returns `200` only if a cheap DB query succeeds (e.g. a
  direct `SELECT 1` against the `sqlite` handle `src/db/client.ts` exports, bypassing
  drizzle's overhead) — not just process liveness — so it also catches the DB becoming
  unwritable/corrupted sometime after boot (disk full, bind-mount permissions changed),
  which a boot-time-only migration check can't. WAL mode allows concurrent readers alongside
  the scheduler's writes, so this read doesn't contend with ingestion.
- **`.dockerignore`**, new — excludes `node_modules`, `.git`, `test/`, `docs/`, and other
  non-runtime content from the Docker build context.
- **Compose-level `healthcheck` command uses Bun itself**, not `curl`/`wget` — the
  `oven/bun:1-alpine` base isn't guaranteed to ship either, and there's no reason to add a
  package just for this when Bun can make the request itself (e.g.
  `bun -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"`).
- **`.env.example` cleanup** — document every env var the app actually reads
  (`AUTH_RECOVERY_PASSWORD`, `TRUSTED_ORIGINS`, and `DB_FILE_NAME`, which is currently read
  in `src/db/client.ts` but undocumented in `.env.example`), each with a clear one-line
  comment, restructured for readability.
- **`docs/DEPLOYMENT.md`** (new, dedicated doc; short section + link added to `README.md`).
  Written generically for self-hosters in general — not tied to Jon's own NPM +
  Cloudflare Tunnel homelab topology, which is personal infrastructure sitting in front of,
  not part of, this project's compose file. Must cover:
  - Getting the container running via `docker compose up`.
  - **Initial admin password / first login**: `AUTH_RECOVERY_PASSWORD` is currently the only
    way to set a password (multi-user support with a real signup/reset flow is v2.0). Doc
    walks through setting it, logging in, then unsetting it so it stops overwriting any
    UI-set password on next restart (per the existing `.env.example` warning).
  - **Bind-mount permissions**: the container runs as `oven/bun:1`'s non-root `bun` user;
    document `chown`-ing the host `/data` directory to match before first run. (Real
    `PUID`/`PGID` support is deferred — see Explicitly Out of Scope.)
  - **Backups, WAL-mode-aware**: `client.ts` sets `PRAGMA journal_mode = WAL`, so a live DB
    is `tubeshelf.db` plus `-wal`/`-shm` files, and a naive live `cp` of just the main file
    risks an incomplete/inconsistent backup. Doc says: stop the container, then copy all
    three files.
  - **Secrets handling**: use a gitignored `.env` file with compose's `env_file:`, don't
    inline real values into `docker-compose.yml`.
  - Reverse-proxy / `TRUSTED_ORIGINS` note (generic — see Open Questions on exact depth).

## Nice-to-have / Stretch Scope
(none identified — everything discussed either landed in Firm Scope or was deferred to
`docs/app_idea.md`'s Future Roadmap.)

## Explicitly Out of Scope
- **Bun standalone binary** (`bun build --compile`) — needs the `./drizzle` migrations
  folder and `./public` static assets embedded/relocated (both currently read from disk at
  relative paths); its own scoped problem. Added to Future Roadmap (v2.0).
- **`PUID`/`PGID` env var support** for arbitrary host UID/GID — MVP just documents manual
  `chown`. Added to Future Roadmap (v2.0).
- **Graceful shutdown (SIGTERM handling)** for the HTTP server and background RSS-fetch
  scheduler (`src/lib/scheduler.ts`) — low-risk as-is given SQLite WAL mode's commit
  durability. Added to Future Roadmap (v2.0).
- **Broader structured-logging pass** (log levels, ingestion/ignore-rule processing signal
  vs. noise) — out of scope beyond the one narrow migration-failure message above. Added to
  Future Roadmap (v2.0).
- **GitHub CI/CD, release image publishing to a registry** — `docs/app_idea.md`'s Path to
  v1.0 step 5, comes after this feature.
- **`seed()` changes** (`src/db/seed.ts`) — confirmed already idempotent/safe as-is during
  brainstorming; no changes needed.
- **Any actual multi-user support / real password-reset flow** — still v2.0.

## Related Specs / Code
- `docs/app_idea.md` — "Path to v1.0" steps 4–5, §3 (Infrastructure), §5 (Security &
  Auth, NPM + Cloudflare Tunnel deployment topology, `TRUSTED_ORIGINS`), §7 (Maintenance
  Plan), Future Roadmap (v2.0 deferrals just added).
- `.devcontainer/devcontainer.json` — current dev-only Docker pattern (`oven/bun:1`,
  `AUTH_RECOVERY_PASSWORD` marked insecure-by-design/dev-only in its comment).
- `src/index.ts` — boot sequence: `runMigrations()` → `seed()` →
  `applyRecoveryPasswordFromEnv()` → route registration → `startScheduler()` →
  `Bun.serve({ port: 3000, ... })`.
- `src/db/migrate.ts` — `runMigrations()`, synchronous, `drizzle-orm/bun-sqlite/migrator`.
- `src/db/client.ts` — `DB_FILE_NAME` env var (default `./data/tubeshelf.db`), WAL mode,
  `foreign_keys` pragma.
- `src/db/seed.ts` — idempotent seed, confirmed fine as-is.
- `src/lib/auth.ts` — `applyRecoveryPasswordFromEnv`, the `AUTH_RECOVERY_PASSWORD` flow.
- `.env.example` — currently documents `AUTH_RECOVERY_PASSWORD` and `TRUSTED_ORIGINS` only.
- `package.json` scripts/deps — `dependencies` (`drizzle-orm`, `fast-xml-parser`, `hono`)
  vs. `devDependencies` (`drizzle-kit`, `biome`, `typescript`, `tailwindcss`,
  `@tailwindcss/cli`, `concurrently`) — determines what `bun install --production` can skip.
- `docs/specs/012-auth-and-csrf.md` — lockout/CSRF logic a healthcheck route must avoid.
- `README.md` — current Development section; gets a short new Deployment section pointing
  at `docs/DEPLOYMENT.md`.

## Open Questions
(none remaining)

## Resolved Decisions
- **Runtime base image: `oven/bun:1-alpine`.** Smallest option; none of the app's runtime
  deps (`drizzle-orm`, `fast-xml-parser`, `hono`, `bun:sqlite` — the last built into Bun
  itself, not a native npm module) have known musl/alpine issues. Build stage can still use
  a fuller image if needed for the CSS build step.
- **`/healthz` checks DB reachability, not just liveness.** A cheap query catches a DB that
  becomes unwritable after boot; rejected the simpler plain-200 option since the marginal
  cost is negligible and WAL mode means it won't contend with the scheduler's writes.
- **`docs/DEPLOYMENT.md` documents `TRUSTED_ORIGINS` and reverse-proxy responsibility in
  prose only — no example proxy-tool configs.** Avoids the doc going stale against
  Traefik/NPM/Caddy/nginx-specific syntax this project doesn't itself use or test against;
  the app's own responsibility (setting `TRUSTED_ORIGINS` correctly) is the only part that's
  actually this project's to document.
- **No published registry image yet.** `docker-compose.yml` uses `build: .`; switching to a
  published `image:` reference is `docs/app_idea.md`'s Path to v1.0 step 5 (GitHub CI/
  registry), explicitly out of scope here.
- **Bind mount over named volume for SQLite storage**, so backup = "copy the file(s)" with
  no `docker volume inspect` step for the reader.
- **Migration-failure handling is a message-quality change, not new fail-fast behavior** —
  `runMigrations()` in `src/index.ts` already crashes the process (non-zero exit) on an
  uncaught throw before `Bun.serve()` runs; wrapping it in try/catch exists only to replace
  the raw drizzle stack trace with actionable guidance, given drizzle's SQLite migrator
  transactions each migration *file* individually (a multi-file run can partially apply, so
  "just retry" isn't safe advice — "restore your last backup" is).
- **`seed()` needs no changes** — confirmed already idempotent (checks before insert) during
  brainstorming; not reopened during research.
- **Standalone Bun binary, `PUID`/`PGID`, graceful shutdown, and a broader logging pass are
  deferred to `docs/app_idea.md`'s Future Roadmap (v2.0)** — already added there in this
  session's earlier commit (`0d95767`), each with its own one-line why.
