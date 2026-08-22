# Tasks: Structured Logging
Spec: docs/specs/028-structured-logging.md
Generated: 2026-08-22

- [x] 1. Create `src/lib/logger.ts` implementing the module per the spec's Design section.
  Export a single `logger` object (not standalone functions — this makes it directly
  spyable in tests via `spyOn(logger, "warn")` etc., needed by task 4):
  ```ts
  export const logger = {
    debug(message: string, meta?: Record<string, unknown>): void { ... },
    info(message: string, meta?: Record<string, unknown>): void { ... },
    warn(message: string, meta?: Record<string, unknown>): void { ... },
    error(message: string, meta?: Record<string, unknown>): void { ... },
  };
  ```
  Implementation details, all from the spec's Design section:
  - Level order `debug < info < warn < error`; read `process.env.LOG_LEVEL` (default
    `"info"`) once per call (not cached at module load — so tests can mutate
    `process.env.LOG_LEVEL` between assertions) to decide whether a call is a no-op.
  - Read `process.env.LOG_FORMAT` (default `"text"`) the same way, per call, to pick the
    renderer.
  - `debug`/`info` write via `console.log` (stdout); `warn`/`error` write via
    `console.error` (stderr) — independent of `LOG_FORMAT`.
  - Timestamp: build via `Intl.DateTimeFormat` with explicit numeric field options (year,
    month, day, hour, minute, second, `hourCycle: "h23"`) plus a second
    `Intl.DateTimeFormat(..., { timeZoneName: "longOffset" })` call to get the `GMT±HH:mm`
    string, strip the `GMT` prefix, and join into `YYYY-MM-DDTHH:mm:ss±HH:mm`. Use this
    exact same timestamp string in both `LOG_FORMAT` values (no separate handling per
    format).
  - text format: `` `${timestamp} [${LEVEL}] ${message}` `` followed by
    `key=value` for each `meta` entry (space-separated), level uppercased.
  - json format: `JSON.stringify({ time: timestamp, level, message, ...meta })` as one
    line.
  - Meta value handling (applies in both formats, before the value is stringified/
    JSON-serialized): if a meta value is `instanceof Error`, replace it with just its
    `.message` under the *same* key, UNLESS `process.env.LOG_LEVEL === "debug"`, in which
    case also add a sibling `<key>Stack` entry (e.g. `err` → adds `errStack`) holding
    `.stack`. If a meta value under a key ending in `err`-like usage is some other
    non-`Error` value, no special handling needed — plain values pass through as-is. (The
    spec's "non-`Error` `err` fallback" — `String(value)` — only applies if the value
    itself isn't already a plain serializable value; in practice every real call site
    either passes an `Error` or nothing under `err`, so implement the `Error`-detection
    branch and let everything else fall through to normal serialization, which already
    produces reasonable output for a string/number/etc.)
  Done when: `src/lib/logger.ts` exists, exports `logger` with all four methods, and
  `bunx tsc --noEmit` (via `devcontainer exec --docker-path podman --workspace-folder .`)
  passes with no errors from this file.

