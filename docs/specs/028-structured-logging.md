---
status: draft
created: 2026-08-22
---

# Structured Logging

## Context

The app currently has no logging convention at all — every call site (`src/index.ts`,
`src/lib/shutdown.ts`, `src/lib/auth.ts`, `src/lib/ingest.ts`, `src/lib/scheduler.ts`,
`src/lib/rss.ts`) uses raw `console.log`/`console.error`/`console.warn` directly, with no
levels, no consistent formatting, and no way to control verbosity. `docs/app_idea.md:70`
already flags this as known-deferred work ("a broader structured-logging pass... log
levels, what's signal vs. noise for ingestion... beyond the narrowly-scoped
startup-migration-failure message").

The concrete trigger: `src/lib/rss.ts:94` logs the **raw XML** of every malformed feed
entry via `console.error("skipping malformed feed entry", raw)`. This is doubly noisy —
the raw payload is large and unhelpful (a channel name/URL would be more actionable than a
dump of the entry object), and it fires once *per malformed entry*, so a channel with a
persistently broken feed reprints the same noise every hourly scheduler tick, forever.

Timezone was folded into this spec after discovering, during the design conversation, that
the app is entirely server-rendered (Hono/HTMX) and `src/lib/relative-time.ts` already
calls `date.toLocaleDateString(undefined, ...)` in its final fallback branch (line 17,
used only once a video/watch is 4+ weeks old — the four branches below that, covering
"just now" through "Xw ago", compute purely from an epoch-millisecond difference and are
timezone-independent by construction) — `undefined` locale/timezone resolves to whatever
timezone the *container* runs in, not the viewer's browser. So the container's timezone
already silently determines the *absolute date* shown for older videos/watches (the
month/day fallback), though not the relative "Xh/Xd/Xw ago" text most queue items actually
show. Adding a documented `TZ` env var fixes that gap for the UI at the same time it makes
new log timestamps human-meaningful, for the cost of one env var and no application code
changes (see Design).

## Scope

**In scope:**
- A new `src/lib/logger.ts` module with four levels (`debug`/`info`/`warn`/`error`), a
  `LOG_LEVEL` env var to filter verbosity, and a `LOG_FORMAT` env var to switch between
  human-readable text (default) and JSON output.
- Converting every existing `console.*` call site in the six files listed above to use the
  new logger, including the specific `rss.ts` fix (drop the raw XML, log channel identity,
  collapse per-entry noise into one count-based line per fetch).
- A documented `TZ` env var (e.g. `TZ=America/Chicago`), affecting both new log timestamps
  and the existing (unmodified) UI date rendering in `relative-time.ts`.
- Doc updates: `README.md`, `docs/DEPLOYMENT.md`, `.env.example` for all three new/newly-
  documented env vars (`LOG_LEVEL`, `LOG_FORMAT`, `TZ`).
- Unit tests for `logger.ts` (level filtering, format switching, error-value rendering).

**Explicitly out of scope (deferred):**
- Adding logging to places that have none today — HTTP request logging, richer auth-event
  logging (login attempts/lockouts beyond the existing recovery-password warning). This
  pass only cleans up and standardizes existing call sites.
- Shipping logs to an external aggregator (Loki, CloudWatch, etc.). The JSON format is
  prep for that possibility, not an integration.
- Any change to how timestamps are *stored* — out of scope because, per Design below,
  nothing needs to change there.
- The `/etc/localtime` bind-mount pattern for timezone configuration — evaluated and
  rejected in favor of `TZ` (see Design).

## Design

### Logger API

`src/lib/logger.ts` exports `logger.debug`/`logger.info`/`logger.warn`/`logger.error`, each
`(message: string, meta?: Record<string, unknown>) => void`. `meta` is always a plain
structured object — context is never string-interpolated into `message`. This is the
detail that keeps a future JSON renderer cheap: the same call site produces good output in
either format, because the message and its structured context are already separated at the
call site, not just at render time.

### Levels and `LOG_LEVEL`

Order: `debug` < `info` < `warn` < `error`. `LOG_LEVEL` (default `info`) sets the minimum
level that prints; anything below it is a no-op. `debug` is the escape hatch for verbose
detail (e.g. would-be per-entry parse failure detail) that stays off by default and gets
turned on only while actively troubleshooting.

`info`/`debug` write to stdout, `warn`/`error` write to stderr — matching the
stdout/stderr split the existing raw `console.*` calls already use, and independent of
`LOG_FORMAT` (both formats keep the same stream split).

### `LOG_FORMAT`: text (default) vs. json

- **text**: `<timestamp> [<LEVEL>] <message> key=value key2=value2` — meta entries appended
  as space-separated `key=value` pairs.
- **json**: one JSON object per line — `{"time": ..., "level": ..., "message": ...,
  ...meta}`.

Both formats are built now (not just the text one, with JSON "planned"), since the real
cost — separating message from structured context at every call site — is identical either
way and is already required for the text format alone. There is no meaningful "lift" being
deferred by building both now.

### Timestamps and `TZ`

Log lines use a local-time timestamp, not `Date.prototype.toISOString()` — `toISOString()`
is defined to always render UTC regardless of `process.env.TZ`, which would silently defeat
half the point of adding `TZ` (log lines would stay UTC while the UI's dates shift). Instead
the logger formats via `Intl.DateTimeFormat` with explicit numeric field options (not
`toLocaleString()`'s locale-dependent default formatting, which varies by system locale, not
just timezone) into a fixed, sortable, **offset-bearing** RFC 3339 layout —
`YYYY-MM-DDTHH:mm:ss±HH:mm` (e.g. `2026-08-22T11:37:33-05:00`). The offset comes from
`Intl.DateTimeFormat`'s `timeZoneName: "longOffset"` option (confirmed working in this
project's actual runtime image — see below), stripped of its `GMT` prefix. One timestamp
format is used for both `LOG_FORMAT` values (text and json) rather than a bare local time in
text and a separately-labeled zone in json: an explicit numeric offset is self-describing
and unambiguous either way, whereas a text-only bare local time (no offset) would silently
assume the reader remembers what `TZ` is currently set to — a weaker guarantee for
scrollback pasted elsewhere (e.g. into a GitHub issue) than it sounds for a homelab app
checked occasionally.

`TZ=<IANA zone name>` (e.g. `America/Chicago`) is the only timezone mechanism this spec
adds — the `/etc/localtime:/etc/localtime:ro` bind-mount pattern seen in some other
containerized apps was considered and rejected:

- Confirmed the container's own default (no `TZ` set) is `UTC` — `/etc/localtime` resolves
  to `Etc/UTC` and `Intl.DateTimeFormat().resolvedOptions().timeZone` reports `UTC` — so the
  checks below aren't just coincidentally matching a pre-existing container zone; they
  demonstrate an actual shift away from that UTC default.
- Confirmed directly against this project's actual runtime image
  (`oven/bun:1-alpine`, per `Dockerfile`) that `TZ=America/Chicago bun -e
  '...toLocaleString()...'` and `...toLocaleDateString()...` both correctly shift output
  by the expected -6h offset, and `Intl.DateTimeFormat().resolvedOptions().timeZone`
  correctly resolves to `America/Chicago` — with **no** `tzdata` package installed and no
  volume mount. Bun statically bundles full ICU/IANA timezone data, so it doesn't depend on
  the (Alpine-stripped) system tzdata at all. Cross-checked against a second, unrelated zone
  (`Pacific/Auckland`, on the opposite side of the world) shifting a fixed UTC instant across
  a calendar day boundary as expected, and against `TZ=UTC` explicitly reproducing the
  no-`TZ` default exactly — three independent zones behaving correctly relative to both each
  other and the known baseline, not one match that could be coincidental.
- The `timeZoneName: "longOffset"` option specifically (the mechanism the unified
  timestamp format above depends on) was also confirmed directly against this same image:
  `TZ=America/Chicago bun -e '...new Intl.DateTimeFormat("en-US", { timeZoneName:
  "longOffset" }).formatToParts(...)...'` returned `GMT-05:00`, and the same command under
  `TZ=UTC` returned `GMT+00:00` — both correctly zero-padded and signed, ready to strip the
  `GMT` prefix from. Not separately tested against a half-hour-offset zone (e.g.
  `Asia/Kolkata`) or across an actual DST transition; `longOffset` is specified to always
  render a padded `±HH:mm` for the resolved instant regardless of offset shape, so this is
  expected to extend correctly, but that expectation itself wasn't independently verified on
  this image.
- `TZ` is a single `.env` line with no host-filesystem dependency, and behaves identically
  across host OSes (the `/etc/localtime` mount assumes a Linux/macOS-shaped host path,
  which doesn't translate to e.g. Windows Docker Desktop).

No `docker-compose.yml` change is needed — `TZ` set in `.env` is already forwarded into the
container via the existing `env_file: - .env` entry, the same as every other configured env
var.

**No code change to `src/lib/relative-time.ts`.** It already calls
`date.toLocaleDateString(undefined, ...)`, and `undefined` locale/timezone already resolves
through the same ICU machinery confirmed above — setting `TZ` shifts its output with zero
application changes (confirmed directly: `TZ=Pacific/Auckland` shifted a UTC 18:00
timestamp across a day boundary in `toLocaleDateString` output, as expected). This spec's
contribution for the UI side is entirely the env var plumbing/documentation, not new code.

### Database impact: none

All timestamp columns in `src/db/schema.ts` use Drizzle's `integer(..., { mode:
"timestamp" })`, which stores a Unix epoch (UTC, timezone-agnostic) under the hood.
`TZ` only affects how an already-UTC instant is *formatted for display* (logs, UI) — never
what gets written to or read from SQLite. Changing `TZ` later (moving servers, changing
preference) is purely cosmetic: every existing row reformats correctly, nothing needs
reprocessing or backfill.

### Error values in log meta

A meta value that is an `Error` renders as just its `.message` by default (`err=<message>`
in text, `"err": "<message>"` in json) — never the stack trace, at any level above `debug`.
When `LOG_LEVEL=debug`, the full `.stack` is included instead (nested under an `errStack`
field in json, appended as a second `errStack=...` text field). This matches the pattern
being applied to `rss.ts`'s raw-XML noise: an error's stack trace is exactly the kind of
large, mostly-unhelpful-by-default text the "short and informative" goal is aimed at,
while still being available on demand for actual troubleshooting.

A meta value under the `err` key that is **not** an `Error` instance (every real call site
receives it from a `catch` clause, where TypeScript types it as `unknown` — a non-`Error`
throw is possible, if unusual) renders via `String(value)`, with no stack-equivalent field
at any level, since there's nothing to extract.

`LOG_LEVEL=debug` deliberately does double duty: it both unlocks `debug`-level lines *and*
switches every visible `warn`/`error` line's error rendering to include the stack trace.
One knob, not two, is an intentional simplification — an operator reaching for `debug`
verbosity is already asking for "give me more troubleshooting detail," and splitting that
into a separate flag would add a second env var for a distinction this project's scope
doesn't need. The tradeoff (turning on `debug` for one narrow thing also verbosifies every
unrelated error for as long as it's set) is accepted, not overlooked.

### Call sites converted

| File | Current | New |
| :--- | :--- | :--- |
| `src/lib/rss.ts:94` | `console.error("skipping malformed feed entry", raw)` — per entry, raw XML | Malformed entries are counted during the parse loop; if `count > 0`, a single `logger.warn("skipped malformed feed entries", { channel: title, url: rssUrl, count })` after the loop — once per fetch, no raw payload by default. (The raw entry may still be worth exposing at `debug` level for deep troubleshooting — see Open Questions.) |
| `src/lib/ingest.ts:111` | `console.error("failed to reschedule channel ${channelId}...", err)` | `logger.error("failed to reschedule channel after ingestion error", { channelId, err })` |
| `src/lib/ingest.ts:139` | `console.error("ingestion failed for channel ${channel.id}", err)` | `logger.error("ingestion failed", { channelId: channel.id, err })` |
| `src/lib/scheduler.ts:55` | `console.error("ingestion tick failed", err)` | `logger.error("ingestion tick failed", { err })` |
| `src/lib/shutdown.ts:14` | `console.log("Received ${signal}, starting graceful shutdown")` | `logger.info("received signal, starting graceful shutdown", { signal })` |
| `src/lib/shutdown.ts:37` | `console.log("Graceful shutdown complete")` | `logger.info("graceful shutdown complete")` |
| `src/lib/shutdown.ts:40` | `console.error("Graceful shutdown timed out after ${timeoutMs}ms, forcing exit")` | `logger.error("graceful shutdown timed out, forcing exit", { timeoutMs })` |
| `src/lib/shutdown.ts:60` | `console.log("Received ${signal} again, shutdown already in progress")` | `logger.info("received signal again, shutdown already in progress", { signal })` |
| `src/lib/auth.ts:46` | `console.warn("AUTH_RECOVERY_PASSWORD was applied...")` | `logger.warn("AUTH_RECOVERY_PASSWORD was applied to the default user's password. Unset this environment variable after use.")` — message text unchanged, just routed through the logger |
| `src/index.ts:19` | `console.error("Database migration failed:", err)` | `logger.error("database migration failed", { err })` |
| `src/index.ts:20-25` | `console.error("The database may be partially migrated...")` | `logger.error("<same operator-guidance text, unchanged>")` — kept verbatim; this is actionable instructions for a human handling an outage, not routine noise, so it's exempt from the "keep it short" goal |
| `src/index.ts:28` | `console.log("Migrations complete.")` | `logger.info("migrations complete")` |
| `src/index.ts:30` | `console.log("Seed complete.")` | `logger.info("seed complete")` |
| `src/index.ts:50` | `console.log("Listening on http://localhost:3000")` | `logger.info("listening", { url: "http://localhost:3000" })` |

### Documentation updates

- `.env.example`: add commented entries for `LOG_LEVEL`, `LOG_FORMAT`, `TZ`, following the
  existing style (short comment, default noted, commented-out example line).
- `docs/DEPLOYMENT.md`: add all three to the Configuration table (§2); a short new
  subsection covering timezone (default is UTC if `TZ` unset — the JS/ICU default —
  noting it affects log timestamps and the absolute date shown for videos/watches 4+ weeks
  old, but not the "Xh/Xd ago" relative text most queue items show, so readers don't expect
  a UI-wide effect it doesn't have).
- `README.md`: no functional change expected beyond a possible one-line mention if it turns
  out to read oddly without one; the detailed configuration reference already correctly
  lives in `docs/DEPLOYMENT.md`, not README.

### Testing

`test/lib/logger.test.ts`, following the existing `test/lib/<name>.test.ts` convention:
level filtering (a `debug` call is a no-op under default `LOG_LEVEL=info`, etc.), format
switching (`LOG_FORMAT=json` produces parseable JSON with expected fields), the
offset-bearing timestamp format under a non-UTC `TZ`, error-value rendering (message-only
by default, stack included under `LOG_LEVEL=debug`, `String(value)` fallback for a
non-`Error` `err`), and the stdout/stderr stream split. Existing tests don't spy on
`console.*` anywhere in `test/` today (confirmed via a repo-wide search of the whole test
tree, not just the six files being converted), so converting call sites doesn't touch any
existing test assertions.

## Open Questions

None currently blocking. One deliberately deferred design detail, noted for whoever writes
the task breakdown: whether `rss.ts`'s malformed-entry warning should include the raw
entry at `debug` level (for deep troubleshooting of a specific bad feed) or omit it
entirely even at `debug`. Leaning toward including it at `debug` only, consistent with the
Error-stack precedent elsewhere in this spec, but left for `/spec-tasks` to pin down rather
than blocking spec approval on it.

**Red-team retrospective:** one independent review pass was run (subagent with no memory of
the drafting conversation, cross-checking every claim against the actual current code). It
found the Context section's stated rationale for bundling `TZ` into this spec was factually
overstated — `relative-time.ts`'s common "Xh/Xd/Xw ago" branches are epoch-diff-based and
timezone-independent; only the ≥4-week absolute-date fallback branch is `TZ`-sensitive —
fixed by narrowing the Context and doc-update wording accordingly. It also flagged the
original JSON-format design (a bare local timestamp plus a separate `timezone` field) as a
non-standard, ambiguity-prone bolt-on compared to a single self-describing offset-bearing
timestamp, which was simpler to just apply to both formats rather than maintain two
timestamp representations; flagged the `LOG_LEVEL=debug` double-duty (unlocking debug lines
*and* stack traces) as an unacknowledged coupling, now called out explicitly as an
intentional simplification; and flagged the missing fallback for a non-`Error` value under
the `err` meta key, now specified (`String(value)`, no stack-equivalent). All four fixed
directly in the sections above. Line numbers, the `db/schema.ts` timestamp-mode claim, the
"no test spies on console" claim, and the full "Call sites converted" table were all
independently verified against the current code and found accurate in this first pass.

A second pass, scoped narrowly to verifying those four fixes rather than re-litigating the
whole spec, confirmed three of the four were correct and internally consistent, and caught
one more real problem: the Timestamps and `TZ` section's confirmation bullets tested
`toLocaleString`/`toLocaleDateString`/`resolvedOptions().timeZone`, but the unified
timestamp design's actual dependency — `Intl.DateTimeFormat`'s `timeZoneName: "longOffset"`
option — was never itself exercised, despite the surrounding text reading as if it had been.
Fixed by actually running that exact command against `oven/bun:1-alpine` (confirmed:
`GMT-05:00` under `TZ=America/Chicago`, `GMT+00:00` under `TZ=UTC`) and citing the real
output, with an honest caveat that a half-hour-offset zone and a live DST transition weren't
separately tested. A third, still-narrower pass re-checking only that one addition found
nothing further, so the review stopped there.
