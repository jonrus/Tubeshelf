# Tasks: MVP Completion Gaps
Spec: docs/specs/008-mvp-completion-gaps.md
Generated: 2026-07-26

- [x] 1. Add subscribe-page channel ID discovery copy per the spec's Design #1: in
  `src/views/subscribe-confirm.tsx`'s `BlankSubscribeForm`, add a short instructional
  paragraph (the spec's suggested wording is fine, adjust only for clarity) explaining that
  the input accepts a bare channel ID (`UC...`), a URL containing `/channel/UC.../`, or the
  channel's RSS feed URL, and how to find the ID via the channel page's view-source —
  done when: the paragraph renders above or below the `channelInput` field and `bun run
  lint` is clean. No route/schema change in this step.

- [x] 2. Schema changes per the spec's Design #2 and #4, all in `src/db/schema.ts`:
  - Export `CATEGORY_NAME_MAX_LENGTH = 100` as a top-level constant in this file (not in
    `src/routes/categories.tsx` — see the spec's task-decomposition retrospective in Open
    Questions for why).
  - Convert the `categories` table definition to the array-callback form (matching how
    `videos` already does it) and add `check("name_length_check", sql\`length(${t.name}) <=
    ${sql.raw(String(CATEGORY_NAME_MAX_LENGTH))}\`)` to it.
  - On `youtubeChannels`: remove `possibleMissedVideos: integer("possible_missed_videos", {
    mode: "boolean" }).notNull().default(false)`; add
    `possibleMissedVideosDetectedAt: integer("possible_missed_videos_detected_at", { mode:
    "timestamp" })` (nullable, no default) in its place.
  - On `subscriptions`: add `missedVideosDismissedAt: integer("missed_videos_dismissed_at",
    { mode: "timestamp" })` (nullable, no default).

  Done when: all four changes are present, `bun run lint` is clean. `bunx tsc --noEmit`
  will show errors in `src/lib/ingest.ts` (still references `possibleMissedVideos`) at this
  point — expected, fixed in task 4; don't try to make this step tsc-clean in isolation.

- [x] 3. Generate and hand-fix the migration for task 2's schema changes:
  - Run `bun run db:generate` (via `devcontainer exec`, per CLAUDE.md). If `drizzle-kit`
    prompts interactively to disambiguate a column/table rename vs. drop+add (the same
    class of TTY prompt CLAUDE.md documents for `drizzle-kit generate`), stop and hand the
    exact command to the user to run in their own terminal — do not attempt a workaround,
    and do not accept a "rename" answer yourself if a prompt is somehow avoidable
    programmatically: per the spec's Design #4 migration note, a "rename"
    disambiguation for `possible_missed_videos` → `possible_missed_videos_detected_at`
    would silently corrupt every row (both `0` and `1` become non-null, nonsensical
    timestamps under `RENAME COLUMN`, triggering a false-positive badge on every
    subscription).
  - Once generated, open the new migration file under `drizzle/`. Confirm it rebuilds both
    `categories` (create `__new_categories` with the `name_length_check` constraint,
    copy, drop, rename — matching the pattern already in `drizzle/0003_redundant_sprite.sql`
    for `videos`) and `youtube_channels` (same rebuild pattern, dropping
    `possible_missed_videos` and adding `possible_missed_videos_detected_at`), plus a plain
    `` ALTER TABLE `subscriptions` ADD `missed_videos_dismissed_at` integer `` for the
    additive `subscriptions` change (no rebuild needed there, no `CHECK` constraint
    involved — matches the additive-column style already in
    `drizzle/0002_past_yellowjacket.sql`).
  - **Hand-edit the generated `youtube_channels` rebuild's `INSERT INTO
    __new_youtube_channels (...) SELECT ...` statement** (auto-generated to select a plain
    `NULL` for the new column, matching the `NULL` pattern already visible for
    `watched_at` in `drizzle/0003_redundant_sprite.sql`): replace that `NULL` in the
    `SELECT` list with `CASE WHEN "possible_missed_videos" = 1 THEN COALESCE
    ("last_fetched_at", unixepoch()) ELSE NULL END` so channels already flagged before this
    migration keep a non-null detection timestamp instead of silently losing their pending
    notice (per the spec's Design #4 backfill note).
  - Done when: the migration file contains the three changes above (with the hand-edited
    `CASE` expression in place of the auto-generated `NULL`), and `bun test` passes (the
    smoke test and every `*.test.ts` module that runs `migrate(db, { migrationsFolder:
    "./drizzle" })` against a fresh in-memory DB will fail otherwise).

- [ ] 4. Update `src/lib/ingest.ts`'s `applyFeedToChannel` per the spec's Design #4: change
  `...(gapDetected ? { possibleMissedVideos: true } : {})` to `...(gapDetected ?
  { possibleMissedVideosDetectedAt: now } : {})`, and update the adjacent comment ("Never
  auto-clears an existing true flag...") to say dismissal now lives on `subscriptions`, not
  here. Then update `test/lib/ingest.test.ts`'s six existing assertions on
  `channelRow(channel.id).possibleMissedVideos` (lines ~213, 230, 244, 272, 290 as of this
  writing) to check `possibleMissedVideosDetectedAt` instead: `.toBe(false)` becomes
  `.toBeNull()`; `.toBe(true)` becomes an assertion that the value is a non-null `Date`. For
  the "does not clear an already-true flag on a subsequent gap-free ingest" test
  specifically, capture the detected timestamp after the gap first fires and assert it is
  unchanged (`toEqual`, not just non-null) after the gap-free ingest, so the test still
  proves the value isn't reset, not merely that it's still non-null — done when: `bun test
  test/lib/ingest.test.ts` passes with these updated assertions and `bun run lint` is clean.

- [ ] 5. Update `src/lib/subscribe.ts`'s `upsertSubscription` per the spec's Design #4
  ("New subscriptions must not inherit a pre-existing, pre-subscription gap"): in the
  `"created"` branch's `db.insert(subscriptions).values({...})` call, add
  `missedVideosDismissedAt: new Date()` to the inserted values (the `"reactivated"` branch
  in `reactivateOrReject` needs no change — it must keep reusing the existing row's
  `missedVideosDismissedAt` untouched). Add a test to `test/lib/subscribe.test.ts` covering
  this: create a channel, set its `possibleMissedVideosDetectedAt` to a past timestamp
  directly via `db.update(youtubeChannels)...`, then call `upsertSubscription` for a
  first-time subscriber and assert the returned `"created"` subscription's
  `missedVideosDismissedAt` is non-null and `>=` the channel's `possibleMissedVideosDetectedAt`
  — done when: `bun test test/lib/subscribe.test.ts` passes including this new case and
  `bun run lint` is clean.

- [ ] 6. Add category name length-limit validation to the existing `POST /categories`
  create route in `src/routes/categories.tsx`, per the spec's Design #2: import
  `CATEGORY_NAME_MAX_LENGTH` from `../db/schema`, and reject a trimmed `name` longer than it
  (using the existing `CategoriesList` error-message pattern, e.g. `` `Category name must be
  ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.` ``) before the existing empty-name check.
  Create `test/routes/categories.test.ts` (no test file exists yet for this route — model
  its setup on `test/routes/channels.test.ts`'s structure: `DB_FILE_NAME=":memory:"` set
  before any `src/db/client` import, `migrate()` + `seed()`, then dynamic imports of the
  route module) covering: creating a category over the length limit is rejected with the
  length error and not inserted; creating one at or under the limit succeeds; the existing
  empty-name, reserved-name, and duplicate-name behaviors (already implemented, not new,
  but currently untested) all still pass — done when: `bun test test/routes/categories.test.ts`
  passes covering all of the above and `bun run lint` is clean.

- [ ] 7. Add category rename per the spec's Design #3:
  - `src/views/categories-list.tsx`: add an `editingId?: number` prop to `CategoriesList`.
    When a row's `category.id === editingId`, render the inline edit `<form>` (`hx-post
    /categories/{id}`, `hx-target #category-list`, `hx-swap outerHTML`, text input
    pre-filled with `category.name`, "Save" button) plus a "Cancel" button (`hx-get
    /categories`, `hx-select #category-list`, `hx-target #category-list`, `hx-swap
    outerHTML`) — mirror `src/views/ignore-rules-list.tsx`'s edit-toggle structure exactly.
    Non-editing rows get an "Edit" button (`hx-get /categories/{id}/edit`) next to the name,
    **except** the system category (`category.isSystem`), which renders no Edit button (it
    already shows `[system]`).
  - `src/routes/categories.tsx`: add `GET /categories/:id/edit` (look up by id; if not
    found or `isSystem`, just return `<CategoriesList categories={listCategories()} />`
    unedited rather than an error — this path is only reachable by a hand-crafted request,
    not the UI built here) and `POST /categories/:id` (look up by id first: not found →
    `c.notFound()`; `isSystem` → return the list with error `"Cannot rename the system
    category."`; otherwise apply the same three validations as create — length limit,
    empty name, reserved name `"uncategorized"` case-insensitive — then attempt
    `db.update(categories).set({ name }).where(eq(categories.id, id))`, catching `UNIQUE
    constraint failed` the same way create does; on success return
    `<CategoriesList categories={listCategories()} />` with no `editingId`).
  - `src/db/seed.ts`: change the idempotency check from `where(eq(categories.name,
    "Uncategorized"))` to `where(eq(categories.isSystem, true))`, per the spec's Design #3
    fragility note (this is the first spec making the category name mutable even in
    principle).
  - Extend `test/routes/categories.test.ts` (from task 6) with: renaming a non-system
    category succeeds and the new name appears in the list; renaming to a name over the
    length limit / empty / the reserved name / an already-used name is each rejected with
    the matching error and the row's name is unchanged; attempting to rename the system
    category (both via `POST /categories/:id` directly and via `GET
    /categories/:id/edit`) is rejected/no-ops rather than changing its name; renaming a
    nonexistent id 404s.
  - Done when: `bun test test/routes/categories.test.ts` passes covering all of the above
    and `bun run lint` is clean.