- [x] 2. Create `test/lib/logger.test.ts` (new file, no DB setup needed — `logger.ts` has
  no DB dependency). Use `bun:test`'s `test`/`expect`/`spyOn`, and
  `beforeEach`/`afterEach` to save/restore `process.env.LOG_LEVEL` and
  `process.env.LOG_FORMAT` (delete them in `afterEach` so tests don't leak env state into
  each other or into other test files run in the same process). Cover:
  - Level filtering: with `LOG_LEVEL` unset (default `info`), `spyOn(console, "log")` and
    confirm `logger.debug("x")` does not call it, while `logger.info("x")` does. With
    `LOG_LEVEL=debug`, confirm `logger.debug("x")` does call it.
  - Level ordering at the top end: with `LOG_LEVEL=error`, confirm `logger.warn("x")`
    (spy on `console.error`) does NOT log, but `logger.error("x")` does.
  - Format switching: with `LOG_FORMAT=json` (default `LOG_LEVEL`), spy on
    `console.log`, call `logger.info("hello", { foo: "bar" })`, and assert the captured
    string `JSON.parse`s to an object containing `message: "hello"`, `foo: "bar"`, and a
    string `time` field.
  - Text format default: call `logger.info("hello", { foo: "bar" })` with no `LOG_FORMAT`
    set, assert the captured string contains `"[INFO]"`, `"hello"`, and `"foo=bar"`.
  - Timestamp offset format: with `TZ=America/Chicago` set for the test (save/restore
    alongside `LOG_LEVEL`/`LOG_FORMAT`), assert the logged line's timestamp matches
    `/-\d{2}:\d{2}$/` (a non-UTC negative offset) rather than `+00:00`.
  - Error meta rendering: pass `{ err: new Error("boom") }` to `logger.error`; with
    default `LOG_LEVEL`, assert the output contains `"boom"` but not the literal string
    `"at "` (a stack-trace line prefix) or `errStack`; with `LOG_LEVEL=debug`, assert the
    output now also contains `errStack` (the sibling field task 1's implementation adds
    per the spec's `<key>Stack` convention).
  - Non-`Error` fallback: pass `{ err: "not an error object" }` to `logger.error`, assert
    the output contains that string without throwing.
  - Stream split: `spyOn(console, "log")` and `spyOn(console, "error")` together; confirm
    `logger.debug`/`logger.info` call only the `console.log` spy and `logger.warn`/
    `logger.error` call only the `console.error` spy, for both `LOG_FORMAT` values.
  Done when: `bun test test/lib/logger.test.ts` passes (via `devcontainer exec
  --docker-path podman --workspace-folder .`).

- [x] 3. Convert `src/lib/rss.ts`'s malformed-entry handling (currently line 94:
  `console.error("skipping malformed feed entry", raw);`, inside the `for (const raw of
  entryList)` loop at lines 89-96). Add `import { logger } from "./logger";` at the top.
  Replace the loop body's `else` branch and add post-loop handling:
  ```ts
  const entries: FeedEntry[] = [];
  let malformedCount = 0;
  for (const raw of entryList) {
    const entry = parseEntry(raw);
    if (entry) {
      entries.push(entry);
    } else {
      malformedCount++;
      logger.debug("malformed feed entry", { channel: title, url: rssUrl, raw });
    }
  }
  if (malformedCount > 0) {
    logger.warn("skipped malformed feed entries", {
      channel: title,
      url: rssUrl,
      count: malformedCount,
    });
  }
  ```
  This resolves the spec's Open Question: the raw entry is preserved at `debug` level
  only (silent by default, available on demand), while the default-visible line is the
  count-based `warn` with no raw payload. No other change to `fetchChannelFeed`. Done
  when: `src/lib/rss.ts` contains no `console.*` calls, `bunx tsc --noEmit` passes, and
  the existing `test/lib/rss.test.ts` suite still passes unmodified (it doesn't assert on
  log output today).

