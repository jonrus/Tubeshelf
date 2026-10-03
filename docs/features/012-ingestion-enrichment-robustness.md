---
status: promoted
promoted_to: docs/specs/030-ingestion-enrichment-robustness.md
created: 2026-10-03
---

# Ingestion & Enrichment Robustness

## Problem / Motivation

A full-codebase review (2026-10-03; tests/lint/tsc/fallow all green, none of these seen in
production) found a cluster of robustness bugs in the RSS-ingestion and YouTube
duration-enrichment paths: an unguarded XML parse that turns a bad feed into a bare 500 on
the subscribe flow, a wrong ISO-8601 day calculation, an enrichment queue that can be
starved by videos the API never resolves, a bad-API-key latch that never fires against real
Google responses, a non-atomic feed apply, and unbounded/unvalidated feed input. This is
Round B of a three-spec hardening roadmap (B → C → A); this feature is deliberately limited
to ingestion + enrichment.

## Firm Scope

1. **Non-XML / malformed feeds don't throw (#2).** `fetchChannelFeed` (`src/lib/rss.ts`)
   wraps `Bun.XML.parse` so a parse failure returns `null` (logged). Guard `feed` with
   `typeof feed === "object" && feed !== null` (an empty `<feed/>` parses to `{feed: ""}`).
   Add a global `app.onError` in `src/index.ts` that routes uncaught errors through
   `logger.error` (spec028 format) and returns a plain 500 — Hono's default already returns a
   plain 500 via `console.error`, so this is a logging improvement, not a UX change. The two
   subscribe routes (`POST /subscriptions/preview`, `POST /subscriptions`) already map a
   `null` feed to the friendly `ConfirmError` "Couldn't fetch that channel's feed."