- [ ] 8. Wire up per-subscription missed-videos display and dismissal in
  `src/routes/channels.tsx` and `src/views/subscription-list.tsx`, per the spec's Design #4:
  - Add a small helper (e.g. `hasUndismissedGap(detectedAt: Date | null, dismissedAt: Date |
    null): boolean`) returning `detectedAt !== null && (dismissedAt === null || dismissedAt <
    detectedAt)`.
  - Update `listActiveSubscriptions` to also select
    `youtubeChannels.possibleMissedVideosDetectedAt` and
    `subscriptions.missedVideosDismissedAt`, then map each result row to attach
    `showMissedVideosBadge: hasUndismissedGap(...)` (dropping the two raw timestamp fields
    from what's passed to the view — the view only needs the computed boolean).
  - Add `POST /subscriptions/:id/dismiss-missed-videos`: same ownership-scoping as the
    existing `DELETE /subscriptions/:id` (`WHERE id = :id AND userId = currentUser.id AND
    unsubscribedAt IS NULL`), sets `missedVideosDismissedAt = new Date()`, returns
    `c.notFound()` if no row matched, otherwise the re-rendered `SubscriptionList`.
  - `src/views/subscription-list.tsx`: extend the `Subscription` type with
    `showMissedVideosBadge: boolean`; when true, render a short notice (e.g. "⚠ Possible
    missed videos") and a "Dismiss" button (`hx-post
    /subscriptions/{id}/dismiss-missed-videos`, `hx-target #subscription-list`, `hx-swap
    outerHTML`) inline next to that row's existing "Unsubscribe" button.
  - Add tests to `test/routes/channels.test.ts` covering: a subscription to a channel with a
    detected gap and no dismissal shows the badge; dismissing it removes the badge and
    responds with the re-rendered list; a dismissal timestamp older than the channel's
    (re-)detection timestamp still shows the badge (a later, independent gap re-triggers
    it); dismissing another user's subscription 404s; dismissing an already-unsubscribed
    subscription 404s; a **brand-new** subscription to a channel that already has an old
    `possibleMissedVideosDetectedAt` from before the subscription existed does **not** show
    the badge (per task 5's fix).
  - Done when: `bun test test/routes/channels.test.ts` passes covering all of the above and
    `bun run lint` is clean.

- [ ] 9. Run full verification across the repo: `bun test`, `bun run lint`, and `bunx tsc
  --noEmit` — done when: all three exit 0 with no failures/errors (per CLAUDE.md, this spec
  isn't done until all three are clean, not just the first two).

## Manual end-to-end verification (once all tasks above are checked off)

Split by who performs it — don't blur these two roles when executing this section:

**Claude performs directly (`curl` from inside the devcontainer, plus direct SQLite reads —
no browser, no user action needed):** these confirm server-side behavior and response HTML,
which covers everything except how it actually looks/feels live in a browser.
- `curl` `GET /channels` and grep the response for the new subscribe-page instructional
  copy (task 1).
- `curl -X POST /categories` with a 101+ character `name` and confirm the length-limit error
  in the response, not a 200-with-insert; then with a name at exactly 100 chars and confirm
  it succeeds (task 6).
- `curl` `GET /categories` and confirm the system "Uncategorized" row's `<li>` has no Edit
  button/link in the returned HTML; `curl -X POST /categories/:id` against the system
  category's id directly and confirm it's rejected with the "Cannot rename the system
  category." error, not a 200 that changed its name (task 7).
- `curl -X POST /categories/:id` to rename a real category, then `curl` `GET /channels` and
  the queue view (`GET /queue`) and grep both responses for the new name (proves the FK-join
  propagation) and confirm the old name is gone from both (task 7).
- Using a direct SQLite write (e.g. `bun run` a one-off script, or `sqlite3` against the dev
  DB file) to set a channel's `possible_missed_videos_detected_at` to a past timestamp for a
  subscribed channel, then `curl` `GET /channels` and confirm the notice/Dismiss button
  markup is present for that row; `curl -X POST /subscriptions/:id/dismiss-missed-videos`
  and confirm a follow-up `GET /channels` no longer shows it for that row (task 8).

**User performs live in a browser** (things `curl` can't observe — actual HTMX swap
behavior, visual rendering, the real subscribe/rename/dismiss click-through experience):
Claude will give you the exact URL and click/type target for each step below and tell you
what to look for; you drive the browser and report back what you see.
1. Open `/channels`, read the new instructional copy near the subscribe input — does it
   read clearly and match what's actually needed to find a channel ID?
2. Open `/categories`. Try adding a category with a very long name (Claude will give you a
   100+ character string to paste) and confirm the error appears inline without a full page
   reload. Add a normal one, click its Edit button, change the name, click Save — confirm
   the row updates in place (no full-page reload/flash) and the "Uncategorized" row has no
   Edit button at all.
3. Go to `/channels`, subscribe that renamed category's channel (or an existing one) to
   confirm the dropdown shows the new name; check the queue view's category filter links do
   too.
4. Back on `/channels`, for the channel Claude flagged via direct DB write in step 4 above,
   confirm the "possible missed videos" notice is visible, click Dismiss, and confirm it
   disappears via a partial swap (no full page reload/flash) rather than a full navigation.
