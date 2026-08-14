---
status: in-progress
created: 2026-08-14
---

# Graceful Shutdown

## Context
`docker compose down`/restart sends `SIGTERM` to the container's PID 1, but nothing in
Tubeshelf handles it today — Bun's default signal behavior kills the process immediately,
with no chance to stop accepting new HTTP connections, let an in-flight RSS-ingestion tick
finish, or close the SQLite connection cleanly. This is `docs/app_idea.md`'s "Future
Roadmap (v2.0)" backlog item covering graceful shutdown, previously deferred as low-risk
since WAL mode makes SQLite durable on commit; picked up now to shrink the window where a
routine deploy restart discards in-flight work, not in response to an observed incident.

Promoted from `docs/features/010-graceful-shutdown.md`, where scope, the timeout value, and
signal/logging/exit-code decisions were already settled — see that file's `Resolved
Decisions` for the reasoning behind each. This spec adds the concrete technical design:
module shape, the shutdown sequence's execution structure, and the testing approach.

## Scope

### In scope
- Capture `Bun.serve()`'s return value and `startScheduler()`'s `Timer` handle in
  `src/index.ts` (currently both discarded).
- A new `src/lib/shutdown.ts` module (see Design) providing an injectable, directly
  testable shutdown routine — following the same pattern `src/lib/scheduler.ts` already
  uses (`dueChannels`/`tick`/`runGuardedTick` factored out from the `setInterval` wiring
  specifically so tests don't need real timers).
- `src/lib/scheduler.ts` gains a way to observe/await an in-flight tick from outside the
  module (`waitForSchedulerIdle()`), since the existing `ticking` guard is internal-only.
- One handler registered for both `SIGTERM` and `SIGINT` that: stops the scheduler from
  starting new ticks, concurrently drains in-flight HTTP requests and any in-flight
  scheduler tick under a single shared 8-second deadline, closes the SQLite connection
  regardless of whether the drain finished or timed out, and exits with a code reflecting
  which happened (`0` clean, `1` forced).
- Re-entrancy guard: a second `SIGTERM`/`SIGINT` arriving while shutdown is already in
  progress is ignored (logged, not re-run).
- Shutdown-lifecycle logging via plain `console.log`/`console.error`, matching the
  convention already used in `index.ts`, `scheduler.ts`, `ingest.ts`, `rss.ts`, `auth.ts`.
- Unit tests for the new shutdown routine and the scheduler's idle-await addition.

### Explicitly out of scope
(carried over from the feature file, unchanged)
- The broader structured-logging pass across the rest of the app — this spec only adds
  shutdown-specific logging to the files it touches.
- Health-check-aware draining (`/healthz` reporting unhealthy mid-shutdown). Tubeshelf is a
  single-instance deployment behind NGINX Proxy Manager / a Cloudflare Tunnel, not a
  multi-replica setup behind an active health-check-driven load balancer — there's no
  second instance to shift traffic to.
- Any `Dockerfile`/`docker-entrypoint.sh`/`package.json` `start`-script change. Verified by
  direct test in the devcontainer that `SIGTERM` sent to the outer `bun run start` wrapper
  process is forwarded to and handled by the inner `bun run src/index.ts` process in this
  Bun version — no signal-forwarding fix needed.
- Any change to `docker-compose.yml`'s `stop_grace_period` (left at Docker Compose's
  10s default; the app's own 8s timeout stays safely under it).

## Design

### `src/lib/shutdown.ts` (new)
Exports a single function, structured for testability without real timers or OS signals —
same rationale as `scheduler.ts`'s existing `tick`/`runGuardedTick` split:

```ts
export type ShutdownDeps = {
  server: { stop(): Promise<void> };
  schedulerTimer: Timer;
  waitForSchedulerIdle: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  timeoutMs?: number; // default 8000
};

export async function runShutdown(signal: string, deps: ShutdownDeps): Promise<number> {
  // returns the intended process exit code; caller (createShutdownHandler) calls
  // deps.exit(code)
}

export function createShutdownHandler(
  deps: ShutdownDeps,
): (signal: string) => Promise<void> {
  // returns a handler safe to register directly with process.on(); see below
}
```

`runShutdown`:
1. Logs `"Received <signal>, starting graceful shutdown"`.
2. `clearInterval(deps.schedulerTimer)` — no new scheduler ticks start after this point.
3. Builds `const drain = Promise.all([deps.server.stop(), deps.waitForSchedulerIdle()])`,
   immediately attaches `drain.catch(() => {})` so a rejection reaching it after the race
   below has already settled can't surface as an unhandled rejection, then races `drain`
   against a `deps.timeoutMs`-long (default 8000) `setTimeout`-based timeout promise.
   - **Drain wins:** clears the timeout handle (so a "drain wins" run doesn't leave a
     dangling timer, which matters for unit tests using a short `timeoutMs`), logs
     `"Graceful shutdown complete"`, exit code `0`.
   - **Timeout wins:** logs (via `console.error`) `"Graceful shutdown timed out after
     <timeoutMs>ms, forcing exit"`, exit code `1`. `drain` is *not* cancelled — Bun has no
     API to abort an in-flight `server.stop()`/scheduler tick — it keeps running in the
     background with only the no-op `.catch()` from above attached.