2. **ISO-8601 durations with days (#3).** `ISO_8601_DURATION_RE` in
   `src/lib/youtube-api.ts` captures the `D` group and adds `days * 86400`
   (`P1DT2H` → 93600, currently 7200).
3. **Enrichment starvation (#4).** Add nullable `videos.duration_recheck_at`
   (migration; a "don't re-request before" timestamp rather than a "last checked" one, so
   two different windows fit one column). After a *successful* API response, each batch
   video that didn't resolve is stamped: the API returned the item but its duration parsed
   to null (`P0D`/`PT0S`, live/upcoming) → `now + 1h`; the API omitted the item entirely
   (deleted/private) → `now + 24h`. `eligibleVideos` (`src/lib/duration-enrichment.ts`)
   adds `duration_recheck_at IS NULL OR duration_recheck_at <= now` (injectable `now`).
   Retried indefinitely.
4. **Bad-key latch actually fires (#5).** Verified live against Google on 2026-10-03: a bogus
   key returns HTTP 400 with `errors[0].reason = "badRequest"` (generic) and
   `error.details[].reason = "API_KEY_INVALID"`; Google's docs list 400 `keyInvalid` /
   `keyExpired`. `classifyYoutubeApiError` / the error-body parsing in `fetchVideoDurations`
   must read `details[].reason` too. Also treat an empty/whitespace `YOUTUBE_API_KEY=` as
   disabled (currently only `undefined` counts).
5. **Atomic feed apply (#16).** Wrap the per-entry upserts + the `youtube_channels` schedule
   update in `applyFeedToChannel` (`src/lib/ingest.ts`) in a single `db.transaction`.
   Supersedes the "no wrapping transaction is needed" note in
   `docs/specs/003-scheduled-video-ingestion.md` (~line 232) — add a small pointer there.
6. **Bound feed input (#17).** Cap the feed response body at 2 MiB via a streamed read in
   `fetchChannelFeed` (overflow ⇒ abort, WARN, return `null`); validate the video ID in
   `parseVideoId` against `^[A-Za-z0-9_-]{11}$` (a non-matching entry takes the existing
   "malformed entry" skip path).

## Nice-to-have / Stretch Scope

None.

## Explicitly Out of Scope

- Round C (behavior/ops polish) and Round A (auth/security) items — see the roadmap.
- Channel handle scraping fragility (#18), exponential backoff / attempt counters for
  enrichment, any retry/backoff for feed fetches (spec003 posture unchanged).
- Making `app.onError` HTMX-aware (retarget/reswap of arbitrary uncaught errors).
- Backfilling/repairing existing rows with malformed `youtube_video_id` values.

## Related Specs / Code

- `src/lib/rss.ts`, `src/lib/ingest.ts`, `src/lib/subscribe.ts`, `src/routes/channels.tsx`,
  `src/views/subscribe-confirm.tsx`, `src/index.ts`
- `src/lib/youtube-api.ts`, `src/lib/duration-enrichment.ts`, `src/lib/scheduler.ts`,
  `src/db/schema.ts` (videos), `drizzle/0003_violet_invaders.sql`
- `docs/specs/003-scheduled-video-ingestion.md` (transaction note),
  `docs/specs/025-bun-xml-parser-swap.md`, `docs/specs/029-video-duration-enrichment.md`
  (error handling / eligibility sections)
- Tests: `test/lib/{rss,youtube-api,duration-enrichment,ingest,subscribe}.test.ts`,
  `test/routes/`
- `.env.example` (YOUTUBE_API_KEY comment)

## Open Questions

- (none)

## Resolved Decisions

- **Recheck policy: 1h for P0D/live/upcoming, 24h for API-omitted; both retried forever.**
  Why: P0D means the video exists and will resolve soon (stream ends, premiere airs), so a
  day's lag is needlessly stale; omitted (deleted/private) videos rarely return, so a day is
  plenty and each costs ≤1 batch slot/day. Column is `duration_recheck_at` (next-eligible
  time) so one nullable column encodes both windows. Departs from spec029's "stays eligible
  until it succeeds" — spec029 gets a pointer.
- **Bad-key classification:** latch on 400 with `details[].reason` ∈ {`API_KEY_INVALID`,
  `API_KEY_EXPIRED`} or `errors[0].reason` ∈ {`keyInvalid`, `keyExpired`}, plus the existing
  403 set. A generic 400 `badRequest` stays transient. Why: a bug in our own request must not
  silently latch enrichment off until restart; `quotaExceeded` (403) remains transient.
- **Error UX:** `fetchChannelFeed` returns `null` on parse failure so existing `ConfirmError`
  paths render; `app.onError` stays in scope for structured logging only (Hono's default
  already returns a plain 500; no HTMX special-casing).
- **Feed size cap: 2 MiB, streamed**, overflow treated as a failed fetch.
- **Migration shape:** the new column carries no CHECK constraint, so `drizzle-kit generate`
  should emit a plain `ALTER TABLE ADD COLUMN`, not a table rebuild. The spec must verify the
  generated SQL; if a rebuild appears, the `INSERT … SELECT` must not reference the new
  column (spec029 task 12's phantom-column corruption). `drizzle-kit generate` may need a
  real TTY — hand the user the command.
- **Stamping rule:** `duration_recheck_at` is set only after a *successful* API response, for
  batch videos with no resolved duration; transient failures never stamp (so they retry next
  tick). Resolved videos need no stamp (they leave the null-duration set).
- **Video ID validation also protects the API call**, since IDs are comma-joined into the
  `id=` query parameter.
- **"What am I missing" pass (no new forks):** `ingestChannel` already try/catches, so the
  parse throw only ever bit the subscribe routes (scheduler unaffected). The gap-detection read
  of `previousNewest` moves inside the new transaction. `duration_recheck_at` is untouched by
  the ingest upsert's `set` list. The 24h comparison should take an injectable `now` for tests.
  Update the `.env.example` YOUTUBE_API_KEY comment to say an empty value means disabled.

### Second refinement pass (real `/new-feature` run, same day)
- **Video ID rule: strict `^[A-Za-z0-9_-]{11}$`; update test fixtures.** Existing fixtures
  with short fake IDs would be rejected: `test/lib/rss.test.ts` (`abc123`, `def456`),
  `test/lib/ingest.test.ts` (`ONE_ENTRY_FEED_XML`'s `live1`) and `test/routes/channels.test.ts`
  (`yt:video:${e.id}` builder). The rest of `ingest.test.ts` builds `ChannelFeed` objects
  directly, bypassing the parser, so is unaffected. Why: matches what YouTube emits, and tests
  then use realistic IDs.
- **Spec029 amendments needed (pointers, not rewrites):** its Error handling section says a
  generic 400 stays transient and allowlists only 403 reasons (our change keeps the generic-400
  rule but adds 400 `API_KEY_INVALID`/`keyInvalid`/`keyExpired`, which spec029 didn't know
  about, since Google's real invalid-key response has a generic `errors[0].reason`); its "stays eligible until
  it succeeds" language and its composite-index note (`duration_seconds, status, published_at`)
  both interact with the new `duration_recheck_at` predicate — the spec should re-run
  `EXPLAIN QUERY PLAN` rather than assume.
- **Test surface to update:** `test/lib/youtube-api.test.ts` (`classifyYoutubeApiError(status,
  reason)` signature gains the `details` reason; add `P1DT2H`, `P1D`, `P0D`), the existing
  `badKeyResponse()` helper in `test/lib/duration-enrichment.test.ts` (uses 403 `keyInvalid`;
  add a real-shape 400 `badRequest` + `details` case), and `loadSweepModule` already handles
  the empty-key case via fresh module instances.

### Corrections made while writing the spec
- The "stamping rule" couldn't be implemented as written: `fetchVideoDurations` returned only
  resolved durations, so "API returned the item but duration null" vs. "API omitted it" were
  indistinguishable. Corrected in docs/specs/030-ingestion-enrichment-robustness.md's Design
  (adds `returnedIds` to the result).
- Test-fixture impact of strict video IDs is larger than listed above (all `feedXml` callers
  in `test/routes/channels.test.ts`, plus every `classifyYoutubeApiError` call) — see the
  spec's Testing section.
