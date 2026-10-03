---
status: implemented
created: 2026-10-03
---

# Ingestion & Enrichment Robustness

## Context

A full-codebase review (2026-10-03; tests/lint/tsc/fallow all green, none of the bugs seen
in production) found a cluster of robustness bugs in the RSS-ingestion and YouTube
duration-enrichment paths. This is Round B of a three-spec hardening roadmap (B → C → A);
scope is deliberately limited to ingestion + enrichment. Source of scoping and resolved
decisions: `docs/features/012-ingestion-enrichment-robustness.md`. Related specs:
`003-scheduled-video-ingestion.md`, `025-bun-xml-parser-swap.md`,
`029-video-duration-enrichment.md`. No product-doc (`docs/app_idea.md`) statement is
contradicted, so no edit there.

## Scope

**In:**

1. Non-XML / malformed feeds don't throw; global `app.onError` logs uncaught errors.
2. ISO-8601 durations with a day component parse correctly.
3. Enrichment queue can't be starved by videos the API never resolves
   (`videos.duration_recheck_at`).
4. The bad-API-key latch fires against Google's real invalid-key response; empty
   `YOUTUBE_API_KEY=` counts as disabled.
5. `applyFeedToChannel` is atomic.
6. Feed input is bounded: 2 MiB body cap, strict video-ID validation.

**Out:** Round C / Round A items; channel handle scraping fragility; exponential
backoff or attempt counters for enrichment; retry/backoff for feed fetches (spec003 posture
unchanged); HTMX-aware `app.onError`; backfilling/repairing existing rows with malformed
`youtube_video_id`.

## Design

### 1. Malformed feeds (`src/lib/rss.ts`, `src/index.ts`)

`Bun.XML.parse` throws on non-XML input (verified: `""` and `"hello"` throw `SyntaxError`; a
*well-formed* HTML page like `<html><body>hi</body></html>` does not throw — it parses to
`{html: …}`, so `parsed.feed` is `undefined` and the existing null-return already covers it;
an HTML page with unclosed tags such as `<br>` will likely throw). Wrap
it in try/catch: on failure `logger.warn("Feed is not valid XML", { url, err })` and return
`null`. Guard the parsed root: `const feed = parsed.feed; if (typeof feed !== "object" ||
feed === null) return null;` (an empty `<feed/>` parses to `{ feed: "" }`, a string). This
replaces the current `typeof feed === "object"` ternaries, which let `null` through.

Both subscribe routes (`POST /subscriptions/preview`, `POST /subscriptions`) and
`upsertYoutubeChannel` already map a `null` feed to the friendly `ConfirmError` "Couldn't
fetch that channel's feed." — so no route changes. `ingestChannel` already try/catches, so the
throw only ever affected the subscribe flow, never the scheduler.

Add `app.onError((err, c) => { logger.error("Unhandled request error", { err, method:
c.req.method, path: c.req.path }); return c.text("Internal Server Error", 500); })` in
`src/index.ts` right after `new Hono()`. The handler first passes through
`if (err instanceof HTTPException) return err.getResponse();` (Hono's default behavior; no
`src` code throws `HTTPException` today, but a blanket 500 would silently regress any future
middleware that does). `src/index.ts` runs migrations, seed and `Bun.serve` at module top
level, so the handler is not unit-testable without extracting an app factory — out of scope;
it is verified manually (see Testing). Hono's default already returns a plain-text 500
(via `console.error`), so this is a logging-format improvement (spec028), not a UX change. No
HTMX retarget/reswap special-casing.

### 2. ISO-8601 days (`src/lib/youtube-api.ts`)

Change `(?:\d+D)?` to `(?:(\d+)D)?` and renumber: days = group 1, hours = 2, minutes = 3,
seconds = 4. Total = `days*86400 + hours*3600 + minutes*60 + seconds`; the existing "0 ⇒
null" rule is unchanged (`P0D`, `PT0S`, `P` ⇒ null). `P1DT2H` ⇒ 93600; `P1D` ⇒ 86400.

### 3. Enrichment starvation (`duration_recheck_at`)

`eligibleVideos` takes the newest 50 null-duration videos. Live/upcoming (`P0D` ⇒ null),
deleted, and private videos never resolve, so ≥50 of them permanently occupy the batch and
older resolvable videos starve, each re-requested every minute.

