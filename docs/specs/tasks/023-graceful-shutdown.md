# Tasks: Graceful Shutdown
Spec: docs/specs/023-graceful-shutdown.md
Generated: 2026-08-14

- [x] 1. Add in-flight-tick tracking to `src/lib/scheduler.ts`. Add a module-level
  `let inFlightTick: Promise<void> | null = null;` alongside the existing `let ticking =
  false;` (currently line 48). Restructure `runGuardedTick()` (currently lines 49-59) to
  set `inFlightTick` to the tick's promise before awaiting it and clear it back to `null`
  in the same `finally`/`.finally()` that already clears `ticking`, per the spec's Design
  section snippet (`docs/specs/023-graceful-shutdown.md` lines ~151-158) — keep the
  existing `// previous tick still in flight -- skip rather than overlap` comment and the
  existing `console.error("ingestion tick failed", err)` handling intact, just add the
  promise tracking around/inside them. Add a new exported function:
  ```ts
  export function waitForSchedulerIdle(): Promise<void> {
    return inFlightTick ?? Promise.resolve();
  }
  ```
  Done when: `waitForSchedulerIdle` is exported from `src/lib/scheduler.ts`, and the two
  existing re-entrancy tests in `test/lib/scheduler.test.ts` (`runGuardedTick's re-entrancy
  guard skips a call made while a tick is still pending` and `runGuardedTick runs normally
  again once the pending tick resolves`) still pass unmodified.

- [ ] 2. Add tests for `waitForSchedulerIdle()` to `test/lib/scheduler.test.ts`, importing
  it alongside the existing `dueChannels`/`runGuardedTick` import (currently line 15).
  Reuse this file's existing `parkAllExistingChannels`/`makeChannel`/`subscribe` helpers and
  the `spyOn(globalThis, "fetch")` + manually-resolved-`Promise` pattern already used by the
  two re-entrancy tests (lines 153-216). Add:
  - A test that `waitForSchedulerIdle()` resolves immediately when no tick is running (e.g.
    `await waitForSchedulerIdle()` completes without needing any mock/await of a pending
    call).
  - A test that while a tick is in flight (fetch mock left pending, mirroring lines 158-171),
    `waitForSchedulerIdle()`'s returned promise does not resolve until the mock is resolved
    and the tick actually finishes — e.g. race it against a short `Promise` that resolves on
    a microtask/short timeout to assert it hasn't settled yet, then resolve the fetch mock
    and confirm it does settle afterward.
  Done when: both new tests pass and `bun test test/lib/scheduler.test.ts` is green.

- [ ] 3. Create `src/lib/shutdown.ts` implementing `ShutdownDeps`, `runShutdown()`, and
  `createShutdownHandler()` exactly per the spec's Design section (`docs/specs/
  023-graceful-shutdown.md` lines 61-142), including:
  - The `drain.catch(() => {})` attached immediately after building
    `Promise.all([deps.server.stop(), deps.waitForSchedulerIdle()])`, before racing it
    against the timeout.
  - Clearing the timeout's handle on the "drain wins" branch.
  - A one-line comment at the `deps.closeDb()` call site noting that on the forced-timeout
    path a still-running abandoned tick may log a `"ingestion failed for channel <id>"`
    line afterward due to the closed DB connection — expected, not a bug (per the spec's
    "Known side effect of the timeout path" note).
  - `runShutdown`'s two log lines (`"Received <signal>, starting graceful shutdown"` /
    `"Graceful shutdown complete"` via `console.log`, `"Graceful shutdown timed out after
    <timeoutMs>ms, forcing exit"` via `console.error`), matching the plain
    `console.log`/`console.error` convention used in `src/index.ts`/`src/lib/scheduler.ts`.
  - `createShutdownHandler`'s `shuttingDown` closure variable and its own log line when a
    second signal arrives mid-shutdown (`"Received <signal> again, shutdown already in
    progress"`).
  Done when: `src/lib/shutdown.ts` exists, exports `ShutdownDeps`, `runShutdown`, and
  `createShutdownHandler`, and `bunx tsc --noEmit` passes with no errors from this file.

