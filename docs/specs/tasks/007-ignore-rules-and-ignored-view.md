# Tasks: Ignore Rules and Ignored View
Spec: docs/specs/007-ignore-rules-and-ignored-view.md
Generated: 2026-07-25

- [ ] 1. Create `src/lib/ignore-rules.ts` with `listIgnoreRules()`, `matchesAnyRule(video,
  rules)`, and `reconcileIgnoreRules(): void` exactly per the spec's Design >
  `src/lib/ignore-rules.ts` (new) section (exact code sketched there, including the
  `db.transaction((tx) => {...})` wrapper around both select/update passes — confirm this
  compiles against the installed `drizzle-orm@0.45.2`'s `bun-sqlite` transaction API,
  same "verify novel Drizzle shape at implementation time" posture flagged repeatedly in
  prior specs; if `db.transaction` doesn't behave as sketched, fall back to two
  sequential non-transactional passes as spec006-era code does elsewhere, but that
  should not be needed). This file has no callers yet — that's fine, later tasks wire it
  in. Also create `test/lib/ignore-rules.test.ts` (new), modeled on the existing
  `test/lib/ingest.test.ts`'s structure (module-level `DB_FILE_NAME=":memory:"` set
  before any `src/db/client` import, `migrate(db, { migrationsFolder: "./drizzle" })`,
  local `makeChannel`/`makeVideo`-style fixture helpers), covering the spec's Testing >
  `test/lib/ignore-rules.test.ts` bullets: `matchesAnyRule` matches a title substring
  case-insensitively, matches a description substring, doesn't match when neither field
  contains any rule's keyword, and an empty rule set never matches anything;
  `reconcileIgnoreRules` — an `ignored`+`auto` video whose only matching rule was deleted
  reverts to `unwatched` with `ignoreMethod: null`; an `unwatched` video newly matching a
  just-added rule becomes `ignored`+`auto`; a `watching` video newly matching a rule also
  becomes `ignored`+`auto` (explicit coverage, not just `unwatched`); a `watched` video
  that would match a rule is left untouched; an `ignored`+`manual` video is left
  untouched by both directions even when it would/wouldn't match current rules. Done
  when: `bun run lint` is clean, `bunx tsc --noEmit` reports no new errors, and `bun test
  test/lib/ignore-rules.test.ts` passes covering all of the above.

- [ ] 2. Wire keyword matching into `applyFeedToChannel` in `src/lib/ingest.ts` (function
  starts at `ingest.ts:20`, its `.values({...})`/`.onConflictDoUpdate({...})` upsert
  starts around `ingest.ts:31`) per the spec's Design > `src/lib/ingest.ts` changes
  section: import `listIgnoreRules`/`matchesAnyRule` from `./ignore-rules` (task 1), call
  `listIgnoreRules()` once per `applyFeedToChannel` invocation (not once per feed entry),
  compute `matchesAnyRule({ title: entry.title, description: entry.description }, rules)`
  per entry, and conditionally spread `{ status: "ignored", ignoreMethod: "auto" }` into
  that entry's `.values({...})` call when it matches. Do **not** add status/ignoreMethod
  to the `onConflictDoUpdate`'s `set` clause — leaving them out there (already the case
  today) is exactly what makes this insert-time-only, no extra "does this row already
  exist" check needed. Extend `test/lib/ingest.test.ts` per the spec's Testing section: a
  feed entry matching an existing `IgnoreRule` is inserted as `ignored`/`auto` on first
  ingestion (add an `IgnoreRule` fixture row via `db.insert(ignoreRules)...` before
  calling `applyFeedToChannel`); the same video, re-ingested on a later poll with a
  changed title that would now match a rule it didn't originally, keeps its existing
  status/ignoreMethod unchanged (proves the insert-time-only semantics — this can extend
  the existing "re-ingesting an existing video updates title/description/publishedAt
  without touching status/ignoreMethod" test at `ingest.test.ts:88` or be a new test
  alongside it). Done when: `bun run lint` is clean, `bunx tsc --noEmit` reports no new
  errors, and `bun test test/lib/ingest.test.ts` passes covering both new cases plus all
  pre-existing tests unmodified.

