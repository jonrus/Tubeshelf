---
status: implemented
created: 2026-09-05
---

# Video Duration Enrichment

## Context
YouTube's channel RSS feed — the app's sole video-discovery mechanism (spec003) — has no
duration field anywhere. `docs/app_idea.md` accepted this as an MVP limitation (Ingestion
Notes) and went further, stating a firm constraint against using the YouTube Data API at
all, specifically to keep setup friction at zero (MVP item 4; §3 Technical Architecture
also states "Ideally zero APIs").

Quota research (done in conversation, verified 2026-09-05 against Google's official quota
docs) shows the concern behind that constraint doesn't apply to a narrowly-scoped,
*optional* use of the API: `videos.list` costs 1 quota unit per call and batches up to 50
video IDs, against a default 10,000 units/day. At the user's production scale (67 channels),
even a full historical backfill plus steady-state ongoing enrichment stays in the tens of
units per day. Making the integration **optional** — the app works exactly as it does today
with no key configured — preserves the zero-setup-friction property that justified the
original blanket ban, while removing the ban itself.

This spec was promoted from `docs/features/011-video-duration-enrichment.md`, which resolved
the feature's scope and UX/data-handling principles. This spec resolves the remaining
implementation-level design questions surfaced by reading the actual ingestion code
(`src/lib/scheduler.ts`, `src/lib/ingest.ts`) during spec writing — see Design below for
corrections made to the feature file's assumptions once checked against that code.

## Scope

**In scope:**
- YouTube Data API v3 as an optional, purely additive enrichment source for video
  **duration only**. RSS-based discovery/ingestion is unmodified.
- A nullable `duration_seconds` column on `videos`.
- A sweep step appended to the existing scheduler's per-minute `tick()`, run after that
  tick's channel-ingest loop, that finds up to 50 duration-eligible videos and enriches them
  via one `videos.list(part=contentDetails)` call.
- Eligibility: `duration IS NULL`, `status IN (unwatched, watching)`, and belonging to a
  currently actively-subscribed channel (mirrors `scheduler.ts`'s own `dueChannels()`
  scoping pattern, not the per-request Queue/Continue Watching route queries — see Design's
  Eligibility query section for why that distinction matters) — ordered
  newest-published-first.
- `YOUTUBE_API_KEY` env var, unset by default (feature fully disabled). Documented in
  `.env.example` and `docs/DEPLOYMENT.md`'s config table; no `.devcontainer/devcontainer.json`
  default, since (unlike the dev-only `AUTH_RECOVERY_PASSWORD`) this is a real external
  credential.
- Graceful degradation: missing key, transient API failures, and a definitively-bad key are
  all handled without ever blocking or slowing down RSS ingestion.