- [ ] 4. Create `test/lib/shutdown.test.ts` (new file, no DB/migration setup needed since
  `runShutdown`/`createShutdownHandler` take fully injected `deps` and never touch
  `src/db/client.ts`). Cover, using `bun:test`'s `test`/`expect` and manually-controlled
  `Promise`s (same style as `test/lib/scheduler.test.ts`'s pending-fetch pattern, not real
  timers):
  - Clean-drain path: fake `server.stop()` and `waitForSchedulerIdle()` both resolve
    quickly; assert `runShutdown()` resolves to exit code `0`, and that `closeDb` was
    called.
  - Forced-timeout path: fake `server.stop()`/`waitForSchedulerIdle()` left pending
    indefinitely, `timeoutMs` set small (e.g. `20`); assert `runShutdown()` resolves to
    exit code `1`, and that `closeDb` was still called despite the drain never finishing.
  - `createShutdownHandler`'s re-entrancy guard: fake `server.stop()` returns a controllable
    pending promise; invoke the returned handler twice back-to-back before resolving it;
    assert the injected `exit` fake was called exactly once (not twice) once the pending
    promise is resolved and both handler calls have settled.
  - No-unhandled-rejection regression test (per the spec's Testing strategy — added during
    task-file review since the original Design fix had no test guarding it): use a fake
    `server.stop()` whose promise is rejectable but not yet rejected, small `timeoutMs`
    (e.g. `10`) so the timeout branch wins first; after `runShutdown()` resolves with exit
    code `1`, register a temporary `process.on("unhandledRejection", ...)` listener, reject
    the fake `server.stop()`'s promise, `await Bun.sleep(10)` (or similar) to let it
    propagate, then assert the listener never fired before removing it with
    `process.off(...)`.
  Done when: all new tests pass and `bun test test/lib/shutdown.test.ts` is green.

- [ ] 5. Wire `src/index.ts` per the spec's `src/index.ts` wiring snippet (`docs/specs/
  023-graceful-shutdown.md` lines 165-179): capture `Bun.serve(...)`'s return value into
  `const server = ...` (currently line 47, discarded) and `startScheduler()`'s return value
  into `const schedulerTimer = ...` (currently line 45, discarded); import
  `createShutdownHandler` from `./lib/shutdown` and `waitForSchedulerIdle` from
  `./lib/scheduler` (added to the existing `startScheduler` import on line 7); import
  `sqlite` from `./db/client` (added to the existing `db` import on line 3); construct
  `handleSignal` via `createShutdownHandler({ server, schedulerTimer, waitForSchedulerIdle,
  closeDb: () => sqlite.close(), exit: (code) => process.exit(code) })`; register both
  `process.on("SIGTERM", () => void handleSignal("SIGTERM"))` and `process.on("SIGINT", ()
  => void handleSignal("SIGINT"))`, matching the existing `void runGuardedTick()`
  fire-and-forget style already used in `src/lib/scheduler.ts`. Preserve the existing
  `console.log("Listening on http://localhost:3000")` line's behavior (still logs once the
  server starts). Done when: `bunx tsc --noEmit` passes with no errors and `bun run dev`
  (or `bun run start`) still starts the server successfully.

- [ ] 6. Full verification suite. Via `devcontainer exec --docker-path podman
  --workspace-folder .`, run `bun test`, `bun run lint`, and `bunx tsc --noEmit` — all three
  must pass clean across the whole repo (not just the files touched above). Done when: all
  three commands exit 0 with no errors/warnings.

- [ ] 7. Manual end-to-end verification. Per the spec's resolved decision, this feature has
  no browser-observable behavior, so verification is **entirely Claude-performed** — there
  is no "user performs live in a browser" part for this task, unlike most other specs'
  manual-verification sections.

  **Claude performs directly**, via `devcontainer exec --docker-path podman
  --workspace-folder .`:
  - Start the app (`bun run start` or `bun run dev`, backgrounded) inside the container and
    confirm it's listening (e.g. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/healthz`
    returns `200`).
  - Find its PID (per the CLAUDE.md gotcha: `grep -l src/index.ts /proc/[0-9]*/cmdline`, or
    track the backgrounded shell's PID directly) and send `SIGTERM` via `kill -TERM <pid>`.
    Confirm stdout shows, in order: `"Received SIGTERM, starting graceful shutdown"` then
    `"Graceful shutdown complete"`, and the process's actual exit code is `0` (e.g. via
    `wait <pid>; echo $?` if backgrounded from the same shell, or `podman exec` + checking
    the process is gone via the `/proc` PID check).
  - Repeat the same start/verify sequence, this time sending `SIGINT` (`kill -INT <pid>`)
    instead, and confirm the equivalent `"Received SIGINT, ..."` log sequence and exit code
    `0`.
  - Send two signals back-to-back (e.g. `kill -TERM <pid>; kill -TERM <pid>` immediately
    after each other) and confirm the second one logs `"Received SIGTERM again, shutdown
    already in progress"` rather than restarting the sequence, and the process still exits
    cleanly exactly once.
  - The 8-second forced-timeout path is intentionally **not** exercised here (per the
    spec's Testing strategy — not practical to safely induce live) — its coverage is the
    unit test from task 4.

  Done when: all four signal scenarios above show the expected log sequence and exit
  behavior.

- [ ] 8. Update `docs/specs/023-graceful-shutdown.md` frontmatter to `status: implemented`.

- [ ] 9. Open the PR: branch `spec/graceful-shutdown` (already created and holding the
  feature file and spec commits), push, and open a GitHub PR with a summary + test plan
  covering tasks 6-7 above. Per CLAUDE.md, check this box *before* pushing so the pushed
  branch and opened PR both reflect a fully-checked-off task file.
