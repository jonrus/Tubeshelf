# Tasks: Deployment / Docker Packaging
Spec: docs/specs/014-deployment-docker-packaging.md
Generated: 2026-08-04

- [x] 1. Add a DB-reachability-checking `GET /healthz` route and mount it. Create
  `src/routes/health.ts`:
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
  In `src/index.ts`, add `import { healthRoute } from "./routes/health";` to the import
  block, alphabetically between `import { channelsRoute } from "./routes/channels";` and
  `import { ignoreRulesRoute } from "./routes/ignore-rules";`. Add
  `app.route("/", healthRoute);` immediately after the existing
  `app.route("/", channelsRoute);` line and before `app.route("/", queueRoute);`. Do not
  add any `.use(...)` middleware to `healthRoute` — per the spec's Design section, every
  other route file opts into `csrfCheck`/`requireAuth` individually, and `/healthz` must
  stay outside both by simply never calling `.use(...)`.
  Done when: `src/routes/health.ts` exists with the exact content above, `src/index.ts`
  imports and mounts it as described, and `bunx tsc --noEmit` (via `devcontainer exec
  --docker-path podman --workspace-folder .`) reports no new errors.
  **Corrected during task 5's live-boot verification:** the mount position specified above
  (after `channelsRoute`) put `healthRoute` behind `categoriesRoute`'s and `channelsRoute`'s
  `.use("*", csrfCheck, requireAuth)` middleware, which — once mounted at `app.route("/",
  ...)` — matches every path in the whole app, not just their own routes. `curl`ing the
  built container's `/healthz` returned a 302 to `/login`, not 200. Fixed by moving
  `app.route("/", healthRoute);` to be the *first* route mount in `src/index.ts`, before
  `authRoute`. See the spec's Design section (`### GET /healthz`) for the full explanation.
  `test/routes/health.test.ts` (task 2) didn't catch this because it exercises `healthRoute`
  in isolation, not through the composed `app`.