**Schema.** Add nullable `durationRecheckAt: integer("duration_recheck_at", { mode:
"timestamp" })` to `videos` — a "don't re-request before" timestamp (not "last checked") so
one column encodes two different windows. No CHECK constraint, so `drizzle-kit generate`
should emit a plain `ALTER TABLE videos ADD duration_recheck_at integer;` — *not* the table
rebuild spec029's migration needed (that one added a CHECK, which SQLite can't `ALTER`
in). **Verify the generated SQL.** If a rebuild appears anyway, its `INSERT … SELECT` must not
reference the new column (spec029 task 12's phantom-column corruption: SQLite reads an unknown
double-quoted identifier as a string literal). `drizzle-kit generate` may need a real TTY —
hand the user the command rather than running it (see CLAUDE.md). The ingest upsert's `set`
list does not include the column, so re-ingest never clears a stamp.

**Distinguishing "returned but unresolved" from "omitted."** Today
`fetchVideoDurations` returns only `durations: Map<id, seconds>`, so the caller can't tell
`P0D` from an omitted item (both are simply absent). Extend `FetchVideoDurationsResult` with
`returnedIds: Set<string>` — every item `id` present in a successful response, whether or
not its duration parsed. (Items without a string `id` are skipped as today.) Empty on
failure. Implementation order matters: add the `id` to `returnedIds` immediately after the
`id` check, *before* the `continue` for a missing/non-string `contentDetails.duration`.

**Stamping rule.** Only after a *successful* API response (`failure === null`), for each
batch video with no entry in `durations`:

- `returnedIds` has it (API returned the item; duration null — live/upcoming) ⇒
  `duration_recheck_at = now + 1h`. Reasoning: the video exists and will resolve soon (stream
  ends, premiere airs), so a day's lag is needlessly stale.
- `returnedIds` lacks it (deleted/private) ⇒ `now + 24h`. Such videos rarely return, and
  each then costs ≤ 1 batch slot per day.

Resolved videos need no stamp (they leave the null-duration set; any stale stamp is
harmless). Transient failures and the bad-key path never stamp, so those retry next tick
unchanged. Both windows retry indefinitely — no attempt counter. The write loop that sets
resolved durations and the stamps run in one `db.transaction`.

**Eligibility.** `eligibleVideos(now = new Date(), limit = BATCH_SIZE)` adds
`or(isNull(videos.durationRecheckAt), lte(videos.durationRecheckAt, now))`. `now` is
injectable for tests; `runDurationEnrichmentSweep` also accepts an optional `now` and passes
it through (stamping uses the same value). Stamps are stored at whole-second precision
(`mode: "timestamp"`), so tests compare in seconds, not ms. Because stamped rows expire
together, a cohort of unresolvable videos stamped in the same sweep re-enters the pool at the
same time; "no starvation" therefore holds between expiries (older resolvable videos get
through in between), not continuously. Timestamp columns are `mode: "timestamp"`
(seconds), so Drizzle handles the Date conversion in both directions.

**Index.** spec029 deferred a composite index pending `EXPLAIN QUERY PLAN`. Re-run it against
the new predicate during implementation and record the result in the task file; add an index
only if it shows a full-table scan that matters, consistent with spec029's posture.

**Departure from spec029.** spec029 says an unresolved video "stays eligible until it
succeeds"; this spec replaces that with the recheck windows above. Add a pointer in spec029
(see Cross-references).

### 4. Bad-key latch (`src/lib/youtube-api.ts`, `src/lib/duration-enrichment.ts`)

Verified live against Google on 2026-10-03: a bogus key returns **HTTP 400** with
`error.errors[0].reason = "badRequest"` (generic) and `error.details[].reason =
"API_KEY_INVALID"`. Google's docs also list 400 `keyInvalid` / `keyExpired`. The existing
allowlist only matches 403, so the latch never fires against real Google responses and the
sweep retries every minute forever.

A 200 response with a non-JSON body still throws out of `fetchVideoDurations` and is logged by
the sweep's outer catch as "failed unexpectedly" (nothing stamped, retried next tick) —
accepted as-is. Error-body parsing in `fetchVideoDurations` reads both `error.errors[0].reason` and the
`error.details[]` entries' `reason` fields. Change the classifier to
`classifyYoutubeApiError(status, reasons: string[])` (all reasons found, in body order;
tolerate non-array/malformed `details`). Rules:

- **bad-key:** status 403 with any reason in the existing set (`keyInvalid`, `forbidden`,
  `accessNotConfigured`), **or** status 400 with any reason in `{API_KEY_INVALID,
  API_KEY_EXPIRED, keyInvalid, keyExpired}`.