- [ ] 3. In `src/lib/watch-status.ts`, add `ignoreMethod: null` to the `.set({...})` call
  in each of the three existing functions — `setWatching` (`watch-status.ts:5`),
  `toggleQueueStatus` (`:32`), `toggleWatchedFromWatchingPage` (`:65`) — exactly per the
  spec's Design > `src/lib/watch-status.ts` changes section's full sketches of all
  three (only the new `ignoreMethod: null` line is new in each; every other line is
  unchanged). Add the two new functions `ignoreVideo(videoId): { status: "ignored" } |
  null` and `unignoreVideo(videoId): { status: "unwatched" } | null` per the same
  section's sketch — note `unignoreVideo` must clear **both** `ignoreMethod: null` and
  `watchedAt: null` (not just `ignoreMethod`), per the spec's documented fix for a
  `watched_at_check` constraint violation that an earlier draft of this function would
  have hit. Extend `test/lib/watch-status.test.ts` (this file currently only tests the
  three pre-existing functions, per its structure at the top of the file): add a
  regression test per existing function proving it now clears a stale `ignoreMethod` —
  e.g. create a video via the existing `makeVideo` helper with `status: "watching"` (or
  whichever source status fits each function) and directly `db.update(videos).set({
  ignoreMethod: "auto" }).where(...)` to simulate the stale-state scenario the spec's
  Design section describes, then call the function and assert `ignoreMethod` is `null`
  afterward — cover all three functions, not just one (this is the spec's Testing >
  `test/lib/watch-status.test.ts` extension section, added there after being caught as
  a gap during this task file's own decomposition pass). Add new tests for `ignoreVideo`: transitions `unwatched`
  to `ignored`/`manual` and clears `watchedAt`; transitions `watching` to
  `ignored`/`manual`; returns `null` for a nonexistent id. Add new tests for
  `unignoreVideo`: transitions `ignored`/`manual` to `unwatched` with `ignoreMethod:
  null`; transitions `ignored`/`auto` to `unwatched` with `ignoreMethod: null` (cover
  both source `ignoreMethod` values); transitions a `watched` video (non-null
  `watchedAt`) to `unwatched` with `watchedAt` cleared to `null` and does not throw (the
  direct unit-level version of the crash regression the spec's Design section
  documents); returns `null` for a nonexistent id. Done when: `bun run lint` is clean,
  `bunx tsc --noEmit` reports no new errors, and `bun test test/lib/watch-status.test.ts`
  passes covering all of the above plus all pre-existing tests unmodified.

- [ ] 4. In `src/views/queue-list.tsx`, add the `IgnoredRow` type, extend
  `QueueListProps`'s union with the `"ignored"` variant, and add `ignoreHref`/
  `unignoreHref` helpers, exactly per the spec's Design > `src/views/queue-list.tsx`
  changes section (note `IgnoredRow.ignoreMethod` must be typed `"manual" | "auto" |
  null`, **not** non-nullable — this matches what `videos.ignoreMethod`'s missing
  `.notNull()` actually makes Drizzle infer, per the spec's documented type-error fix).
  Rewrite `QueueList`'s body (currently `queue-list.tsx:81` onward) into the three-way
  branch on `props.view` (`watched` / `ignored` / queue+continue-watching) fully sketched
  in that section — the `ignored` branch renders plain (non-clickable) title text, the
  conditional `[manual]`/`[auto]` annotation, and an Un-ignore button; the existing
  queue/continue-watching branch gains a second "Ignore" button next to the existing
  toggle button, using `ignoreHref`. Do not change `src/routes/queue.tsx` in this step —
  no route yet passes `view="ignored"` or calls `ignoreHref`/`unignoreHref`, so this step
  is additive-only and the existing `queue`/`continue-watching`/`watched` render paths
  must produce byte-identical output to today. Done when: `bun run lint` is clean, `bunx
  tsc --noEmit` reports no new errors, and `bun test test/routes/queue.test.ts` still
  passes unmodified (proves the rewritten render body didn't change existing output).

- [ ] 5. Wire the Ignored view and ignore/unignore routes into `src/routes/queue.tsx` per
  the spec's Design > `src/routes/queue.tsx` changes section: add the `ignoredVideos`
  query function (same shape as `continueWatchingVideos` at `queue.tsx:58`, scoped to
  active subscriptions, `status = 'ignored'`, selecting `ignoreMethod`), the
  `buildIgnoredHref` helper (same shape as `buildWatchedHref` at `queue.tsx:275`), the
  `GET /ignored` route handler, and the `POST /videos/:id/ignore`/`POST
  /videos/:id/unignore` route handlers (import `ignoreVideo`/`unignoreVideo` from
  `../lib/watch-status` alongside the existing `setWatching`/`toggleQueueStatus`/
  `toggleWatchedFromWatchingPage` import at `queue.tsx:11-15`). `POST
  /videos/:id/ignore` must mirror `POST /videos/:id/toggle`'s (`queue.tsx:364`) exact
  `view`/`sort`/`category` reading and two-branch re-render (both the
  `continue-watching` branch and the default `queue` branch must pass `category`
  through — this is the same "cover both view branches" slip spec006 already flagged).
  Add the "Ignored" nav link to `src/views/layout.tsx`'s `<nav>` (currently
  `layout.tsx:26-31`), after the existing "Watched" link. Done when: `bun run lint` is
  clean, `bunx tsc --noEmit` reports no new errors, `bun test test/routes/queue.test.ts`
  still passes unmodified (proves nothing pre-existing broke), and manually curling
  `/ignored` and `POST /videos/:id/ignore`/`POST /videos/:id/unignore` from inside the
  devcontainer behave as the spec describes.

- [ ] 6. Add core functional test coverage to `test/routes/queue.test.ts` per the spec's
  Testing > `test/routes/queue.test.ts` extension bullets (excluding the end-to-end
  round-trip bullet — that's task 7): `POST /videos/:id/ignore?view=queue&...` and
  `?view=continue-watching&...` both set the video to `ignored`/`manual` and remove it
  from the respective re-rendered list (cover both `view` branches explicitly, same
  reasoning as the existing `/videos/:id/toggle` dual-branch tests); `GET /ignored`
  lists only `ignored` videos scoped to active subscriptions, an ignored video whose
  channel has since been unsubscribed does **not** appear (the one behavioral
  difference from `/watched`), `?category=<id>` filters correctly including to the
  Uncategorized category, and an invalid/nonexistent `category` falls back to
  unfiltered; `POST /videos/:id/unignore` reverts both an `ignored`/`manual` video and
  an `ignored`/`auto` video to `unwatched` with `ignoreMethod: null` (cover both source
  values); `POST /videos/:id/unignore` against a video whose status is currently
  `watched` (non-null `watchedAt`) does **not** throw/500 and clears `watchedAt` to
  `null` alongside `status: 'unwatched'` (the route-level regression test for the crash
  the spec's Design section documents); category-filter round trip for `/ignored`'s
  picker links (each existing category plus "All" renders, same pattern as the other
  three views' existing coverage at `queue.test.ts:363`). Done when: `bun test
  test/routes/queue.test.ts` passes covering all of the above plus all pre-existing
  tests unmodified.

- [ ] 7. Add the end-to-end row-button round trip tests to `test/routes/queue.test.ts`
  per the spec's Testing section's final bullet, modeled directly on the existing
  end-to-end row-link tests at `queue.test.ts:738` (`"End-to-end: a queue row's link
  round-trips through /watching/:id..."`) — same "parse the actual rendered attribute
  out of the response body via regex, don't hand-construct the URL" approach, just
  extracting an `hx-post="..."` attribute value instead of an `href="..."` one: (1) `GET
  /queue`, parse a row's rendered Ignore button's `hx-post` value, `POST` to that
  extracted URL, assert the video is gone from a fresh `GET /queue`; (2) repeat for
  `/continue-watching`'s Ignore button; (3) `GET /ignored`, parse a row's rendered
  Un-ignore button's `hx-post` value, `POST` to it, assert the video is gone from a
  fresh `GET /ignored` and reappears as `unwatched` on a fresh `GET /queue`. Done when:
  `bun test test/routes/queue.test.ts` passes covering all three round trips plus all
  pre-existing tests unmodified.

- [ ] 8. Create `src/routes/ignore-rules.tsx`, `src/views/ignore-rules-list.tsx`, and
  `src/views/ignore-rules-page.tsx` (all new) exactly per the spec's Design >
  `src/routes/ignore-rules.tsx` and `src/views/ignore-rules-list.tsx` +
  `ignore-rules-page.tsx` sections (full code sketched in both — `GET /ignore-rules`,
  `POST /ignore-rules` add with trimmed-empty-keyword validation, `GET
  /ignore-rules/:id/edit`, `POST /ignore-rules/:id` edit with the same validation and a
  404 for a nonexistent id, `DELETE /ignore-rules/:id` with a 404 for a nonexistent id —
  every mutating route calls `reconcileIgnoreRules()` from `../lib/ignore-rules` (task
  1) after its own DB write and before re-rendering). Register the new route in
  `src/index.ts`: import `ignoreRulesRoute` from `./routes/ignore-rules` alongside the
  existing three route imports, and add `app.route("/", ignoreRulesRoute);` alongside
  the existing three `app.route(...)` calls. Add the "Ignore Rules" nav link to
  `src/views/layout.tsx`'s `<nav>`, after the "Ignored" link added in task 5. Done when:
  `bun run lint` is clean, `bunx tsc --noEmit` reports no new errors, and manually
  curling `/ignore-rules` (GET/POST add/edit/delete) from inside the devcontainer
  behaves as the spec describes.

- [ ] 9. Create `test/routes/ignore-rules.test.ts` (new), modeled on the existing
  `test/routes/queue.test.ts`'s structure (module-level `DB_FILE_NAME=":memory:"`,
  `migrate(...)`, `seed(db)`, local fixture helpers), covering the spec's Testing >
  `test/routes/ignore-rules.test.ts` bullets: `GET /ignore-rules` lists existing rules;
  `POST /ignore-rules` adds a rule (empty/whitespace-only keyword rejected with an
  inline error, re-rendering the list unchanged) and a successful add triggers
  reconciliation (assert against a fixture `unwatched` video that newly matches the
  added keyword, becoming `ignored`/`auto`); `GET /ignore-rules/:id/edit` renders that
  row in edit mode (distinguishable in the response body, e.g. a rendered `<input
  value="...">` for that rule's current keyword); `POST /ignore-rules/:id` renames a
  rule (empty keyword rejected, staying in edit mode with an error; a nonexistent id
  404s) and triggers reconciliation (assert a fixture `ignored`/`auto` video that no
  longer matches the renamed keyword reverts to `unwatched`); `DELETE
  /ignore-rules/:id` removes a rule (nonexistent id 404s) and triggers reconciliation (a
  fixture `ignored`/`auto` video with no other matching rule reverts to `unwatched`).
  Every reconciliation assertion must go through the actual mutating HTTP route (not a
  direct `reconcileIgnoreRules()` call) — this is what proves the routes actually call
  it, not just that the function itself works (already covered in task 1's unit tests).
  Done when: `bun test test/routes/ignore-rules.test.ts` passes covering all of the
  above.

- [ ] 10. Run full verification: `bun test`, `bun run lint`, and `bunx tsc --noEmit`
  clean across the whole repo — done when all three commands exit 0 with no failures
  (the typecheck in particular catches issues neither `bun test` nor `bun run lint` run
  a full type-check for, per this project's established pattern of type errors slipping
  through until someone runs `tsc --noEmit` by hand). Once this passes, work through the
  spec's manual "Verification" section (steps 1–10) in a browser against the running
  devcontainer app and update the spec's frontmatter `status` to `implemented`.

Manual end-to-end verification (spec's "Verification" section, steps 1–10) is
browser/DB-driven and not part of this automated checklist — run it once all tasks
above are checked off, per task 10's note.