- UI: duration renders only when present, YouTube-style `M:SS` / `H:MM:SS`, on every video
  card view (`queue-list.tsx`'s shared `videoCardBody()`, used by Queue, Continue Watching,
  Watched, and Ignored alike — see Design's Rendering section) and on the Watching page,
  using the codebase's existing nullable-field conditional idiom.
- An inline pointer added to `docs/app_idea.md` at both MVP item 4 and §3's "Ideally zero
  APIs" line, per `CLAUDE.md`'s product-spec-supersession convention.

**Explicitly out of scope** (unchanged from the feature file, restated for completeness):
- Any other `videos.list` fields (view count, statistics, etc.) beyond `contentDetails`.
- Reconciling a video that moves back from watched/ignored to unwatched after it's already
  left the eligible set — never re-targeted.
- Any change to video *discovery* (`search.list` or otherwise) — RSS remains the sole
  discovery mechanism.
- An admin UI/route to manually force a re-fetch of one video's duration.
- Using duration data for smarter behavior (auto-Watching timers, Shorts detection) — this
  spec only adds the raw data and its display.
- A standalone historical-backfill script or migration — the general sweep (below) serves
  both historical backfill and ongoing enrichment with the same mechanism.

## Design

### Corrections made to the feature file during spec writing
The feature file assumed ingestion runs "hourly" and scoped its "unbounded per run" batch
decision around that assumption. Reading `scheduler.ts` during spec writing found this
isn't quite right: the *scheduler's* `tick()` runs every **1 minute**
(`TICK_INTERVAL_MS = 60_000`); "hourly" is a per-*channel* property (`ingest.ts`'s
`BASE_INTERVAL_MS = 1 hour` jittered `nextDueAt`), achieved by `tick()` checking a small
batch of currently-due channels (`BATCH_SIZE = 5`) every minute. There's no single hourly
event to hook onto. This was surfaced to the user in conversation and the design below
reflects the corrected understanding, confirmed with them directly (see git history for
this file / the promoting conversation) rather than left as a silent feature-file override:
- **Hook point:** append the sweep to the end of every `tick()` call (`scheduler.ts:39-43`),
  after that tick's channel-ingest loop — not a new standalone timer. This reuses the
  existing single-flight/re-entrancy guard (`runGuardedTick`) for free, and delivers
  duration to a freshly-ingested video within ~1 minute rather than up to an hour.
- **Per-tick volume:** one batch (≤50 videos) per tick, not an unbounded drain-everything
  loop. This matches `BATCH_SIZE`'s own precedent in the same file ("cap per tick so a
  post-downtime backlog drains gradually," `scheduler.ts:8`) rather than introducing a
  differently-shaped cap. A large one-time historical backlog (e.g. thousands of
  pre-existing videos the first time this ships) drains at 50/minute in the background;
  ordinary ongoing volume (a handful of new videos per tick, typically far under 50) is
  always fully covered same-tick.
- **Sweep scope is general, not tied to which channels were ingested that specific tick.**
  The query is a plain `videos` scan on the eligibility criteria below, independent of
  which channels `tick()` happened to poll this minute. Scoping to "this tick's channels"
  was considered and rejected: it would require `applyFeedToChannel`/`ingestChannel` to
  report back which video IDs were newly inserted vs. merely updated, which
  `onConflictDoUpdate()` doesn't expose today — new plumbing for no real benefit, since a
  general newest-first query already prioritizes freshly-ingested videos automatically (a
  video ingested this minute has no more recently `publishedAt`-dated peer, so it always
  sorts into the next batch) and gets free retry-on-failure as a side effect (a video that
  failed enrichment on a past tick simply stays eligible until it succeeds or leaves the
  eligible status set). (refined in docs/specs/030-ingestion-enrichment-robustness.md — unresolved videos are now
  stamped with `duration_recheck_at` so they stop being re-requested every tick: 1h if
  Google returned the item without a usable duration, 24h if it omitted the item.)

### Schema
Add to `videos` (`src/db/schema.ts`):
```ts
durationSeconds: integer("duration_seconds"), // nullable; null = not yet enriched or no key configured
```
With a check constraint matching the table's existing pattern:
```ts
check(
  "duration_seconds_check",
  sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
),
```
A plain additive nullable column — no FK retarget, ~~so `drizzle-kit generate` should
produce the simple `ALTER TABLE ... ADD COLUMN` case (not the interactive
rename-disambiguation prompt spec003 flagged for FK-changing migrations).~~

**Corrected during task 12 (see the task file's task 12).** The `ALTER TABLE ... ADD
COLUMN` prediction was wrong: SQLite can't add the new `duration_seconds_check` CHECK
constraint via `ALTER TABLE`, so `drizzle-kit generate` emitted a full table rebuild
(`__new_videos` + `INSERT ... SELECT ... FROM videos` + rename). That generated
`INSERT ... SELECT` listed `"duration_seconds"` in its `SELECT` from the *old* `videos`
table, which has no such column yet — SQLite silently reads an unknown double-quoted
identifier as a string literal, so every pre-existing row got the text `'duration_seconds'`
written into the new column instead of NULL (and the CHECK didn't catch it, since
`'duration_seconds' >= 0` is true in SQLite). Fixed by hand-editing
`drizzle/0003_violet_invaders.sql` to drop `"duration_seconds"` from both the column list
and the `SELECT` list of that `INSERT ... SELECT` (a brand-new column has nothing to carry
over; the copied rows take the column default, NULL). No interactive
rename-disambiguation prompt was involved — that part of the prediction held.

Query index: the eligibility query (`duration_seconds IS NULL AND status IN (...) ORDER BY
published_at DESC LIMIT 50`, joined against active subscriptions) is a candidate for a
composite index, e.g. `index("videos_duration_status_published_idx").on(t.durationSeconds,
t.status, t.publishedAt)` — follows the same shape as the table's existing
`videos_status_published_idx`. Confirm at implementation time whether SQLite's query planner
actually benefits given the table's expected size (likely modest at this project's scale);
add only if `EXPLAIN QUERY PLAN` shows a full table scan being used instead. (refined in
docs/specs/030-ingestion-enrichment-robustness.md — the eligibility query gained a `duration_recheck_at` predicate; re-evaluated
there, result recorded in `docs/specs/tasks/030-ingestion-enrichment-robustness.md` task 11:
no index added.)

### Eligibility query
Conceptually (Drizzle, mirroring `scheduler.ts`'s own `dueChannels()` active-subscription
pattern, not the per-request Queue/Continue Watching route queries): the sweep is a
background job with no "current user" context, same as `dueChannels()` — unlike
Queue/Continue Watching's route queries, which additionally filter by `eq(subscriptions.userId,
userId)` since they're scoped to whoever's logged in. For MVP's single implicit user these
are behaviorally identical either way. **Known simplification, not an oversight:** once
multi-user support (app_idea.md's v2.0 roadmap) lands, a channel with one active and one
unsubscribed subscriber would stay enrichment-eligible under this design even for the
unsubscribed user's view of it, since "actively subscribed" here means "by *any* user," not
"by the requesting user" (there being no requesting user in a background job). Acceptable
for now — duration is inert, harmless extra data on a video a multi-user version would still
store regardless — but worth a second look whenever multi-user support is actually scoped.
```ts
const activelySubscribedChannelIds = db
  .select({ id: subscriptions.youtubeChannelId })
  .from(subscriptions)
  .where(isNull(subscriptions.unsubscribedAt));

db.select()
  .from(videos)
  .where(
    and(
      isNull(videos.durationSeconds),
      inArray(videos.status, ["unwatched", "watching"]),
      inArray(videos.channelId, activelySubscribedChannelIds),
    ),
  )
  .orderBy(desc(videos.publishedAt))
  .limit(50)
  .all();
```
If the result is empty, the sweep step is a no-op for that tick — no API call is made, so
steady-state (once caught up) cost is a cheap SELECT with zero quota usage most ticks.

### YouTube Data API call
New module (e.g. `src/lib/youtube-api.ts`), modeled on `rss.ts`'s shape (plain `fetch`, no
SDK dependency — matches the project's existing zero-dependency-for-simple-HTTP style):
```
GET https://www.googleapis.com/youtube/v3/videos
    ?part=contentDetails&id=<comma-separated up to 50 ids>&key=<YOUTUBE_API_KEY>
```
Response: for each returned item, `contentDetails.duration` is an ISO 8601 duration string
(e.g. `PT15M33S`, `PT1H2M15S`, or `PT0S`/`P0D` for an in-progress livestream where true
duration isn't known yet). A video ID present in the request but *absent* from the response
(deleted/private since RSS discovered it) simply isn't updated this pass — it stays eligible
and is retried on a later tick, same as any other not-yet-successful case, until it either
succeeds or leaves the eligible status set. (refined in docs/specs/030-ingestion-enrichment-robustness.md — the retry is
now throttled by a 24h `duration_recheck_at` stamp for omitted items, and 1h for items
returned without a usable duration such as `P0D`.)

**Response items must be matched back to database rows by each item's own `id` field, never
by array position.** Because a missing ID shifts every subsequent response item's index
relative to the request array, matching by position would silently write a correct-looking
but wrong duration to the wrong video whenever *any* ID in the batch is missing from the
response — a real data-corruption risk, not just a cosmetic one, since it happens silently
with no error to notice. Build a `Map<videoId, durationSeconds>` from the response before
writing anything back.

Parsing: a small ISO 8601 duration parser (`PnYnMnDTnHnMnS` subset — YouTube durations only
ever populate the `T` time components and, for `P0D`/live-in-progress, the bare date part
with no time component) converting to integer seconds. **A parsed value of exactly 0
seconds is treated as "no data yet" and not written** — writing a literal `0` would render
as `0:00` in the UI, misrepresenting an in-progress livestream as a zero-length video. This
follows directly from the feature file's "duration only renders when a real value exists"
principle applied to the ingestion side, not just the display side.

### Error handling and the auth-failure latch
Three failure classes. The default is transient — **latching requires a positive match
against a small enumerated allowlist of key/access-specific error reasons, never a status
code alone** — because the cost of the two failure modes is asymmetric: misclassifying a
bad key as transient just means recurring `warn` logs (acceptable — "logging of odd states
is expected" per the feature file's own framing), while misclassifying a transient condition
as a bad key silently and permanently kills an optional feature for the rest of the
process's uptime, with a container restart as the only stated recovery path and no signal
telling anyone that's needed.

- **Transient (default; includes anything not explicitly matched below):** network
  error/timeout, HTTP 429, 5xx, or any 403 whose `errors[].reason` is `quotaExceeded`,
  `dailyLimitExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, or anything else not on
  the bad-key allowlist below. Logged once at `warn` with a count (mirroring `rss.ts`'s
  "Skipped malformed feed entries" pattern — one summary line, not per-video), no state
  change. The next tick's eligibility query naturally retries, since nothing was written.
  A generic HTTP 400 also falls here — 400 means "malformed request," which can just as
  easily be an app-side bug (bad ID encoding, an API change) as a bad key, and latching off
  the feature for a self-inflicted request bug would misdirect debugging effort toward
  rotating a key that was never the problem. (refined in docs/specs/030-ingestion-enrichment-robustness.md — a generic 400
  `badRequest` alone stays transient, but a 400 carrying `API_KEY_INVALID`, `API_KEY_EXPIRED`,
  `keyInvalid`, or `keyExpired` in `error.details[]`/`errors[]` now latches, since Google's
  real invalid-key response has a generic `errors[0].reason`.)
- **Definitively bad key (allowlist only):** 403 with `errors[].reason` of exactly
  `keyInvalid`, `forbidden`, or `accessNotConfigured`. Logged once at `warn`, and an
  in-memory flag latches the enrichment step off for the remainder of that process's uptime
  — every subsequent tick's sweep step becomes a no-op (skipped before even running the
  eligibility query) with no further logging, until the process restarts (e.g. picking up a
  corrected key via a container restart). This narrow allowlist — rather than "any 401/403"
  — matters specifically because `quotaExceeded` also returns HTTP 403: a blanket latch
  would permanently disable the feature for the rest of the process's uptime the one day
  quota got legitimately exceeded, even though that condition is expected to clear at the
  next daily reset (midnight PT).
- **Missing key** (`YOUTUBE_API_KEY` unset): the sweep step is skipped entirely, following
  `applyRecoveryPasswordFromEnv`'s (`src/lib/auth.ts`) silent-skip-when-unset idiom — a
  single `logger.info` logged once (see Env var and docs below for when), not a per-tick log
  line.

None of these paths throw out of the sweep step — it's wrapped in its own try/catch inside
`tick()`, separate from the existing per-channel error isolation in `ingestChannel()`, so an
enrichment failure is never conflated with (and never logged as) an ingestion failure, and
never risks the starvation `ingest.ts`'s extensive error-isolation comments describe
avoiding for channel polling.

### Rendering
`src/views/queue-list.tsx`: add a `duration` field to each row type (`QueueRow`,
`WatchedRow`, `IgnoredRow`, and whatever type backs Continue Watching), rendered inside the
shared `videoCardBody()` with the same `row.field ? <span>...</span> : null` idiom already
used for `publishedAt`/`watchedAt`/`ignoreMethod`. Because `videoCardBody()` is the single
function shared by all four views (Queue, Continue Watching, Watched, Ignored), adding
duration there covers all four consistently in one place — including the case where a video
was enriched with a duration while still `unwatched`/`watching` and later transitioned to
`watched`/`ignored`: the column value persists on the row regardless of status change, so it
should still display wherever that row is later shown, even though the sweep itself stops
touching it once it leaves the eligible status set.

`src/views/watching-page.tsx` also renders duration when present, using the same
`formatDuration()` helper (not `videoCardBody()` — the Watching page is a structurally
separate render with no card/thumbnail-wrapper markup) — threaded through
`WatchingPageProps` by whichever route assembles it (the single-video page a user lands on
immediately after clicking a video, so showing duration there — not just on the card they
clicked from — is a small additive change on a route that already renders thumbnail and
title).

A `formatDuration(seconds: number): string` helper (new, alongside the existing
`relative-time.ts` helper) implements YouTube-style formatting: `M:SS` under an hour (e.g.
`5:33`), `H:MM:SS` at or above an hour (e.g. `1:02:15`), no leading zero on the leftmost
unit.

### Env var and docs
`YOUTUBE_API_KEY`, read once via `process.env.YOUTUBE_API_KEY` at module load and cached
(not re-read from `process.env` on every tick — env vars don't change mid-process, and
`tick()` runs every 60s, so a per-tick read would just be pointless repeated work). This is
a variation on `applyRecoveryPasswordFromEnv`'s precedent worth noting explicitly: that
function's read happens once at process startup because it's only ever called once from
`src/index.ts`, whereas the enrichment sweep's key needs to be checked on a recurring basis
— caching the module-load read achieves the same "read once" property despite the different
call shape. The one-time "enrichment disabled" `logger.info` (see Error handling above) logs
at this same module-load point, when the cached value is found unset.

Documented in `.env.example` (commented-out line + short explanation) and
`docs/DEPLOYMENT.md`'s config table. No `.devcontainer/devcontainer.json` default.

### `docs/app_idea.md` amendment
Three edits, not two — the spec's own Context section names *Ingestion Notes* as the
paragraph this work is answering, so it needs a pointer alongside the other two:
- MVP item 4: append `(refined in docs/specs/029-video-duration-enrichment.md — the "no
  API" constraint is relaxed to optional, narrowly-scoped use of videos.list for duration
  only; the app's zero-setup-friction property is preserved by making the integration
  purely additive and off by default)`. Scoped deliberately narrower than "API usage is now
  fine" — a reader skimming only this pointer shouldn't come away thinking precedent now
  exists for e.g. reaching for `search.list` to fix the still-unaddressed 15-video RSS
  window mentioned in this same MVP item; that remains a separate, undecided question.
- §3 Technical Architecture, "Third-Party APIs: Ideally zero APIs": append the same pointer.
- Ingestion Notes (the paragraph noting the RSS feed has no duration field and calling
  duration-aware timers/Shorts-detection "out of scope for MVP"): append `(duration itself
  is now available as an opt-in enrichment, see docs/specs/029-video-duration-enrichment.md
  — using it for timers/Shorts-detection remains out of scope, still deferred)`.

### Testing
Following spec028's precedent of naming test files/cases explicitly rather than leaving
coverage implicit:
- New `test/lib/youtube-api.test.ts` (or similar): the ISO 8601 duration parser (each format
  YouTube actually emits, plus the `P0D`/`PT0S`/zero-seconds "not yet available" case), and
  the error-classification logic (each allowlisted bad-key reason latches; `quotaExceeded`/
  `rateLimitExceeded`/429/generic-400/network-error/5xx all stay transient and don't latch;
  an unrecognized 403 reason defaults to transient) as pure-function unit tests, independent
  of any real network call.
- New tests for the eligibility query (empty when nothing qualifies; excludes
  watched/ignored; excludes an unsubscribed channel's videos; orders newest-first; respects
  the 50-row cap) — likely alongside the existing `test/lib/scheduler.test.ts`, since that's
  where `dueChannels()`'s equivalent query is already tested the same way.
- `test/lib/scheduler.test.ts` and `test/lib/ingest.test.ts` (both pre-existing) need review
  once `tick()` gains the sweep step — confirm neither suite's existing assertions about
  `tick()`'s behavior (e.g. call counts, mocked dependencies) need updating now that it does
  more than the channel-ingest loop.
- `formatDuration()` unit tests: under a minute, minutes-only, exactly one hour, multi-hour,
  no leading zero on the leftmost unit.

## Open Questions
None remaining. Retrospective on the drafting process:
- The feature file's "hourly cadence" assumption was corrected against the actual scheduler
  code (`tick()` runs every minute; "hourly" is a per-channel jittered property) — surfaced
  to the user directly, who confirmed appending to the per-minute `tick()` and capping the
  sweep to one batch per tick, both reusing existing precedent in `scheduler.ts` rather than
  introducing new timing/batching primitives.
- The user asked directly whether the sweep should scope to only the channels ingested in a
  given tick vs. a general query — resolved in favor of a general query (see Design above)
  since scoping to per-tick channels would require new insert-vs-update tracking plumbing
  that `onConflictDoUpdate()` doesn't provide today, for no benefit a general newest-first
  query doesn't already deliver.
- The blanket "401/403 latches off" idea from initial scoping was refined during spec
  writing to distinguish `quotaExceeded` (transient, expected to clear daily) from a
  genuinely bad key (400, or 403 with a key/access-specific error reason) — confirmed with
  the user before finalizing.
- An independent red-team pass (fresh context, no memory of the drafting conversation) found
  six substantive issues, all fixed directly in this document: (1) the `videos.list`
  response section didn't say items must be matched back to rows by `id` field rather than
  array position — a missing ID in the batch would otherwise silently shift every later
  item's index and write a duration to the wrong video; (2) the error-classification scheme
  was both incomplete (no handling for 429/`rateLimitExceeded`/`userRateLimitExceeded`, no
  stated default for unrecognized reasons) and wrong in one place (treating any HTTP 400 as
  "bad key," when 400 also covers ordinary malformed-request bugs) — rewritten so latching
  requires a positive allowlist match and everything else defaults to transient, since that
  failure direction is strictly safer; (3) the `docs/app_idea.md` amendment plan skipped
  Ingestion Notes despite this spec's own Context section naming it as the relevant
  paragraph — added as a third edit; (4) the Rendering section had silently narrowed to only
  `queue-list.tsx` without deciding (or flagging) the Watching page or the Watched/Ignored
  views, leaving an inconsistency where an already-enriched video would stop showing its
  duration after being marked watched/ignored — resolved by threading duration through the
  shared `videoCardBody()` (covering all four list views at once) and `WatchingPageProps`;
  (5) no Testing section existed despite spec028 setting that precedent — added, naming
  specific test files and cases for the highest-risk new logic; (6) the eligibility query's
  cited precedent (Queue/Continue Watching's route queries) was actually the wrong analog —
  those are user-scoped and this background job isn't, so `dueChannels()` is the accurate
  precedent — corrected, with an explicit call-out of the resulting multi-user simplification
  as a deliberate, revisit-later choice rather than an accident. A follow-up narrower check,
  scoped only to these six fixes rather than a fresh full pass, confirmed five held up
  exactly as written and caught one small new wrinkle the Rendering fix itself introduced: a
  "using the same helper" reference on the Watching-page paragraph was ambiguous about which
  helper (read in sequence, it could be misread as `videoCardBody()` rather than the
  intended `formatDuration()`) — reworded to name the helper explicitly. No further issues
  found; per this skill's guidance, this stands as the stopping point rather than another
  full pass.
- During task 13's manual verification (implementation), the Schema section's `ALTER TABLE
  ... ADD COLUMN` prediction was found wrong and corrected — see the strike-through and
  note in Design → Schema. Short version: the new CHECK constraint forced `drizzle-kit
  generate` into a full table rebuild, whose generated `INSERT ... SELECT` referenced the
  not-yet-existing `duration_seconds` column and (via SQLite's string-literal fallback for
  unknown quoted identifiers) wrote the text `'duration_seconds'` into every pre-existing
  video row instead of NULL. Fixed by hand-editing `drizzle/0003_violet_invaders.sql` to
  drop that column from the copy statement; dev DB rebuilt clean; added as task 12 in the
  task file.