4. Calls `deps.closeDb()` unconditionally, regardless of which branch of step 3 won.
   `bun:sqlite`'s `Database.close()` is documented as safe to call multiple times/already-
   closed (no-op, doesn't throw by default), so no try/catch is needed around it.
5. Returns the exit code from step 3.

**Known side effect of the timeout path:** if `closeDb()` (step 4) runs while the
backgrounded `drain` from step 3 is still resolving (e.g. an abandoned scheduler tick's
query runs against an already-closed connection), `bun:sqlite` throws "database is closed."
Traced through `src/lib/ingest.ts`: `ingestChannel`'s and `safeReschedule`'s existing
try/catch blocks both swallow that error already, so it can't crash the process, but it
will log a `"ingestion failed for channel <id>"` line *after* the `"forcing exit"` line
already printed. This is an expected, harmless artifact of the forced-timeout path, not a
new bug — worth a one-line comment at the `closeDb()` call site so a future reader doesn't
mistake it for one when debugging a real timeout occurrence.

**Why concurrent, single shared deadline:** the feature file's numbered shutdown-steps list
reads sequentially, but combined with its separately-decided "8 seconds total" timeout, a
strictly sequential implementation could let one step's wait eat the whole budget before
the other even starts, or (if each step got its own 8s) blow well past Docker Compose's 10s
`SIGKILL` deadline. Racing both drains together under one shared timer is what actually
honors "8 seconds total" as a bound on the whole routine. Confirmed with the user during
spec-writing (this session) — the feature file's list should be read as the steps'
*content*, not their execution order.

**Whether idle keep-alive connections could inflate the drain past 8s (and so make the
"forced" exit-1 path the common case rather than the exception) was checked empirically in
the devcontainer during spec-writing, not left as a theoretical risk:** a genuinely
idle-but-open keep-alive TCP connection did not block `server.stop()` at all (resolved in
0ms), while a request actively inside its handler correctly held `server.stop()`'s promise
until that handler finished (~2.5s for a 3s artificial delay, response still delivered).
So `server.stop()`'s default (non-force) behavior only waits for genuinely in-flight
request handlers, not idle connections — the 8s budget only needs to cover real
handler/tick work, not however many browser tabs happen to be left open.

**Re-entrancy guard:** `createShutdownHandler(deps)` closes over a `shuttingDown` flag and
returns the actual `(signal: string) => Promise<void>` handler `index.ts` registers with
`process.on()`. Kept as a separate exported factory (rather than inlined in `index.ts`,
per the original feature-file sketch) specifically so it's unit-testable the same way
`scheduler.ts`'s `runGuardedTick` re-entrancy guard already is: construct one instance with
fake `deps`, invoke the returned handler twice back-to-back while the first call's
`runShutdown` is still pending, and assert `deps.server.stop`/`deps.exit` were each only
invoked once.

### `src/lib/scheduler.ts` changes
Add module-level tracking of the in-flight tick's promise, alongside the existing `ticking`
boolean:

```ts
let inFlightTick: Promise<void> | null = null;

export async function runGuardedTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  inFlightTick = tick()
    .catch((err) => { console.error("ingestion tick failed", err); })
    .finally(() => { ticking = false; inFlightTick = null; });
  await inFlightTick;
}

export function waitForSchedulerIdle(): Promise<void> {
  return inFlightTick ?? Promise.resolve();
}
```

### `src/index.ts` wiring
```ts
const server = Bun.serve({ port: 3000, fetch: app.fetch });
const schedulerTimer = startScheduler();

const handleSignal = createShutdownHandler({
  server,
  schedulerTimer,
  waitForSchedulerIdle,
  closeDb: () => sqlite.close(),
  exit: (code) => process.exit(code),
});
process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));
```

### Testing strategy
- `runShutdown` is tested directly with injected fake `server`/`schedulerTimer`/
  `waitForSchedulerIdle`/`closeDb`/`exit`, and a small `timeoutMs` (e.g. 20ms) so both the
  clean-drain and forced-timeout branches are covered in milliseconds, not real 8-second
  waits — same approach `scheduler.test.ts` already uses to avoid real 60s timers.
- `waitForSchedulerIdle`/`inFlightTick` tracking is tested directly in `scheduler.ts`'s
  existing test file, reusing that file's existing mocking convention (`spyOn(globalThis,
  "fetch")` with a manually-controlled pending `Promise`, as already used by the
  `runGuardedTick` re-entrancy test at `test/lib/scheduler.test.ts` — not mocking
  `ingestChannel` directly, which isn't how that file mocks a slow tick today): start a
  tick with the fetch mock left pending, assert `waitForSchedulerIdle()`'s returned promise
  doesn't resolve until the mock is resolved and the tick actually finishes.
- `createShutdownHandler`'s re-entrancy guard is tested directly and deterministically (no
  longer deferred to "if practical" — see the note in Design above): construct a handler
  with fake `deps` whose `server.stop` returns a controllable pending promise, invoke the
  returned handler twice while the first call is still in flight, and assert `deps.exit`
  was called exactly once.
- The no-op `.catch()` attached to the raced-away `drain` promise (added to fix a
  red-team finding — see the retrospective in Open Questions) is itself verified, not just
  assumed to work: a forced-timeout test where the fake `server.stop()`'s promise is left
  rejectable, made to reject *after* `runShutdown()` has already resolved with exit code
  `1`, with a temporary `process.on("unhandledRejection", ...)` listener asserting it never
  fires. Without this test, a future refactor could accidentally drop the `.catch()` with
  nothing catching the regression.
- The 8-second production timeout itself is **not** exercised end-to-end manually — safely
  inducing an 8-second-plus hang in a live server for a manual test isn't practical to do
  reliably, so that path's coverage comes from the unit test's short injected `timeoutMs`
  instead. Manual verification covers the clean-shutdown path only (send a real `SIGTERM`/
  `SIGINT` to the running devcontainer process, confirm log output and exit code `0`) —
  entirely Claude-side per the feature file's resolved decision, since there's nothing
  browser-observable here.

### Product doc cross-reference
`docs/app_idea.md`'s "Future Roadmap (v2.0)" graceful-shutdown line gets an inline pointer
to this spec, matching how the other already-refined v2.0 items in that same list already
point to their specs (`016-handle-url-subscribe.md`, `017-puid-pgid-support.md`).

## Open Questions
None remaining.

**Red-team retrospective (one pass, run before finalizing):** an independent review caught
four real issues, all fixed directly in Design/Testing strategy above rather than left as
follow-ups:
1. Flagged a theoretical risk that idle keep-alive connections could inflate
   `server.stop()`'s drain time past the 8s budget, making the forced-exit path the common
   case rather than the exception. Checked empirically in the devcontainer rather than
   taken on faith — doesn't reproduce in this Bun version (idle connections don't block
   `stop()`; only genuinely in-flight handlers do). Documented as a verified fact in Design
   so a future reader doesn't need to re-derive or re-test it.
2. The re-entrancy guard (a Firm Scope requirement) had no realistic test path as
   originally sketched (inlined in `index.ts`, which nothing imports in tests). Fixed by
   extracting it into an exported `createShutdownHandler` factory in `shutdown.ts`,
   directly unit-testable the same way `scheduler.ts`'s own re-entrancy guard already is.
3. The timed-out side of the `Promise.race` keeps running in the background with nothing
   attached to it, risking an unhandled rejection and a `closeDb()`-vs.-still-running-tick
   interaction. Fixed by attaching a no-op `.catch()` to the raced-away promise and
   documenting the resulting (harmless) stray log line as expected behavior, not a bug.
4. Minor: the "drain wins" branch needed to explicitly clear the timeout handle to avoid a
   dangling timer, and the testing-strategy section named the wrong mock target
   (`ingestChannel` instead of `globalThis.fetch`, which is how `scheduler.test.ts`
   actually mocks a slow tick today). Both corrected.

A second, narrower pass scoped only to these four fixes found nothing further — no second
full pass was run, per the skill's stopping guidance (a pass finding nothing is the
stopping signal; this narrower check substitutes for it here).

**Task-decomposition pass retrospective (during `/spec-tasks`):** writing the task
checklist surfaced one further gap — finding 3's fix (the no-op `.catch()` preventing an
unhandled rejection from the losing race branch) had no corresponding entry in this
spec's own Testing strategy, so the fix existed only as code with nothing to catch a
future regression. Added a Testing strategy bullet (above) requiring a test that
specifically triggers a late rejection after the timeout branch has already won and
asserts no `unhandledRejection` fires.
