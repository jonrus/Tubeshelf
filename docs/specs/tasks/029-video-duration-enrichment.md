# Tasks: Video Duration Enrichment
Spec: docs/specs/029-video-duration-enrichment.md
Generated: 2026-09-05

- [x] 1. Add a nullable `durationSeconds` column to `videos` in `src/db/schema.ts`
  (`integer("duration_seconds")`, no `.notNull()`), plus a check constraint named
  `duration_seconds_check` whose SQL condition is `<durationSeconds column> is null or
  <durationSeconds column> >= 0` (written with the `sql` tagged template and
  `t.durationSeconds` column references, matching the syntax the existing
  `status_check`/`ignore_method_check`/`watched_at_check` constraints already use) in the
  table's `(t) => [...]` array.
  Generate the migration: `bunx drizzle-kit generate` (via `devcontainer exec`). Done
  when: a new file appears under `drizzle/` containing `ALTER TABLE videos ADD COLUMN
  duration_seconds integer` and the matching `CHECK` clause, `bunx tsc --noEmit` passes,
  and `bun test` still passes (existing tests construct rows without `durationSeconds`,
  which is fine since the column is nullable with no default required).

- [x] 2. Add `formatDuration(seconds: number): string` to a new `src/lib/duration.ts`
  (sibling to `src/lib/relative-time.ts`, not merged into it — different input shape).
  YouTube-style: `M:SS` under 3600 seconds (e.g. `333` → `5:33`), `H:MM:SS` at/above 3600
  (e.g. `3735` → `1:02:15`), minutes/seconds zero-padded to 2 digits except the leftmost
  unit which has no leading zero. Add `test/lib/duration.test.ts` covering: under a
  minute (`5` → `0:05`), minutes-only under an hour (`333` → `5:33`), exactly one hour
  (`3600` → `1:00:00`), multi-hour (`3735` → `1:02:15`). Done when: `bun test
  test/lib/duration.test.ts` passes.

- [x] 3. Create `src/lib/youtube-api.ts` with two pure, network-free pieces first (so
  they're independently testable before the fetch wrapper is added in task 4):
  - `parseIso8601Duration(iso: string): number | null` — parses the `PnYnMnDTnHnMnS`
    subset YouTube actually emits (hours/minutes/seconds components under `T`, plus the
    bare `P0D` shape with no `T` block for an in-progress livestream). Returns `null`
    (not `0`) when the parsed value is exactly 0 seconds, per the spec's "0 means not
    available yet, don't write it" rule — treat parse failure the same as 0 (return
    `null`), don't throw.
  - `classifyYoutubeApiError(status: number, reason: string | undefined): "transient" |
    "bad-key"` — returns `"bad-key"` only when `status === 403` and `reason` is exactly
    one of `"keyInvalid"`, `"forbidden"`, `"accessNotConfigured"`; every other
    status/reason combination (429, 5xx, network-error sentinel, 403 with
    `"quotaExceeded"`/`"rateLimitExceeded"`/`"userRateLimitExceeded"`/anything
    unrecognized, generic 400) returns `"transient"`.
  Add `test/lib/youtube-api.test.ts` covering: `parseIso8601Duration` for `PT15M33S` →
  `933`, `PT1H2M15S` → `3735`, `PT0S` → `null`, `P0D` → `null`, a malformed string →
  `null`; `classifyYoutubeApiError` for each of the three bad-key reasons →
  `"bad-key"`, and for `quotaExceeded`/`rateLimitExceeded`/`userRateLimitExceeded`/an
  unrecognized reason/generic 400 → `"transient"`. Done when: `bun test
  test/lib/youtube-api.test.ts` passes.