- [x] 2. Add a test for the health route from task 1. Create `test/routes/health.test.ts`,
  modeled on the `DB_FILE_NAME`-before-import pattern already used in
  `test/routes/categories.test.ts`:
  ```ts
  import { expect, test } from "bun:test";

  process.env.DB_FILE_NAME = ":memory:";

  const { db } = await import("../../src/db/client");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const { healthRoute } = await import("../../src/routes/health");

  migrate(db, { migrationsFolder: "./drizzle" });

  test("GET /healthz returns 200 when the DB is reachable", async () => {
    const res = await healthRoute.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  ```
  Done when: `bun test test/routes/health.test.ts` (via `devcontainer exec`) passes, and a
  full `bun test` run shows no new failures in other files (this pattern sets
  `DB_FILE_NAME` at module load — same isolation approach `categories.test.ts` already
  relies on, so it should not collide with other test files' own `:memory:` DBs).

- [x] 3. Wrap the startup migration call in `src/index.ts` in a try/catch with actionable
  failure guidance. Replace:
  ```ts
  runMigrations();
  console.log("Migrations complete.");
  ```
  with:
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
  Done when: `src/index.ts` contains this exact try/catch (spot-check the wording matches),
  and `bun test` (via `devcontainer exec`) still passes — this change must not alter
  behavior on the success path, only add error-path handling.

- [x] 4. Add `.dockerignore` at the repo root:
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
  Done when: the file exists at the repo root with exactly these 8 entries.

- [x] 5. Add the production `Dockerfile` at the repo root, per the spec's Design section
  (this exact content already includes the `tsconfig.json` fix found during the spec's
  red-team pass):
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
  This is built and run directly on the host via `podman` (not `devcontainer exec` — per
  the spec's "Operational note," this is a separate use of podman from the project's own
  dev-tooling devcontainer, and `podman` is already present on the host).
  Done when: `Dockerfile` exists at the repo root with this exact content; `podman build -t
  tubeshelf:local .` completes successfully; and running it actually boots and serves
  traffic — not just a content check. This is the exact failure mode the spec's red-team
  pass caught (a missing `tsconfig.json` in the runtime stage crashed the container on boot
  with `Cannot find module 'react/jsx-dev-runtime'`), so don't skip the real run:
  ```
  mkdir -p /tmp/tubeshelf-verify-data && chown 1000:1000 /tmp/tubeshelf-verify-data
  podman run --rm -d --name tubeshelf-verify -p 3000:3000 \
    -e DB_FILE_NAME=/data/tubeshelf.db -v /tmp/tubeshelf-verify-data:/data tubeshelf:local
  curl -i http://localhost:3000/healthz   # expect: 200, body "ok"
  podman stop tubeshelf-verify
  rm -rf /tmp/tubeshelf-verify-data
  ```

- [ ] 6. Add `docker-compose.yml` at the repo root:
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
  Done when: `docker-compose.yml` exists at the repo root with this exact content, and
  `podman compose config` (or `podman-compose config`, whichever is available — check with
  `podman compose version` / `command -v podman-compose` first) parses it without error.

- [ ] 7. Rewrite `.env.example` to document all three env vars the app actually reads:
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
  Done when: `.env.example` matches this content exactly (replacing its current two-var
  version), and `grep -c '^# [A-Z_]*:' .env.example` returns `3`.

- [ ] 8. Write `docs/DEPLOYMENT.md` (new file), covering all 7 sections from the spec's
  Design section outline, each with real prose (not placeholder headers):
  1. **Quick start** — clone the repo, copy `.env.example` to `.env` and fill in values,
     run `docker compose up -d` (or `podman compose up -d`), app listens on the host port
     from `docker-compose.yml`'s `ports:` mapping (`3000` by default — note the reader can
     change the host-side/left number freely, but should leave the container-side/right
     `3000` alone since it must match the app's internal port).
  2. **Configuration** — a table of the three env vars from the rewritten `.env.example`
     (`DB_FILE_NAME`, `AUTH_RECOVERY_PASSWORD`, `TRUSTED_ORIGINS`) with a one-line
     description each, cross-referencing `.env.example` rather than duplicating its full
     comments.
  3. **Initial login** — explain that `AUTH_RECOVERY_PASSWORD` is currently the *only* way
     to set a password (real signup/reset is a v2.0 feature, per `docs/app_idea.md`'s
     Future Roadmap): set it in `.env`, start the container, log in as `admin` with that
     password, then remove `AUTH_RECOVERY_PASSWORD` from `.env` and restart — otherwise it
     will silently overwrite any password set through the UI on every future restart.
  4. **Bind-mount permissions** — the container runs as the image's non-root `bun` user
     (uid `1000`); before first run, `chown -R 1000:1000 ./data` (or equivalent) on the
     host so the container can write `tubeshelf.db` into the bind mount, otherwise it fails
     to boot with a `SQLITE_CANTOPEN` error. Note that automatic `PUID`/`PGID` support is
     deferred (link/reference `docs/app_idea.md`'s Future Roadmap entry for it).
  5. **Backups** — explain that `PRAGMA journal_mode = WAL` means a live database is three
     files (`tubeshelf.db`, `tubeshelf.db-wal`, `tubeshelf.db-shm`), so a backup must: stop
     the container (`docker compose stop` / `podman compose stop`), copy all three files
     from `./data`, then restart. State plainly *why*: copying just the main file while the
     container is running can capture an inconsistent snapshot, since recent writes may
     still be sitting in the `-wal` file.
  6. **Updating** — for now (no published registry image yet — that's a later step on the
     project's roadmap), `git pull && docker compose up -d --build` (or `podman compose up
     -d --build`) to rebuild from updated source. Note this section will change once an
     image is published.
  7. **Reverse proxy** — explain, in prose only (no example config for any specific proxy
     tool), that fronting the app with a reverse proxy/TLS terminator is the reader's own
     responsibility, and that `TRUSTED_ORIGINS` (see Configuration above) must list
     whatever public origin(s) they access the app through, or CSRF-protected
     (state-changing) requests will be rejected.
  Done when: `docs/DEPLOYMENT.md` exists with all 7 sections above present with real prose
  content (not just headers), and `bun run lint` (via `devcontainer exec`) passes (Biome
  doesn't lint Markdown by default, but this confirms the change didn't break anything it
  does check).

- [ ] 9. Add a short "Deployment" section to `README.md`, after the existing "Development"
  section, pointing readers at `docs/DEPLOYMENT.md` rather than duplicating its content —
  e.g.:
  ```markdown
  ## Deployment

  See `docs/DEPLOYMENT.md` for running Tubeshelf as a self-hosted Docker Compose service.
  ```
  Done when: `README.md` contains this (or equivalent short) new section after
  "## Development", linking to `docs/DEPLOYMENT.md`.

- [ ] 10. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo (all via `devcontainer exec --docker-path podman --workspace-folder .`).
  Then do the remaining manual end-to-end verification beyond task 5's basic build/boot
  check — per the spec's "Operational note," this is a separate use of podman directly on
  the host, not `devcontainer exec`:
  - **Claude performs directly** (plain host-shell `podman`/`curl` — the production
    container's published port is a normal podman port mapping, not subject to the
    devcontainer's `forwardPorts` proxy limitation noted in `CLAUDE.md`, so `curl
    http://localhost:<port>` from the host works directly):
    - Confirm the bind-mount permission requirement is real: run the image (built in task
      5; rebuild with `podman build -t tubeshelf:local .` if needed) against a *fresh,
      unowned* host directory (skip `chown`) and confirm it fails to boot with a
      `SQLITE_CANTOPEN`-related error in `podman logs`; then `chown 1000:1000` that
      directory and confirm a retry boots cleanly.
    - Confirm the migration-failure message: in a throwaway copy of the repo (or a temp
      branch), rename one file under `drizzle/*.sql` to break the migration path, rebuild
      the image, run it, and confirm `podman logs` shows the new actionable error message
      (not a raw stack trace) and the container exits non-zero. Revert the throwaway change
      afterward — do not leave `drizzle/` modified.
    - Confirm WAL-mode backup guidance is accurate: with the container running against a
      chowned bind-mounted data dir, confirm `ls` on that host directory shows
      `tubeshelf.db` plus `tubeshelf.db-wal`/`tubeshelf.db-shm` alongside it.
    - Bring the stack up via compose (`podman compose up -d` or `podman-compose up -d`,
      whichever `podman compose version`/`command -v podman-compose` shows is available)
      pointed at a `.env` created from the rewritten `.env.example`; confirm `podman ps`
      shows the healthcheck reporting `healthy` after the `start_period` window, and
      `restart: unless-stopped` is present in the running container's inspect output
      (`podman inspect tubeshelf | grep -i restartpolicy`).
    - Clean up: stop/remove all verification containers/images and any temp directories
      created during this task and task 5.
  - **User performs live in a browser**: not applicable for this spec — there is no
    HTMX/visual/UI-facing change here (the `/healthz` route, Dockerfile, compose file, and
    docs are all infra/container-level), so every check above is verifiable directly via
    `curl`/`podman logs`/the filesystem without a browser.
  - Done when: all three commands (`bun test`, `bun run lint`, `bunx tsc --noEmit`) are
    clean, every Claude-performed check above passes as described, and
    `docs/specs/014-deployment-docker-packaging.md`'s frontmatter is updated to
    `status: implemented`.
