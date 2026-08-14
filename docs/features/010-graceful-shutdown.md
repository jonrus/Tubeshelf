---
status: refined
created: 2026-08-14
---

# Graceful Shutdown

## Problem / Motivation
`docker compose down`/restart sends `SIGTERM`, but nothing in the app handles it — Bun's
default behavior kills the process immediately, with no chance to stop accepting new HTTP
connections, let an in-flight RSS-ingestion tick finish, or close the SQLite connection
cleanly. This is `docs/app_idea.md`'s v2.0 backlog item ("Graceful shutdown (SIGTERM
handling) for the HTTP server and the background RSS-fetch scheduler, so a `docker compose
down`/restart can't kill an in-flight fetch mid-write"), previously deferred as low-risk
since WAL mode makes SQLite durable on commit. Picked up now mainly to reduce the window
where a deploy restart discards in-flight work, not because of any observed incident.

## Firm Scope
- Capture the `Bun.serve()` return value and the `startScheduler()` `Timer` handle in
  `src/index.ts` (currently both discarded — `src/index.ts:45,47`).
- Register one shutdown routine for both `SIGTERM` and `SIGINT` that:
  1. Stops the scheduler from starting new ticks (`clearInterval`).
  2. Stops the HTTP server from accepting new connections and awaits in-flight requests
     draining, via `server.stop()` (confirmed in `node_modules/bun-types/serve.d.ts:844` —
     returns a `Promise<void>`, and by default waits for in-flight requests/connections
     rather than force-closing them).
  3. Awaits any in-flight scheduler tick finishing (`scheduler.ts`'s `ticking` guard exists
     internally already but isn't currently observable from outside the module — needs a
     small export change, e.g. exposing the in-flight tick's promise).
  4. Closes the SQLite connection (`src/db/client.ts`'s `sqlite`, never currently closed).
  5. Exits.
- Bound the whole routine with a hard timeout — if graceful drain isn't done in time, log
  it and force-exit rather than hang.
- Guard against a second `SIGTERM`/`SIGINT` arriving while a shutdown is already in
  progress (e.g. an impatient double Ctrl+C) — must not re-run the sequence or call
  `server.stop()`/`sqlite.close()` a second time.
- Add shutdown-lifecycle logging (start of shutdown, each step completing, timeout/forced
  exit) using the codebase's existing plain `console.log`/`console.error` convention (no
  logging library exists anywhere in `src/` today) — pulled forward from the broader
  "structured logging pass" v2.0 backlog item specifically for this file, per project
  memory on preferring to fold small logging additions into related work rather than
  leaving them all for one big pass.

## Nice-to-have / Stretch Scope
*(none identified)*

## Explicitly Out of Scope
- The broader structured-logging pass across the rest of the app (ingestion/ignore-rule
  signal-vs-noise, log levels) — this feature only adds shutdown-specific logging to the
  files it touches, not a general logging framework.
- Health-check-aware draining (e.g. `/healthz` reporting unhealthy mid-shutdown so a load
  balancer stops routing traffic). Tubeshelf is a single-instance self-hosted deployment
  behind NGINX Proxy Manager / a Cloudflare Tunnel (per `docs/app_idea.md` §5), not a
  multi-replica setup behind an active health-check-driven load balancer, so there's no
  second instance to shift traffic to — this wouldn't do anything.
- Dockerfile/entrypoint changes to bypass the `bun run start` → `bun run src/index.ts`
  wrapper nesting. Confirmed by direct test in the devcontainer (this session) that
  `SIGTERM` sent to the outer `bun run` wrapper process **is** forwarded to and handled by
  the inner script process in this Bun version — no double-`bun run` signal-forwarding
  problem exists here, so `Dockerfile`/`docker-entrypoint.sh`/`package.json`'s `start`
  script need no changes.

## Related Specs / Code
- `src/index.ts:45,47` — `Bun.serve()` and `startScheduler()` calls, return values
  currently discarded.
- `src/lib/scheduler.ts` — `startScheduler()`, `runGuardedTick()`, `ticking` flag,
  `TICK_INTERVAL_MS` (60s), `BATCH_SIZE` (5 channels/tick, sequential `await` per channel
  in `tick()`).
- `src/db/client.ts` — `sqlite` connection (WAL mode), never `.close()`d anywhere in the
  codebase currently.
- `docker-compose.yml` — no `stop_grace_period` set, so Docker Compose's default (10s
  between `SIGTERM` and `SIGKILL`) applies.
- `docs/app_idea.md:69` — the originating v2.0 backlog line.
- `docs/specs/014-deployment-docker-packaging.md:56` — lists graceful shutdown as
  explicitly out of scope for that spec, cross-referencing the same backlog item.

## Open Questions
*(none remaining)*

## Resolved Decisions
- **Shutdown timeout: 8 seconds, `docker-compose.yml`'s `stop_grace_period` left
  unchanged** (Docker Compose's default is 10s between `SIGTERM` and `SIGKILL`). 8s leaves
  a 2s buffer so the app's own forced-exit path always fires before Docker's `SIGKILL`
  would. Chosen over a longer timeout + raised `stop_grace_period`: simpler (no compose
  file change) and doesn't slow down every `docker compose down`; chosen over no hard cap
  because an uncapped wait doesn't actually protect against the failure mode this feature
  exists for (a stuck fetch would still end in an ungraceful `SIGKILL`, just a slower one).
- **Exit code 1 on the forced/timeout shutdown path, 0 on clean shutdown.** Makes an
  incomplete drain visible in container logs and restart-policy tooling as abnormal,
  distinguishable from a normal stop.
- **Handle both `SIGTERM` and `SIGINT` via the same routine.** `SIGTERM` is what Docker
  Compose sends on `down`/restart (the actual driver for this feature); `SIGINT` (Ctrl+C in
  local/dev use) is free to add once the handler exists and helps the dev loop too.
- **Include shutdown-lifecycle logging in this feature now**, using the existing
  plain `console.log`/`console.error` convention already used throughout `src/`
  (`index.ts`, `scheduler.ts`, `ingest.ts`, `rss.ts`, `auth.ts` — no structured logger
  exists), rather than deferring it to the future general logging pass — decided in
  conversation specifically to shrink that later pass's scope.
- **Manual verification for this feature is Claude-side only**, not the project's usual
  Claude-curl / user-browser split — there's no browser-observable behavior here. Claude
  can send the signal to the container process directly and observe stdout/exit behavior
  itself.
- **`Bun.serve()`'s returned `Server.stop(closeActiveConnections?)` already returns a
  `Promise<void>` and defaults to waiting for in-flight requests/connections** (confirmed
  via `node_modules/bun-types/serve.d.ts:836-844`) — the HTTP side of "let in-flight work
  finish" is provided by the runtime itself; the feature just needs to await it under the
  chosen timeout, not hand-roll connection draining.
- **No Dockerfile/entrypoint changes needed for signal delivery.** Verified by direct test
  in the devcontainer: a `SIGTERM` sent to a `bun run <script>` wrapper process (mirroring
  this project's `CMD ["bun", "run", "start"]` → `"start": "bun run src/index.ts"` nesting)
  is forwarded to and received by the inner script process's own `SIGTERM` handler, even
  though `bun run` spawns rather than `exec`s in place.