- [x] 4. Extend `src/lib/youtube-api.ts` with the actual API call:
  `fetchVideoDurations(videoIds: string[], apiKey: string): Promise<{ durations:
  Map<string, number>; failure: { class: "transient" | "bad-key"; reason: string } |
  null }>`. Builds `GET https://www.googleapis.com/youtube/v3/videos?part=contentDetails
  &id=<comma-joined ids>&key=<apiKey>` via `fetch` (no SDK, matching `rss.ts`'s style).
  On a non-OK response, parse the JSON error body's `error.errors[0].reason` (falling
  back to `undefined` if the body isn't the expected shape) and call
  `classifyYoutubeApiError`; return `{ durations: new Map(), failure: {...} }` — never
  throw. On success, build the returned `Map` **keyed by each response item's own `id`
  field** (never by array position/index — a video ID present in the request but absent
  from the response must not shift any other item's association), running each item's
  `contentDetails.duration` through `parseIso8601Duration` and only inserting into the
  map when the result isn't `null`. `videoIds` longer than 50 is a caller contract
  violation, not this function's concern (task 5's caller enforces the cap). Done when:
  the function compiles and a quick manual smoke test against a real/fake key isn't
  required — task 7's tests cover this via a stubbed `fetch`, added there instead of
  here to keep this step focused on the implementation.

- [x] 5. Create `src/lib/duration-enrichment.ts`:
  - Read `process.env.YOUTUBE_API_KEY` once at module load into a cached `const`. If
    unset, log `logger.info("Duration enrichment disabled: YOUTUBE_API_KEY not set")`
    once at module load and export a `runDurationEnrichmentSweep` that's an immediate
    no-op.
  - A module-level `let latched = false` flag.
  - The eligibility query (Drizzle), matching the spec's Design → Eligibility query
    section exactly: `videos` joined/filtered where `durationSeconds` is null, `status
    IN ('unwatched', 'watching')`, and `channelId` is in the set of channel IDs with at
    least one row in `subscriptions` where `unsubscribedAt IS NULL` (mirror
    `scheduler.ts`'s `dueChannels()` subquery shape, not `queue.tsx`'s user-scoped
    queries — no `userId` filter), ordered `desc(videos.publishedAt)`, limited to 50.
  - `export async function runDurationEnrichmentSweep(): Promise<void>` — no-op
    immediately if no key or if `latched`; otherwise runs the eligibility query, and if
    it returns zero rows, returns without calling `fetchVideoDurations` at all (no API
    call, per spec). Otherwise calls `fetchVideoDurations` with the batch's
    `youtubeVideoId`s. On `failure.class === "bad-key"`: log
    `logger.warn("Duration enrichment disabled: bad API key", { reason:
    failure.reason })` once and set `latched = true`. On `failure.class ===
    "transient"`: log `logger.warn("Duration enrichment sweep failed, will retry next
    tick", { reason: failure.reason, count: <batch size> })` (count-based, matching
    `rss.ts`'s pattern — one line, not per-video) and return without writing anything.
    On success: for each row in the batch, if the returned `durations` map has an entry
    for that row's `youtubeVideoId`, `UPDATE videos SET duration_seconds = <value> WHERE
    id = <row.id>`; rows with no matching entry (deleted/private, or `null`-parsed) are
    left untouched and simply remain eligible for a later sweep.
  - This function must never throw — wrap the query/fetch/write sequence in try/catch
    internally and log+return on any unexpected error (matches `ingestChannel`'s
    never-throws contract, even though the outer isolation also happens at the call
    site in task 6).
  - Per the spec's Schema section, the composite index is conditional, not automatic:
    once the eligibility query above is written, run `EXPLAIN QUERY PLAN` against it
    (e.g. via a throwaway script through `devcontainer exec`, per CLAUDE.md's
    file-not-inline convention for `bun:sqlite` queries) against a dev DB with a
    realistic number of video rows. If it shows a full table scan on `videos`, add
    `index("videos_duration_status_published_idx").on(t.durationSeconds, t.status,
    t.publishedAt)` to `src/db/schema.ts` and generate a second migration (`bunx
    drizzle-kit generate`); if the planner already uses an existing index efficiently
    enough, skip adding it and note that in this task's commit message.
  Done when: the file compiles and exports `runDurationEnrichmentSweep`; the
  `EXPLAIN QUERY PLAN` check has been run and its outcome (index added or skipped)
  is reflected in the commit; task 7 adds `runDurationEnrichmentSweep`'s tests.

- [x] 6. Wire the sweep into `src/lib/scheduler.ts`'s `tick()`: after the existing
  `for (const channel of dueChannels(...))` loop, add a separate `try { await
  runDurationEnrichmentSweep(); } catch (err) { logger.error("Duration enrichment sweep
  failed", { err }); }` block — a distinct log message and distinct try/catch from the
  channel-ingest loop, so an enrichment failure is never conflated with an ingestion
  failure. Import `runDurationEnrichmentSweep` from `./duration-enrichment`. Done when:
  `tick()` in `scheduler.ts` calls `runDurationEnrichmentSweep()` after its existing
  loop, `bunx tsc --noEmit` passes, and `test/lib/scheduler.test.ts`'s existing
  assertions about `tick()`/`runGuardedTick()` still pass unmodified (confirms the new
  step doesn't break the existing re-entrancy-guard tests — if any existing test needs
  updating because it now indirectly exercises `runDurationEnrichmentSweep`'s no-key
  no-op path, update it minimally to keep passing rather than skip it).

- [x] 7. Add `test/lib/duration-enrichment.test.ts`, modeled on `test/lib/scheduler.test.ts`'s
  setup (in-memory DB, migrate, seed, helper functions to create channels/subscriptions/
  videos). Stub `fetch` (e.g. `spyOn(globalThis, "fetch")`) rather than hitting the
  network. Cover: eligibility query returns empty when nothing qualifies; excludes
  `watched`/`ignored` videos; excludes a video whose channel's only subscription is
  unsubscribed; orders newest-`publishedAt`-first; caps at 50 rows. Cover
  `runDurationEnrichmentSweep`: no-op (no `fetch` call) when `YOUTUBE_API_KEY` is unset;
  no-op (no `fetch` call) when the eligibility query is empty; writes `durationSeconds`
  correctly on a successful stubbed response, matched by `id` field (include a test case
  where the stubbed response omits one requested ID, confirming the *other* IDs still
  get the *correct* durations — this is the regression test for the array-position bug
  the spec explicitly calls out); on a stubbed "bad-key" response, confirms a second call
  to `runDurationEnrichmentSweep()` makes no further `fetch` call (latch holds); on a
  stubbed "transient" response, confirms a second call *does* make another `fetch` call
  (no latch). Done when: `bun test test/lib/duration-enrichment.test.ts` passes.

- [x] 8. Thread `durationSeconds` through the read paths that feed views:
  - `src/routes/queue.tsx`: add `durationSeconds: videos.durationSeconds` to
    `queueRowsBaseQuery()`'s `.select({...})` (covers Queue + Continue Watching + the
    `queueRowById` lookup), to `watchedVideos()`'s explicit select, and to
    `ignoredVideos()`'s explicit select.
  - `src/lib/watch-status.ts`: add `durationSeconds: videos.durationSeconds` to
    `ownedVideo()`'s select (feeds the Watching page).
  - `src/views/queue-list.tsx`: add `durationSeconds: number | null` to `QueueRow`,
    `WatchedRow`, and `IgnoredRow`.
  - `src/views/watching-page.tsx`: add `durationSeconds: number | null` to
    `WatchingPageProps`.
  - `src/routes/queue.tsx`'s `GET /watching/:id` handler: pass
    `durationSeconds={video.durationSeconds}` to `<WatchingPage>`.
  Done when: `bunx tsc --noEmit` passes (every new field is consumed by task 9, so this
  step alone will show unused-field warnings from `fallow`/lint only if task 9 isn't
  done in the same session — acceptable to land tasks 8 and 9 together in one sitting if
  convenient, but they're written as separate checklist items since they touch different
  files).

- [ ] 9. Render duration:
  - `src/views/queue-list.tsx`: import `formatDuration` from `../lib/duration`. In
    `videoCardBody()`, render `row.durationSeconds !== null &&
    row.durationSeconds !== undefined ? <span class="text-text-muted">{formatDuration(row.durationSeconds)}</span>
    : null` — add it to the same badge/meta line as the existing conditional spans
    (`publishedAt`/`watchedAt`/`ignoreMethod`), consistent placement across all three
    card functions (`watchedCard`, `ignoredCard`, `queueCard`) since they all route
    through the shared `videoCardBody()`.
  - `src/views/watching-page.tsx`: import `formatDuration` from `../lib/duration`.
    Render the same conditional near the existing `Status: <WatchStatusBadge .../>`
    line (e.g. `{props.durationSeconds !== null ? <p>Duration:
    {formatDuration(props.durationSeconds)}</p> : null}`).
  Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun run fallow` all pass clean,
  and a manual check (task 12) confirms it renders.

- [ ] 10. Document `YOUTUBE_API_KEY`:
  - `.env.example`: add a commented-out block following the existing style (see
    `AUTH_RECOVERY_PASSWORD`'s block for the pattern), explaining it's optional, enables
    video-duration enrichment via the YouTube Data API v3, and that leaving it unset
    disables the feature entirely with no other effect on the app.
  - `docs/DEPLOYMENT.md`'s Configuration table (§2): add a row: `| `YOUTUBE_API_KEY` |
    Optional. If set, enables background enrichment of video duration via the YouTube
    Data API v3 (`videos.list`, duration only). Leaving it unset disables the feature
    entirely — the app behaves exactly as without it. |`.
  Done when: both files contain the new content; no code changes in this step.

- [ ] 11. Run the full verification suite via `devcontainer exec --docker-path podman
  --workspace-folder .`: `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run
  fallow` — all four must pass clean across the whole repo. Done when: all four commands
  exit 0 with no errors/warnings.

- [ ] 12. Manual end-to-end verification. Split per CLAUDE.md's convention:

  **Claude performs directly**, via `devcontainer exec --docker-path podman
  --workspace-folder .`:
  - Confirm the no-key baseline is unchanged: start the app with no `YOUTUBE_API_KEY`
    set (`bun run start`, backgrounded), confirm the startup log includes the "Duration
    enrichment disabled" info line, `curl` `/queue` (via `scripts/dev-login.sh`'s cookie
    jar) and confirm existing cards render exactly as before (no duration text, no
    layout shift, no error). Stop it.
  - Insert one video row via a `bun:sqlite` script (per CLAUDE.md's file-not-inline
    convention) with `duration_seconds` set directly to a known value (e.g. `754`) on an
    already-`unwatched` video belonging to an active subscription; `curl` `/queue` and
    confirm the card's HTML contains `12:34` in the expected position. Clean up the row
    afterward (or reset `duration_seconds` to null) — this is testing the *render* path
    only, not the sweep.
  - With `YOUTUBE_API_KEY` set to an intentionally invalid value, start the app and
    confirm the eligibility query finds candidates (insert a couple of `unwatched`
    videos with `duration_seconds IS NULL` first if none exist), wait for a scheduler
    tick (or trigger one directly if there's a test hook), and confirm a "bad key"-class
    warn log appears exactly once even across multiple ticks (latch holding) — check via
    `LOG_LEVEL=debug` if needed to see tick-by-tick behavior. Stop it and clean up any
    inserted rows.
  Done when: all three checks above show the expected output/logs and the dev DB is left
  clean (no leftover manually-inserted rows).

  **User performs live in a browser** (real YouTube Data API key required — get one from
  Google Cloud Console, YouTube Data API v3 enabled): set a real `YOUTUBE_API_KEY`,
  restart the app, wait a few minutes for a scheduler tick to run against real eligible
  videos, then visit `/queue` and `/continue-watching` and confirm real videos show a
  correct-looking duration matching what YouTube itself shows for the same video, and
  that clicking through to the Watching page also shows it there.

- [ ] 13. Update `docs/specs/029-video-duration-enrichment.md` frontmatter to
  `status: implemented`.

- [ ] 14. Open the PR: branch `spec/video-duration-enrichment` (already created and
  holding the spec/feature-file commits), push, and open a GitHub PR with a summary +
  test plan covering tasks 11-12 above. Per CLAUDE.md, check this box *before* pushing
  so the pushed branch and opened PR both reflect a fully-checked-off task file.