- **transient:** everything else. In particular a generic 400 `badRequest` *without* a key
  reason stays transient — a bug in our own request must not silently latch enrichment off
  until restart — and 403 `quotaExceeded` stays transient.

`failure.reason` reported/logged is the first matching key reason when classified bad-key,
else the first reason found, else `http-<status>` (existing fallback).

**Empty key.** `YOUTUBE_API_KEY` is read once at module load; treat
`undefined` *or* whitespace-only as disabled, and use the trimmed value as the key. The
"disabled" `logger.info` fires for both cases. Update the `.env.example` comment to say an
empty value means disabled.

### 5. Atomic feed apply (`src/lib/ingest.ts`)

Wrap everything in `applyFeedToChannel` that touches the DB — the `previousNewest` gap-detection
read, the per-entry upserts, and the `youtube_channels` schedule update — in one
`db.transaction((tx) => { … })` (sync callback, bun:sqlite; same pattern as
`src/lib/ignore-rules.ts` and `routes/categories.tsx`). Moving the `previousNewest` read
inside means gap detection sees a consistent snapshot. `listIgnoreRules()` (read-only) stays
outside, before the transaction. A throw rolls back the whole apply including the schedule
update; `ingestChannel`'s existing catch then runs `safeReschedule` as it does today, so a
failing channel still doesn't monopolize the scheduler. `routes/channels.tsx:213` calls
`applyFeedToChannel` directly with no catch — unchanged (uncaught ⇒ `app.onError`).

This supersedes spec003's "no wrapping transaction is needed" note
(`docs/specs/003-scheduled-video-ingestion.md`, ~line 232) and the comment in
`src/lib/ignore-rules.ts` (~line 33–34) that cites it; update both (pointer in the spec, a
reworded comment in code).

### 6. Bound feed input (`src/lib/rss.ts`)

