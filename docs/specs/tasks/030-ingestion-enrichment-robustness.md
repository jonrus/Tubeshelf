# Tasks: Ingestion & Enrichment Robustness
Spec: docs/specs/030-ingestion-enrichment-robustness.md
Generated: 2026-10-03

All commands run via `devcontainer exec --docker-path podman --workspace-folder .` (see
CLAUDE.md). Branch: `spec/ingestion-enrichment-robustness` (already exists). Read the spec's
matching Design subsection before each step.

- [x] 1. Malformed-feed handling in `src/lib/rss.ts` `fetchChannelFeed` (spec Design §1, first
  half). Wrap `Bun.XML.parse(xml)` in try/catch: on throw,
  `logger.warn("Feed is not valid XML", { url: rssUrl, err })` and `return null`. Replace the
  `typeof feed === "object"` ternaries with a guard right after parsing:
  `const feed = parsed.feed; if (typeof feed !== "object" || feed === null) return null;` then
  read `feed.title` / `feed.entry` directly. Tests in `test/lib/rss.test.ts`: body `"hello"` ⇒
  `null` (no throw); well-formed non-feed HTML `<html><body>hi</body></html>` ⇒ `null`; empty
  `<feed/>` ⇒ `null`. Tests in `test/routes/channels.test.ts`: a non-XML feed body on
  `POST /subscriptions/preview` and `POST /subscriptions` renders the "Couldn't fetch that
  channel's feed." `ConfirmError` message (not a 500) — follow the file's existing
  fetch-mocking pattern. Done when: those tests pass and `bun test` is green.

- [x] 2. Bound feed input in `src/lib/rss.ts` (spec Design §6). (a) Add `MAX_FEED_BYTES = 2 *
  1024 * 1024`; replace `res.text()` with a streamed read: pre-check `Number(Content-Length) >
  MAX_FEED_BYTES` ⇒ warn + `null` before reading; otherwise read `res.body` via a reader,
  tracking total bytes, and on exceeding the cap `cancel()` the reader inside try/catch,
  `logger.warn("Feed exceeds size cap", { url, maxBytes })`, return `null`; collect chunks,
  concatenate bytes, decode once (UTF-8). Null `res.body` ⇒ `null`. A read error/abort
  mid-stream is caught and returns `null` (put the body read inside the existing try/catch
  scope). (b) `parseVideoId`: after the `yt:video:` prefix also require `^[A-Za-z0-9_-]{11}$`;
  non-match takes the existing malformed-skip path. (c) Fixture fallout: change every
  short/long fake video ID to an 11-char ID in `test/lib/rss.test.ts` (`abc123`, `def456`, …),
  `test/lib/ingest.test.ts` (`ONE_ENTRY_FEED_XML`'s `live1`, others), and
  `test/routes/channels.test.ts` (the `yt:video:${e.id}` builder, every `feedXml` caller such
  as `confirmVideos-vid1` / `alreadyKnown-vid1` ~lines 404–483, **and** every assertion
  comparing `youtubeVideoId` to those literals). Grep for other tests building feeds
  (`grep -rn "yt:video:" test`). (d) New rss tests: oversize via large `Content-Length`
  `Response` ⇒ `null`; oversize via a `ReadableStream` body with no Content-Length ⇒ `null`;
  a multi-byte character (e.g. `é`/emoji) split across two chunk boundaries decodes intact in
  the title; IDs too short / too long / bad chars skipped as malformed (other entries kept).
  Done when: `bun test` is fully green (no silently-skipped-entry failures).

- [x] 3. Add `app.onError` in `src/index.ts` right after `const app = new Hono();` (spec Design
  §1, second half): import `HTTPException` from `hono/http-exception`; handler first does
  `if (err instanceof HTTPException) return err.getResponse();` then
  `logger.error("Unhandled request error", { err, method: c.req.method, path: c.req.path });
  return c.text("Internal Server Error", 500);`. No unit test (module-top-level side effects;
  verified in the manual section, task 14). Done when: `bunx tsc --noEmit` and `bun run lint`
  pass.

- [x] 4. Make `applyFeedToChannel` atomic in `src/lib/ingest.ts` (spec Design §5). Keep
  `listIgnoreRules()` outside; wrap the `previousNewest` read, the per-entry upserts, and the
  `youtubeChannels` schedule update in one `db.transaction((tx) => { … })` (sync callback; use
  `tx` for all queries inside; mirror the pattern in `src/lib/ignore-rules.ts`). Update the
  stale comment in `src/lib/ignore-rules.ts` (~lines 33–34, cites spec003's "no transaction
  needed") to reflect that `applyFeedToChannel` is now also transactional (reword, don't just
  delete). Add a pointer in `docs/specs/003-scheduled-video-ingestion.md` after the
  "no wrapping transaction is needed" paragraph (~line 232), e.g. `(superseded in
  docs/specs/030-ingestion-enrichment-robustness.md — applyFeedToChannel is now one
  transaction)`. Test in `test/lib/ingest.test.ts`: pass `applyFeedToChannel` a `ChannelFeed`
  whose first entry is valid and second has an invalid/`null` `title` (NOT NULL violation);
  assert it throws, **no** video rows were inserted, and the channel's
  `lastFetchedAt`/`nextFetchDueAt` are unchanged. Also confirm the existing `ingestChannel`
  failure test still shows a reschedule. Done when: `bun test test/lib/ingest.test.ts` passes
  and `bun test` is green.

- [x] 5. ISO-8601 day component in `src/lib/youtube-api.ts` (spec Design §2). Change
  `ISO_8601_DURATION_RE`'s `(?:\d+D)?` to `(?:(\d+)D)?`, renumber groups (days=1, hours=2,
  minutes=3, seconds=4) in `parseIso8601Duration`, total = `days*86400 + hours*3600 +
  minutes*60 + seconds`; 0 ⇒ null unchanged. Add cases to `test/lib/youtube-api.test.ts`:
  `P1DT2H` ⇒ 93600, `P1D` ⇒ 86400, `P0D` ⇒ null (existing cases unchanged). Done when: that
  test file passes.