- [x] 4. Add a new test to `test/lib/rss.test.ts` verifying task 3's behavior. Reuse this
  file's existing `spyOn(globalThis, "fetch").mockResolvedValue(new Response(xml, {
  status: 200 }))` pattern (see the `"skips a malformed entry without failing the whole
  fetch"` test, lines 59-88) and its malformed-entry fixture shape (an `<entry>` with an
  `id` that isn't a `yt:video:`-prefixed value). Add
  `import { logger } from "../../src/lib/logger";` at the top of the file. Write a new
  test with an XML fixture containing 2 malformed entries (not 1) alongside 1 valid entry:
  `spyOn(logger, "warn")` before calling `fetchChannelFeed(RSS_URL)`, then assert
  `logger.warn` was called exactly once (not twice) with its second argument matching
  `{ channel: "Test Channel", url: RSS_URL, count: 2 }`. Restore the spy in this test (or
  fold into the file's existing `afterEach`, generalizing it to restore both spies) so it
  doesn't leak into other tests in this file. Done when: this new test and the full
  existing `test/lib/rss.test.ts` suite both pass.

- [x] 5. Convert `src/lib/ingest.ts`'s two `console.error` call sites. Add
  `import { logger } from "./logger";` at the top. Replace line 111's
  `` console.error(`failed to reschedule channel ${channelId} after ingestion error`, err); ``
  with `logger.error("failed to reschedule channel after ingestion error", { channelId, err });`.
  Replace line 139's
  `` console.error(`ingestion failed for channel ${channel.id}`, err); `` with
  `logger.error("ingestion failed", { channelId: channel.id, err });`. Done when:
  `src/lib/ingest.ts` contains no `console.*` calls, `bunx tsc --noEmit` passes, and the
  existing `test/lib/ingest.test.ts` suite still passes unmodified.

- [x] 6. Convert `src/lib/scheduler.ts`'s one `console.error` call site (line 55, inside
  `runGuardedTick`'s `.catch()`). Add `import { logger } from "./logger";` at the top.
  Replace `` console.error("ingestion tick failed", err); `` with
  `logger.error("ingestion tick failed", { err });`. Done when: `src/lib/scheduler.ts`
  contains no `console.*` calls, `bunx tsc --noEmit` passes, and the existing
  `test/lib/scheduler.test.ts` suite still passes unmodified.

- [x] 7. Convert `src/lib/shutdown.ts`'s four `console.*` call sites. Add
  `import { logger } from "./logger";` at the top. Replace:
  - Line 14: `` console.log(`Received ${signal}, starting graceful shutdown`); `` →
    `logger.info("Received signal, starting graceful shutdown", { signal });`
  - Line 37: `console.log("Graceful shutdown complete");` →
    `logger.info("Graceful shutdown complete");`
  - Lines 40-42: `` console.error(`Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`); ``
    → `logger.error("Graceful shutdown timed out, forcing exit", { timeoutMs });`
  - Line 60: `` console.log(`Received ${signal} again, shutdown already in progress`); ``
    → `logger.info("Received signal again, shutdown already in progress", { signal });`
  Done when: `src/lib/shutdown.ts` contains no `console.*` calls, `bunx tsc --noEmit`
  passes, and the existing `test/lib/shutdown.test.ts` suite still passes unmodified.

- [ ] 8. Convert `src/lib/auth.ts`'s one `console.warn` call site (lines 46-48, in
  `applyRecoveryPasswordFromEnv`). Add `import { logger } from "./logger";` at the top.
  Replace:
  ```ts
  console.warn(
    "AUTH_RECOVERY_PASSWORD was applied to the default user's password. Unset this environment variable after use.",
  );
  ```
  with:
  ```ts
  logger.warn(
    "AUTH_RECOVERY_PASSWORD was applied to the default user's password. Unset this environment variable after use.",
  );
  ```
  (message text unchanged, per the spec's table). Done when: `src/lib/auth.ts` contains
  no `console.*` calls and `bunx tsc --noEmit` passes. (No existing test directly covers
  `applyRecoveryPasswordFromEnv` — confirmed via repo search — so no test file to check
  here.)

- [ ] 9. Convert `src/index.ts`'s five `console.*` call sites. Add
  `import { logger } from "./lib/logger";` alongside the existing imports. Replace:
  - Line 19: `console.error("Database migration failed:", err);` →
    `logger.error("database migration failed", { err });`
  - Lines 20-25 (the operator-guidance paragraph): replace `console.error(...)` with
    `logger.error(...)`, keeping the message text **verbatim, unchanged** — per the spec,
    this is actionable human guidance, not routine noise, and is exempt from the
    "keep it short" goal.
  - Line 28: `console.log("Migrations complete.");` → `logger.info("migrations complete");`
  - Line 30: `console.log("Seed complete.");` → `logger.info("seed complete");`
  - Line 50: `console.log("Listening on http://localhost:3000");` →
    `` logger.info("listening", { url: "http://localhost:3000" }); ``
  Done when: `src/index.ts` contains no `console.*` calls and `bunx tsc --noEmit` passes.
  (No test imports `src/index.ts` directly — confirmed via repo search — so no test file
  to check here; covered instead by task 13's manual end-to-end verification.)

- [ ] 10. Add `LOG_LEVEL`, `LOG_FORMAT`, and `TZ` to `.env.example`, following the
  existing entries' style (short comment block, default noted, commented-out example
  line). Append after the existing `UMASK` block:
  ```
  # LOG_LEVEL: minimum log level that prints — debug, info, warn, or error. Defaults to
  # info if unset. Set to debug for verbose troubleshooting detail (includes full error
  # stack traces and raw malformed-feed-entry payloads, both hidden above this level).
  # LOG_LEVEL=info

  # LOG_FORMAT: log line format — text (human-readable) or json (one JSON object per
  # line, for log aggregators). Defaults to text if unset.
  # LOG_FORMAT=text

  # TZ: IANA timezone name (e.g. America/Chicago) applied to log timestamps and to the
  # app's own date displays (e.g. the absolute date shown for videos/watches older than 4
  # weeks). Defaults to UTC if unset.
  # TZ=America/Chicago
  ```
  Done when: `.env.example` contains this block and `grep -c '^# [A-Z_]*:' .env.example`
  returns `9` (6 existing + 3 new).

- [ ] 11. Update `docs/DEPLOYMENT.md`: add three rows (`LOG_LEVEL`, `LOG_FORMAT`, `TZ`,
  matching `.env.example`'s wording) to the §2 Configuration table. Add a new short
  subsection after §2 (e.g. "### Timezone and log format") covering: `TZ` defaults to UTC
  if unset; it affects log timestamps and the absolute month/day date shown for
  videos/watches 4+ weeks old, but **not** the relative "Xh/Xd/Xw ago" text most queue
  items show (per the spec's Context section — be explicit about this so readers don't
  expect a UI-wide effect it doesn't have); `LOG_FORMAT=json` is available for log
  aggregator ingestion, `LOG_LEVEL=debug` for verbose troubleshooting (including full
  error stack traces). No change to `README.md` is needed — confirmed it carries no env
  var details today (it just points to `docs/DEPLOYMENT.md`), matching the same precedent
  already set by `PUID`/`PGID`/`UMASK`, which also aren't listed in `README.md`. Done
  when: `docs/DEPLOYMENT.md`'s Configuration table has 8 rows (5 existing + 3 new) and
  the new subsection exists.

- [ ] 12. Run the full verification suite via `devcontainer exec --docker-path podman
  --workspace-folder .`: `bun test`, `bun run lint`, `bunx tsc --noEmit`, and
  `bun run fallow` — all four must pass clean across the whole repo, not just the files
  touched above (per CLAUDE.md's final-verification requirement). Done when: all four
  commands exit 0 with no errors/warnings.

- [ ] 13. Manual end-to-end verification. Per CLAUDE.md's split convention: this spec has
  **no HTMX partial-swap or visual-layout changes** (it's a backend logging/env-var
  change, and the one UI-adjacent effect — the ≥4-week-old absolute-date fallback — is
  server-rendered HTML, fully observable via `curl`), so verification is **entirely
  Claude-performed**, same as spec023's precedent — no "user performs live in a browser"
  part.

  **Claude performs directly**, via `devcontainer exec --docker-path podman
  --workspace-folder .`:
  - Start the app with no `LOG_LEVEL`/`LOG_FORMAT`/`TZ` set (`bun run start`,
    backgrounded); confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/healthz`
    returns `200`; confirm the startup stdout shows text-format lines (`[INFO] migrations
    complete`, `[INFO] seed complete`, `[INFO] listening url=http://localhost:3000`) with
    timestamps ending in `+00:00` (the UTC default). Stop it (find its PID per the
    CLAUDE.md `/proc` gotcha, `kill`).
  - Restart with `TZ=America/Chicago`; confirm the same three startup lines now show a
    timestamp ending in a negative offset (`-05:00` or `-06:00` depending on DST) instead
    of `+00:00`. Stop it.
  - Restart with `LOG_FORMAT=json`; confirm each startup line is valid JSON (e.g. pipe
    through `bun -e 'for await (const l of console) JSON.parse(l)'` or check with `jq`)
    containing `time`/`level`/`message` fields. Stop it.
  - Restart with `LOG_LEVEL=debug`; confirm the app still starts cleanly and the same
    `info`-level startup lines still appear (confirms `LOG_LEVEL` filtering doesn't
    accidentally suppress normal output). Stop it.
  - Re-run the existing spec023-style graceful-shutdown check (start the app, `kill
    -TERM <pid>`, confirm `"received signal, starting graceful shutdown"` then `"graceful
    shutdown complete"` appear and exit code is `0`) to confirm shutdown logging still
    works correctly now that it's routed through `logger` instead of raw `console.*`.
  - TZ effect on UI dates: using a direct SQLite write (per CLAUDE.md's manual-
    verification guidance — a direct DB read/write is Claude-performed, not
    browser-only), insert one video row with `published_at` set to an epoch timestamp
    ~5 weeks in the past (past the 4-week relative-time cutoff in
    `src/lib/relative-time.ts`) into the dev DB. Start the app once with `TZ=UTC` and
    once with `TZ=Pacific/Auckland` (a large, unambiguous offset — same zone already used
    to validate this during spec-writing), `curl` the queue page each time, and confirm
    the rendered absolute date text for that video differs between the two runs in the
    way a day-boundary-crossing UTC timestamp would (matching the direct-script
    confirmation already recorded in the spec's Design section, now confirmed through the
    actual app/DB/HTML path rather than a standalone script). Clean up the inserted test
    row afterward.
  Done when: all six checks above show the expected output, and the test DB is left
  clean (no leftover manually-inserted row).

- [ ] 14. Update `docs/specs/028-structured-logging.md` frontmatter to
  `status: implemented`.

- [ ] 15. Open the PR: branch `spec/structured-logging` (already created and holding the
  spec commit), push, and open a GitHub PR with a summary + test plan covering tasks
  12-13 above. Per CLAUDE.md, check this box *before* pushing so the pushed branch and
  opened PR both reflect a fully-checked-off task file.