**Body cap.** Replace `res.text()` with a streamed read capped at `MAX_FEED_BYTES = 2 * 1024
* 1024`. If `Content-Length` parses (via `Number()`; `NaN` fails the `>` comparison and simply falls
through to streaming) to more than the cap, bail before reading. Otherwise
accumulate `res.body` chunks, tracking total byte length; on exceeding the cap, `cancel()` the
reader (wrapped in try/catch so a rejecting `cancel()` can't mask the `null` return), `logger.warn("Feed exceeds size cap", { url, maxBytes })`, and return `null`. Concatenate the
chunks' bytes and decode once (or use `decode(chunk, { stream: true })`) — per-chunk decoding
without `stream: true` corrupts multi-byte UTF-8 characters split across chunks. The existing `AbortSignal.timeout` still covers the body read
(it applies to the whole fetch including body), and a read error/abort mid-stream is caught
and returns `null` like a failed fetch (this also closes a latent gap: `res.text()` was
previously outside the try/catch). A null `res.body` ⇒ `null`.

**Video-ID validation.** `parseVideoId` additionally requires `^[A-Za-z0-9_-]{11}$` after
the `yt:video:` prefix; a non-matching ID takes the existing malformed-entry skip path (debug
log per entry + one WARN summary). This also protects the enrichment API call, since IDs are
comma-joined into the `id=` query parameter. Existing DB rows with odd IDs are not repaired
(out of scope).

### Cross-references (pointers, not rewrites)

- `docs/specs/003-scheduled-video-ingestion.md` ~line 232: pointer that the transaction
  decision is superseded here.
- `docs/specs/029-video-duration-enrichment.md`: pointers at (a) the "stays eligible until it
  succeeds"/omitted-item language (now recheck windows), (b) the Error handling section
  (generic 400 stays transient — unchanged — but 400 `API_KEY_INVALID`/`API_KEY_EXPIRED`/
  `keyInvalid`/`keyExpired` now latch, since Google's real invalid-key response has a generic
  `errors[0].reason`), (c) the composite-index note (re-evaluate with the new predicate).

### Testing

Update/add (existing files; all via `devcontainer exec`):

- `test/lib/rss.test.ts`: a throwing non-XML body (`"hello"`) ⇒ `null` (no throw) *and* a
  well-formed non-feed HTML body ⇒ `null`; empty `<feed/>` ⇒ `null`; oversize body ⇒ `null`
  via both paths — a `Response` with a large `Content-Length` (pre-check) and a
  `ReadableStream` body with no `Content-Length` (streaming branch; `new Response(string)`
  sets the header automatically, so it can't reach the streaming path); a multi-byte
  character split across chunk boundaries decodes intact; invalid IDs (too short, too
  long, bad chars) skipped as malformed. Fixtures with short fake IDs (`abc123`, `def456`)
  become 11-char IDs.
- `test/lib/ingest.test.ts`: `ONE_ENTRY_FEED_XML`'s `live1` → 11-char ID; a mid-loop failure
  leaves **no** upserts and no schedule update — force it deterministically by passing a
  `ChannelFeed` whose second entry has a `null`/invalid `title` (NOT NULL violation) after a
  valid first entry.
- `test/routes/channels.test.ts`: not just the `yt:video:${e.id}` builder — every `feedXml`
  caller passes IDs far longer than 11 chars (e.g. `confirmVideos-vid1`,
  `alreadyKnown-vid1`, ~lines 404–483) and several assertions compare `youtubeVideoId` against
  those literals; all call sites *and* expectations change to 11-char IDs (otherwise entries
  are silently skipped and assertions fail with empty results). Non-XML
  feed on `/subscriptions/preview` and `/subscriptions` renders the `ConfirmError` message
  (not a 500). `app.onError` is manual-verification only (see above).
- `test/lib/youtube-api.test.ts`: `P1DT2H` ⇒ 93600, `P1D` ⇒ 86400, `P0D` ⇒ null;
  every existing `classifyYoutubeApiError` call (lines ~28–60: `(403, "keyInvalid")`,
  `(400, undefined)`, …) is rewritten to the array signature (`(403, ["keyInvalid"])`,
  `(400, [])`); new rows: 400 + `API_KEY_INVALID` (details) ⇒
  bad-key, 400 `keyInvalid`/`keyExpired` ⇒ bad-key, 400 `badRequest` alone ⇒ transient, 403
  `quotaExceeded` ⇒ transient, existing 403 cases unchanged; `fetchVideoDurations` returns
  `returnedIds` including items with unparseable/zero durations.
- `test/lib/duration-enrichment.test.ts`: real-shape 400 `badRequest` + `details`
  `API_KEY_INVALID` latches (alongside the existing 403 `badKeyResponse()` case); 50 stamped
  unresolvable videos don't block an older resolvable one; `P0D` item stamped `now+1h`,
  omitted item `now+24h`, neither re-eligible until their time passes (injectable `now`; the 50-stamped test uses
  future `duration_recheck_at` values relative to the `now` it passes, compared at second
  precision); the existing "writes durationSeconds… missing" test now leaves `missing`
  stamped +24h (adjust its assertions); every new test `discard()`s its rows so stamped
  leftovers don't leak into later tests' shared pool;
  transient failure stamps nothing; empty/whitespace key ⇒ disabled (`loadSweepModule` fresh
  module instances).

### Final verification

The task file's last steps run `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run
fallow` clean, then open the PR (per CLAUDE.md's branch/PR workflow). The manual
verification section splits "Claude performs directly" (curl from inside the devcontainer
against a local stub feed server returning non-XML / oversized bodies; SQLite reads of
`duration_recheck_at`) from "User performs live in a browser" (the subscribe flow showing the
friendly error — HTMX swap behavior).

## Open Questions

None.

**Red-team retrospective.**

- *Pass 1 (independent subagent, fresh context)* found no factual errors in the code
  references or regex renumbering, but caught: (1) the route-test fixture breakage under strict
  IDs was under-counted (all `feedXml` callers/expectations, not just the builder); (2) the
  `classifyYoutubeApiError` signature change rewrites every existing test call; (3) stamping
  alters an existing enrichment test and leaks stamped rows into the shared pool — tests need
  `discard()` and a stated `now`; (4) timestamp columns store whole seconds; (5) the spec's
  "throws on HTML error page" claim was wrong for well-formed HTML — corrected and both paths
  tested; (6) stream-read details (multi-byte decoding across chunks, `NaN` Content-Length,
  rejecting `cancel()`, test bodies must be `ReadableStream` to reach the streaming branch);
  (7) the mid-loop-failure test needed a concrete mechanism; (8) `app.onError` must pass
  `HTTPException` through, and `src/index.ts` isn't unit-testable (decided: manual-only, no
  app-factory refactor); (10) `returnedIds` insertion order and the stamp-cohort expiry caveat.
  All fixed above.