- [x] 6. Bad-key classifier in `src/lib/youtube-api.ts` (spec Design §4, first part). Change
  signature to `classifyYoutubeApiError(status: number, reasons: string[])`: bad-key if status
  403 and any reason ∈ {`keyInvalid`, `forbidden`, `accessNotConfigured`}, or status 400 and
  any reason ∈ {`API_KEY_INVALID`, `API_KEY_EXPIRED`, `keyInvalid`, `keyExpired`}; everything
  else transient (generic 400 `badRequest` alone and 403 `quotaExceeded` stay transient). In
  `fetchVideoDurations`'s `!res.ok` branch, collect reasons from both
  `error.errors[0].reason` and every `error.details[]` entry's `reason` (body order; tolerate
  non-array/malformed `details`, wrap in the existing try/catch). `failure.reason` = first
  matching key reason when bad-key, else first reason found, else `http-<status>`. Update every
  existing `classifyYoutubeApiError` call in `test/lib/youtube-api.test.ts` (~lines 28–60) to
  the array signature (`(403, ["keyInvalid"])`, `(400, [])`) and add: 400 + `["badRequest",
  "API_KEY_INVALID"]` ⇒ bad-key; 400 `keyInvalid` and `keyExpired` ⇒ bad-key; 400
  `["badRequest"]` ⇒ transient; 403 `quotaExceeded` ⇒ transient. Add a `fetchVideoDurations`
  test using a real-shaped Google 400 body (`error.errors[0].reason = "badRequest"`,
  `error.details[].reason = "API_KEY_INVALID"`) ⇒ `failure.class === "bad-key"`, reason
  `API_KEY_INVALID`. Then in `test/lib/duration-enrichment.test.ts` add the same real-shape
  400 body case to the sweep tests: it latches (next sweep makes no fetch), alongside the
  existing 403 `badKeyResponse()` case. Done when: both test files pass and `bun test` is green.

- [x] 7. Empty-key handling in `src/lib/duration-enrichment.ts` + `.env.example` (spec Design
  §4, "Empty key"). Replace the module-load `apiKey` read with: `const rawKey =
  process.env.YOUTUBE_API_KEY?.trim(); const apiKey = rawKey ? rawKey : undefined;` (trimmed
  value is used as the key; `undefined`, empty, or whitespace-only ⇒ disabled and the existing
  "disabled" `logger.info` fires). Update the `.env.example` YOUTUBE_API_KEY comment (~line
  43–47) to say an empty value also means disabled. Test in
  `test/lib/duration-enrichment.test.ts` using the existing `loadSweepModule` fresh-module
  helper: empty string and whitespace-only key ⇒ sweep makes no fetch call. Done when: the
  test passes and `bun test` is green.

- [x] 8. Schema: add nullable `durationRecheckAt: integer("duration_recheck_at", { mode:
  "timestamp" })` to `videos` in `src/db/schema.ts` (no CHECK, no default; add a short comment:
  "don't re-request before"). Do NOT add it to the ingest upsert's `set` list (it's untouched
  — verify). **Then hand the user the command to run in their own terminal** (needs a TTY;
  don't run it yourself): `devcontainer exec --docker-path podman --workspace-folder . bunx
  drizzle-kit generate`, and wait for them to report back. Verify the generated
  `drizzle/NNNN_*.sql`: it must be a plain `ALTER TABLE \`videos\` ADD \`duration_recheck_at\`
  integer;`. If a table rebuild appears instead, its `INSERT … SELECT` must NOT reference
  `duration_recheck_at` (spec029 task 12 phantom-column corruption) — fix by hand if needed.
  Done when: migration file exists and is correct, `bunx tsc --noEmit` passes, `bun test` green
  (migrations apply in test DBs).

- [x] 9. `returnedIds` in `fetchVideoDurations` (`src/lib/youtube-api.ts`, spec Design §3
  "Distinguishing"). Add `returnedIds: Set<string>` to `FetchVideoDurationsResult`; on every
  failure return path it is an empty `Set`; on success, add each item's string `id` to it
  immediately after the `typeof item.id !== "string"` check and **before** the
  `continue` for a missing/non-string `contentDetails.duration`. Fix any existing test/type
  fallout (object literals of the result type, `test/lib/duration-enrichment.test.ts`
  mocks only mock `fetch`, so likely none). Tests in `test/lib/youtube-api.test.ts`:
  `returnedIds` includes items whose duration is `P0D`, unparseable, or missing; excludes
  items without a string id; empty on failure. Done when: those tests pass and
  `bunx tsc --noEmit` is clean.

- [x] 10. Starvation fix in `src/lib/duration-enrichment.ts` (spec Design §3 "Stamping rule" and
  "Eligibility"; depends on tasks 8 and 9). (a) `eligibleVideos(now = new Date(), limit =
  BATCH_SIZE)` adds `or(isNull(videos.durationRecheckAt), lte(videos.durationRecheckAt,
  now))` to the `and(...)` (import `or`, `lte`). (b) `runDurationEnrichmentSweep(now = new
  Date())` passes `now` through. (c) After a successful response (`failure === null`), in
  **one `db.transaction`** (sync): set `durationSeconds` for resolved videos as today, and for
  each batch video with no `durations` entry set `durationRecheckAt` = `now + 1h` if
  `returnedIds.has(id)` else `now + 24h`. Failures (transient/bad-key) never stamp. (d) Tests
  in `test/lib/duration-enrichment.test.ts` (inject `now`; compare at whole-second precision;
  **every new test `discard()`s its rows** so stamped leftovers don't leak into the shared
  pool): `P0D` item stamped `now+1h`; omitted item stamped `now+24h`; neither re-eligible
  (not re-requested) until their time passes, then re-requested; transient failure stamps
  nothing; 50 videos with future `duration_recheck_at` don't block an older resolvable one
  (resolvable one gets its duration); adjust the existing "writes durationSeconds… missing"
  test's assertions so `missing` is now stamped +24h. Done when: `bun test
  test/lib/duration-enrichment.test.ts` passes and `bun test` is green.

- [x] 11. Index check (spec Design §3 "Index"). Run `EXPLAIN QUERY PLAN` (write the script to a
  file and run via `devcontainer exec`, per CLAUDE.md — not inline `bun -e`) on the new
  eligibility query against the dev DB (or a test DB seeded with a few hundred rows). Record
  the plan and the decision (add index or not, and why) as a short note appended under this
  task in this file. Add a composite index in `src/db/schema.ts` + migration (hand the user the
  `drizzle-kit generate` command again) **only** if the plan shows a full-table scan that
  matters at this project's scale; otherwise no code change. Done when: note recorded;
  `bun test` and `bunx tsc --noEmit` green.

  **Result (2026-10-03):** `EXPLAIN QUERY PLAN` on the new eligibility query (fresh migrated DB,
  500 seeded videos, `ANALYZE` run) shows `SCAN videos`, `LIST SUBQUERY` over `SCAN subscriptions`
  (+ bloom filter), and `USE TEMP B-TREE FOR ORDER BY` — a full table scan plus a sort.
  **Decision: no index, no code change.** The scan is over a personal-scale table (thousands of
  rows at most) run once per minute, costing microseconds; no existing index
  (`status, published_at, id`, etc.) would let SQLite skip both the scan and the sort given the
  null-duration/recheck predicates, and an extra index would add write cost on every ingest for
  no measurable gain. Consistent with spec029's posture. Revisit only if the videos table grows
  by orders of magnitude.

- [ ] 12. spec029 cross-reference pointers in `docs/specs/029-video-duration-enrichment.md`
  (spec030 "Cross-references"; pointers only, no rewrites): (a) at the "stays eligible until it
  succeeds" language (~lines 100–102) and the omitted-item sentence (~lines 187–189): pointer
  to spec030's recheck windows; (b) at the Error handling section: generic 400 stays transient
  but 400 `API_KEY_INVALID`/`API_KEY_EXPIRED`/`keyInvalid`/`keyExpired` now latch, since
  Google's real invalid-key response has a generic `errors[0].reason`; (c) at the composite-
  index note (~line 134): re-evaluate with the new predicate (result recorded in spec030's task
  file task 11). Use the inline `(refined in docs/specs/030-…md)` style. Done when: all three
  pointers exist.

- [ ] 13. Full verification: run `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run
  fallow` across the repo (all via `devcontainer exec`), all clean. Fix anything surfaced
  (fallow: e.g. unused exports). Done when: all four exit 0.

- [ ] 14. Manual end-to-end verification (spec "Final verification").
  **Claude performs directly** (curl from inside the devcontainer; `scripts/dev-login.sh` for
  the cookie jar; any DB scripts written to a file, not inline `bun -e`; clean up rows/files
  afterward): start `bun run dev` in the container; start a throwaway local stub HTTP server
  (script file) serving (i) `hello` non-XML, (ii) a >2 MiB body with and without
  Content-Length, (iii) a valid small feed; confirm `POST /subscriptions/preview` against each
  returns the friendly "Couldn't fetch that channel's feed." error for (i)/(ii) and no 500 (the
  routes may require a channel URL that resolves to the stub — if that can't be reached via
  the real resolver, exercise `fetchChannelFeed` directly with a one-off script instead and
  say so); confirm the `app.onError` log format by forcing an unhandled error (e.g. a
  temporary route or a request that throws) and checking the dev log shows `Unhandled request
  error` with method/path, then revert any temporary change; SQLite-read `duration_recheck_at`
  on a throwaway unresolvable video after a sweep (with a fake/invalid API key the sweep
  latches — note the expected `Duration enrichment disabled: bad API key` log for Google's real
  400 response if network allows). Stop the dev server by `/proc` PID scan (CLAUDE.md).
  **User performs live in a browser:** at `http://localhost:3000/subscriptions` (port
  forwarding works in their editor devcontainer), subscribe flow with a URL whose feed is
  invalid — look for the friendly error message swapping in without a full page reload.
  Done when: Claude's checks pass and the user reports the browser check as expected.

- [ ] 15. Mark spec030 `status: implemented` in its frontmatter, then open the PR. **Check
  this box (and commit the spec status flip + box) BEFORE pushing** — deliberate inversion per
  CLAUDE.md so the pushed branch carries a fully checked-off task file. Ask the user whether
  they are pushing or want Claude to (never push without asking). PR (via `gh pr create`
  after push) from `spec/ingestion-enrichment-robustness` to `main` with a summary and test
  plan, ending with the Claude Code attribution line. Never merge. Done when: PR is open (or
  the user confirmed they'll push and open it) and `pr.yml`'s five checks (`lint`, `test`,
  `typecheck`, `docker-build-check`, `fallow`) are being run.
