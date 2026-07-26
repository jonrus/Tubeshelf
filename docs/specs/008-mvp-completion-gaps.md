---
status: in-progress
created: 2026-07-26
---

# MVP Completion Gaps

## Context

Specs 001–007 are all `status: implemented` with every task checked off, and
`docs/app_idea.md`'s 6 numbered MVP `Feature Scope` items all map to one of those specs.
But a two-stage blind audit (one subagent read only `app_idea.md` and extracted every
MVP-relevant requirement as a checklist; a second, separate subagent — with no access to
`app_idea.md` or source code — checked that checklist against the spec/task files only)
found that several requirements `app_idea.md` states as MVP behavior were never actually
built. A follow-up direct code check (grep against `src/`) confirmed all four:

1. **Feature Scope item 1** says "the subscribe page should include copy guiding \[the
   user\] to find \[the channel ID\] via `/channel/` or `channelId` in the channel's page
   source." No such copy exists in `src/views/subscribe-confirm.tsx` — the input field has
   no instructional text at all.
2. **Ingestion Notes** says the `possible_missed_videos` flag "is manually dismissed."
   `src/lib/ingest.ts`'s `applyFeedToChannel` sets the flag correctly on gap detection, but
   nothing anywhere reads, displays, or clears it — there is no dismiss action, and the flag
   isn't even surfaced as a read-only indicator on `/channels` (`SubscriptionList` doesn't
   join it in at all).
3. **Data Model & Schema > Category** says renaming "is supported by updating the Category
   row in place." `src/routes/categories.tsx` only has `GET /` and `POST /categories`
   (create) — no rename route exists, despite spec006 casually asserting elsewhere that
   category rename is "already built."
4. **Data Model & Schema > Category** also says the free-text name has "a reasonable length
   limit." The schema (`categories.name: text().notNull().unique()`) has no length
   constraint anywhere.

This spec closes all four gaps so `app_idea.md`'s MVP description is no longer aspirational
in these four places. `docs/app_idea.md` itself was already corrected in a prior session for
three *unrelated* internal contradictions found by the same audit (view-count wording, the
Watched view's stale MVP annotation, and the CSRF/rate-limiting "(MVP)" mislabel vs. the
*Path to v1.0* sequencing) — those are done and out of scope here; this spec is only about
the four undelivered requirements above.

While scoping item 2, a design question came up that isn't just an implementation detail:
`possible_missed_videos` currently lives on `youtube_channels` (the entity `app_idea.md`
already documents as global/shared across users, per spec002's Channel/Subscription split).
A single shared boolean means one user dismissing it silences the notice for every other
user subscribed to that channel. That's fine for MVP's single implicit user, but it's the
same shape of problem this project has already deliberately designed around once before —
`app_idea.md`'s Data Model section models `User` and `Subscription` now, even though MVP
runs as a single implicit user, specifically "so v2.0 multi-user support doesn't require a
breaking migration." The decision here (see Design #4) is to apply that same principle now
rather than deferring it to whatever future spec adds full multi-user support, since the
schema change involved is small and this spec is already touching the read/display path for
this exact flag.

## Scope

**In:**
1. Subscribe-page copy guiding users to find a channel ID.
2. A length limit on category names (create and rename), enforced both at the application
   layer and as a DB `CHECK` constraint.
3. Category rename, using the same inline edit-toggle HTMX pattern spec007 already
   established for `IgnoreRule` rows (`GET /ignore-rules/:id/edit` + `POST
   /ignore-rules/:id`). Includes a one-line fix to `src/db/seed.ts` (see Design #3) — this
   is the first spec that makes the system category's name mutable even in principle, so
   it's the right point to close a pre-existing fragility in its seed idempotency check
   before rename makes it reachable.
4. Per-subscription dismissal of the "possible missed videos" notice, replacing the current
   global-boolean shape with a per-channel *detection* timestamp and a per-subscription
   *dismissal* timestamp, plus the UI to display and dismiss it on `/channels`.

**Out (deferred, not this spec):**
- Full multi-user support (login, per-user data isolation beyond what spec002 already
  built, registration) — only the *schema shape* for item 4 is addressed now; the rest is
  unchanged, per `app_idea.md`'s existing Future Roadmap.
- Auth/CSRF/rate-limiting — already explicitly sequenced post-MVP-features, pre-deployment
  in `app_idea.md`'s *Path to v1.0* section; unaffected by this spec.
- Category delete — `app_idea.md` states no explicit delete operation is needed for MVP;
  unchanged here.
- Manually converting an auto-ignored video to manual ("locking it in") — already an
  explicit, documented deferral in spec007; unrelated to this spec.
- Backfilling actual missed videos once a gap is detected — `app_idea.md` is explicit that
  there's no way to backfill, only a "go check manually" signal; this spec only lets a user
  clear that signal for themselves, it doesn't change what triggers it or add recovery.
- Any change to gap-detection's *trigger* logic (still: oldest-in-feed newer than
  newest-already-stored, computed once per channel fetch in `applyFeedToChannel`) — only the
  *storage/display/dismissal* shape of the result changes.

## Design

### 1. Subscribe-page channel ID discovery copy

`parseChannelInput` (`src/lib/channel-input.ts`) already accepts three input forms: a bare
channel ID (`UC...`), any URL containing `/channel/UC.../`, and a URL with a `channel_id=`
query parameter (i.e., the RSS feed URL itself). `BlankSubscribeForm`
(`src/views/subscribe-confirm.tsx`) currently has no text explaining any of this beyond the
input's `placeholder="Channel ID or URL"`.

Add a short instructional paragraph above or below the input, e.g.:

> Paste the channel's ID (starts with `UC`), a URL containing `/channel/UC.../`, or the
> channel's RSS feed URL. To find the ID: open the channel's page, view source, and search
> for `channelId`.

Exact wording isn't load-bearing — this is copy, not logic — so the red-team pass should
sanity-check clarity/accuracy rather than treat the sentence above as final. No route or
schema change; this is a `BlankSubscribeForm` template edit only.

### 2. Category name length limit

Add `CATEGORY_NAME_MAX_LENGTH = 100` as an exported constant in `src/db/schema.ts`, not
`src/routes/categories.tsx` (the DB layer below needs it inside the `CHECK` constraint
expression, and `schema.ts` must not import from a route file — every existing dependency
in this codebase runs routes → schema, never the reverse; `categories.tsx` imports the
constant from `../db/schema` alongside the `categories` table it already imports from
there). 100 is a reasonable default for a free-text label used in `<select>` dropdowns and
filter links — `app_idea.md` doesn't specify a number, only "reasonable."

- **Application layer:** both `POST /categories` (create) and the new `POST
  /categories/:id` (rename, see #3) reject (with the existing `CategoriesList` error-message
  pattern) a trimmed name longer than `CATEGORY_NAME_MAX_LENGTH`, checked *before* the
  existing empty-name and reserved-name (`"uncategorized"`) checks, or after — order doesn't
  matter functionally since they're independent conditions, but checking length first avoids
  a wasted reserved-name comparison against an already-invalid input.
- **DB layer:** add a `CHECK` constraint on `categories`, mirroring the existing
  `check()` array-callback pattern used on `videos` (`status_check`, `ignore_method_check`,
  `watched_at_check` in `src/db/schema.ts`):
  ```ts
  check(
    "name_length_check",
    sql`length(${t.name}) <= ${sql.raw(String(CATEGORY_NAME_MAX_LENGTH))}`,
  ),
  ```
  SQLite's `length()` on a TEXT column counts characters, not bytes, which is what a
  "reasonable length limit" on a display label should mean. Using `sql.raw()` (available in
  the installed `drizzle-orm@0.45.2`) to splice `CATEGORY_NAME_MAX_LENGTH` directly into the
  `CHECK` constraint means the JS constant and the SQL literal can never drift apart by
  hand-edit — there's exactly one number to change, not two kept in sync by convention.
- This requires a new Drizzle migration (`bun run db:generate`). Adding a `CHECK` constraint
  to an existing SQLite table requires a table rebuild under the hood (SQLite has no `ALTER
  TABLE ... ADD CONSTRAINT`); Drizzle's generated migration will handle this as a
  create-new/copy-data/drop-old/rename sequence. Confirm the generated SQL actually copies
  existing `categories` rows before treating the migration as correct.

### 3. Category rename

Mirror spec007's `IgnoreRule` edit-toggle pattern exactly:

- `CategoriesList` (`src/views/categories-list.tsx`) gains an `editingId?: number` prop.
  When a row's `category.id === editingId`, render an inline `<form>` (`hx-post
  /categories/{id}`, `hx-target #category-list`, `hx-swap outerHTML`) with a text input
  pre-filled with the current name plus "Save", and a separate "Cancel" button (`hx-get
  /categories`, `hx-select #category-list`, `hx-target #category-list`, `hx-swap
  outerHTML`) — same two-button structure as `ignore-rules-list.tsx`. Otherwise render the
  plain name + an "Edit" button (`hx-get /categories/{id}/edit`) alongside the existing
  content.
  - **The system `Uncategorized` category never renders an Edit button** — matches how it's
    already excluded from the subscribe/channel `<select>` elements elsewhere
    (`listNonSystemCategories`). It already renders `[system]` next to its name; that's
    enough to explain why no Edit button appears, no extra copy needed.
- `categoriesRoute.get("/categories/:id/edit")` — same shape as
  `ignoreRulesRoute.get("/ignore-rules/:id/edit")`: look up the id, return
  `<CategoriesList categories={listCategories()} editingId={id} />`. If the id doesn't
  exist, or resolves to the system category, return the list unedited (no error banner
  needed — this only happens via a hand-crafted request, not through the UI) rather than a
  hard 404, since a stale `hx-get` after a delete/rename race just re-renders the current
  list either way. *(Category delete doesn't exist per Scope, so the "stale id" case here is
  really only reachable by directly hitting the route with a bad id — still worth handling
  defensively since the route is reachable independent of the UI.)*
- `categoriesRoute.post("/categories/:id")` — look up the category by id first:
  - Not found → `c.notFound()`.
  - `isSystem` → reject with the existing `CategoriesList` error pattern ("Cannot rename the
    system category.") rather than a 404, since this is a real, nameable state (someone
    could still hit `/categories/:id/edit` for the system id directly) and deserves a
    message, not a silent no-op or a generic 404.
  - Otherwise: same three validations as create, in this order — length limit (#2), empty
    name, reserved name (`"uncategorized"`, case-insensitive) — then attempt the update,
    catching `UNIQUE constraint failed` the same way `POST /categories` already does
    (renaming to another category's existing name). Note SQLite's unique constraint doesn't
    fire when a row is updated to its *own current* name, so a no-op "rename" to the same
    name just succeeds silently — no special-casing needed.
  - On success, return `<CategoriesList categories={listCategories()} />` (no `editingId`,
    matching the ignore-rules pattern of falling back to the unedited list after a
    successful save).
- **`src/db/seed.ts` fix (small, bundled with this item):** seed's idempotency check
  currently keys off the literal name — `where(eq(categories.name, "Uncategorized"))` —
  rather than `isSystem`. The new rename route guards by `isSystem` at the route layer, so
  this isn't reachable through the UI this spec builds, but it's a latent footgun: if the
  system row's name ever changed by any other path (a future bug bypassing the guard, a
  direct DB edit, `drizzle studio`, etc.), the next app startup's `seed()` would no longer
  find a row named exactly "Uncategorized," insert a *second* `isSystem: true` row, and
  silently break every query that assumes exactly one system category exists
  (`resolveCategoryId`'s `.get()`-picks-first behavior in `src/routes/channels.tsx`,
  `listNonSystemCategories`, etc.). Since this spec is the first to make the category name
  mutable even in principle, fix `seed.ts` now to check `eq(categories.isSystem, true)`
  instead of the name — a one-line change, cheap enough not to defer.
- No changes anywhere else: every existing reference to a category's name (queue views,
  channel subscribe `<select>`, filter links) already reads `categories.name` live via FK
  join, so a rename propagates automatically — this is the behavior `app_idea.md` already
  describes ("every Channel/Video referencing it via foreign key picks up the new name
  immediately"), and it requires no code change since it was always true of the FK-join
  query pattern, only the *route to trigger a rename* was missing.

### 4. Per-subscription missed-videos dismissal

**Schema change** (`src/db/schema.ts`):
- On `youtubeChannels`: replace `possibleMissedVideos: integer(..., { mode: "boolean"
  }).notNull().default(false)` with
  `possibleMissedVideosDetectedAt: integer("possible_missed_videos_detected_at", { mode:
  "timestamp" })` (nullable, no default — `null` means no gap has ever been detected for
  this channel). This is the channel-level *fact*: a gap in the RSS feed doesn't vary by
  user, so it stays on the shared `youtube_channels` entity, unchanged in that respect.
- On `subscriptions`: add `missedVideosDismissedAt: integer("missed_videos_dismissed_at", {
  mode: "timestamp" })` (nullable, no default — `null` means this user has never dismissed
  a notice for this subscription). This is the per-user *preference*, so it belongs on the
  per-user join row, not the shared channel.
- **Why a timestamp instead of two booleans (one flag, one per-user dismissed-bool):** a
  plain "dismissed" boolean can't distinguish "user dismissed the current gap" from "user
  dismissed a *previous* gap, and a new one has since appeared" — the badge would either
  never reappear after a dismiss (wrong: a second, later, independent gap should re-trigger
  it) or reappear immediately after every dismiss (wrong: nothing changed). Comparing two
  timestamps (`detectedAt` vs. `dismissedAt`) captures "has anything happened *since* the
  user last acknowledged this" directly and correctly re-triggers on a later gap without
  extra bookkeeping.
- **Badge visibility rule:** show the notice for a given subscription when
  `possibleMissedVideosDetectedAt IS NOT NULL AND (missedVideosDismissedAt IS NULL OR
  missedVideosDismissedAt < possibleMissedVideosDetectedAt)`. Compute this as a plain boolean
  in the route layer after `.all()` (a small helper, e.g. `hasUndismissedGap(detectedAt,
  dismissedAt)`) rather than pushing timestamp comparison into the JSX view — keeps
  `SubscriptionList` a pure presentational component, consistent with how it's written today.

**`src/lib/ingest.ts` change:** in `applyFeedToChannel`, the existing
`...(gapDetected ? { possibleMissedVideos: true } : {})` becomes
`...(gapDetected ? { possibleMissedVideosDetectedAt: now } : {})` — same "never auto-clears,
only advances forward on a new detection" behavior as today (a dismissal only ever touches
the *subscription* row, never this one), just recording *when* instead of *whether*. The
existing code comment ("Never auto-clears an existing true flag -- only a future
manual-dismiss action ... does that") should be updated to reflect that dismissal now lives
on `subscriptions`, not here.

**New route:** `POST /subscriptions/:id/dismiss-missed-videos` in `src/routes/channels.tsx`
— same ownership-scoping pattern as the existing `DELETE /subscriptions/:id` (unsubscribe):
`WHERE id = :id AND userId = currentUser.id AND unsubscribedAt IS NULL`. Sets
`missedVideosDismissedAt = new Date()`. Returns the re-rendered `SubscriptionList` (matching
the unsubscribe route's response shape). Not found (wrong id, wrong owner, or already
unsubscribed) → `c.notFound()`, same as unsubscribe.

**`listActiveSubscriptions` query change** (`src/routes/channels.tsx`): join in
`youtubeChannels.possibleMissedVideosDetectedAt` and
`subscriptions.missedVideosDismissedAt`, then map each row through the `hasUndismissedGap`
helper to attach a `showMissedVideosBadge: boolean` before passing to the view. `subscription
id` is already selected and is the right id for the new dismiss route (matches the existing
unsubscribe button's id usage).

**`SubscriptionList` view change** (`src/views/subscription-list.tsx`): extend the
`Subscription` type with `showMissedVideosBadge: boolean`; when true, render a short notice
(e.g. "⚠ Possible missed videos") plus a "Dismiss" button (`hx-post
/subscriptions/{id}/dismiss-missed-videos`, `hx-target #subscription-list`, `hx-swap
outerHTML`) inline next to that row, alongside the existing "Unsubscribe" button.

**Migration note — must be a drop+add, never accepted as a rename:** this schema change
(drop the `possible_missed_videos` boolean, add `possible_missed_videos_detected_at` on
`youtube_channels`, add `missed_videos_dismissed_at` on `subscriptions`) will very likely hit
the exact `drizzle-kit generate` interactive-TTY prompt CLAUDE.md already documents as
unusable from a Claude Code session ("renamed table" vs. "new table" disambiguation — the
same ambiguity plausibly applies here, since `possible_missed_videos` →
`possible_missed_videos_detected_at` could read to the diff tool as a rename of one column).
This is not just a TTY inconvenience to route around — **answering "rename" here would
silently corrupt every row**, not just risk it: SQLite's `RENAME COLUMN` preserves the raw
stored integer while only the Drizzle-side type metadata changes from boolean to timestamp,
so every row currently `false` (raw `0`) would become a non-null `new Date(0)`, and every row
currently `true` (raw `1`) would become an equally-nonsensical non-null timestamp. Since the
visibility rule below is `detectedAt IS NOT NULL AND (...)`, *both* outcomes are non-null —
the bug wouldn't silently drop the notice, it would silently show it on every single
subscription, a false-positive storm across the whole app. The task file must flag this
migration step for the user to generate and *read* in their own terminal (per CLAUDE.md's
existing TTY hand-off guidance) — confirm the generated SQL is a genuine
drop-old-column/add-new-columns sequence (matching the table-rebuild pattern already used for
`videos`' `CHECK` constraints in `drizzle/0003_redundant_sprite.sql`), and explicitly reject
any "rename" disambiguation the tool offers instead.

Confirmed at implementation time (task 3): no rename prompt actually occurred — the
generated migration (`drizzle/0004_perpetual_lucky_pierre.sql`) resolved
`possible_missed_videos` → `possible_missed_videos_detected_at` as a plain `ADD
possible_missed_videos_detected_at` / `DROP COLUMN possible_missed_videos` pair with no
TTY disambiguation needed, and *not* the `__new_youtube_channels` table-rebuild pattern
this note assumed — that rebuild shape only applies to `categories` here (which needs the
new `CHECK` constraint; SQLite has no `ALTER TABLE ADD CHECK`), whereas plain `ADD`/`DROP
COLUMN` needs no rebuild since `youtube_channels` has no `CHECK` constraint of its own.
The drop+add-not-rename safety property held regardless of which shape it took, and the
backfill `UPDATE` (below) was hand-inserted between the generated `ADD` and `DROP COLUMN`
statements rather than into a rebuild's `INSERT ... SELECT` list.

**Backfill step, before the old column is dropped:** any channel currently flagged
`possible_missed_videos = true` represents a real, never-yet-acknowledged notice — nothing
today can dismiss it, so a `true` value always means "a user has not seen this." Dropping the
column without carrying that forward would silently erase those pending notices. The
migration (or a one-off data step run as part of it, before the drop) must backfill:
```sql
UPDATE youtube_channels
SET possible_missed_videos_detected_at = COALESCE(last_fetched_at, unixepoch())
WHERE possible_missed_videos = 1;
```
`last_fetched_at` is the best available proxy for "when this was last known to be true" (the
exact original detection time isn't stored); falling back to the current time only matters
for the edge case of a flagged channel that has somehow never completed a fetch, which
shouldn't be reachable in practice but costs nothing to guard against.

**New subscriptions must not inherit a pre-existing, pre-subscription gap:**
`upsertSubscription`'s `"created"` branch (`src/lib/subscribe.ts`) currently inserts a new
`subscriptions` row with no explicit `missedVideosDismissedAt`, which would default to
`null`. But `youtubeChannels` is shared across users (spec002) — if someone subscribes to a
channel that already has an old `possibleMissedVideosDetectedAt` from before they ever
subscribed, `null < <old timestamp>` would immediately show them a notice about videos they
were never in a position to have "missed" in the first place (they weren't subscribed when
the gap occurred). The `"created"` branch must instead insert with
`missedVideosDismissedAt: new Date()`, treating "the moment I subscribed" as the dismissal
baseline — anything detected before that moment doesn't apply to this subscriber; only a
*later* detection should surface a badge for them. This also correctly absorbs the
eager-subscribe-time-ingestion case (`channelsRoute.post("/subscriptions")` calls
`ingestChannel`/`applyFeedToChannel` *before* `upsertSubscription` runs): if that eager fetch
re-detects a still-unresolved old gap and bumps `possibleMissedVideosDetectedAt` to "now,"
the subscription row's `missedVideosDismissedAt` (captured immediately after, at insert time)
will be equal to or later than it, and the visibility rule's strict `<` comparison means equal
timestamps correctly resolve to "no badge." The `"reactivated"` branch (re-subscribing after
a prior unsubscribe) needs no equivalent change — it reuses the existing subscription row
and its existing `missedVideosDismissedAt` untouched, which is the correct continuity
behavior: the same rule `app_idea.md` already establishes for unsubscribe/re-subscribe
preserving "all video history/state" applies equally to this per-user preference.

## Open Questions

None. Scope, exact schema shape, and UI pattern for all four gaps were settled during
drafting (see Context for the per-subscription-dismissal design rationale in particular,
which was the one genuinely open design question — resolved in favor of building the
correct shape now rather than deferring to a future multi-user spec, since the schema change
is small and this spec already touches the relevant read/display path).

**Red-team retrospective:** One independent pass (subagent, no memory of the drafting
conversation, given only CLAUDE.md/app_idea.md/spec007/the draft/the actual source files to
verify claims against) found five real issues in the first draft, all fixed directly above:
(1) the migration note didn't say a "rename" disambiguation at the `drizzle-kit generate` TTY
prompt would silently corrupt data (both `true` and `false` would map to non-null
timestamps, causing a false-positive badge storm) — now explicit; (2) no backfill plan for
channels already flagged `true`, which would have silently erased real pending notices — now
an explicit `UPDATE ... WHERE possible_missed_videos = 1` backfill step; (3) a brand-new
subscription to a channel with a pre-existing old gap would immediately show that subscriber
a notice for something they were never in a position to miss — now `upsertSubscription`'s
`created` branch initializes `missedVideosDismissedAt: new Date()`; (4) the
"keep the SQL literal and JS constant in sync by hand" approach for the length-limit `CHECK`
constraint was an avoidable footgun — swapped for `sql.raw()`, already available in the
installed `drizzle-orm` version; (5) `src/db/seed.ts`'s idempotency check keys off the
category's literal name rather than `isSystem`, a latent fragility this spec's rename
feature should close now rather than leave — added as a bundled one-line fix. A narrower
follow-up check (scoped only to these five edits, per the skill's guidance that this is a
reasonable substitute for a second full pass once a first pass's findings are all
straightforward corrections rather than raising new design questions) confirmed each fix is
internally consistent with the rest of the Design section and doesn't reopen any of the
areas the first pass explicitly cleared (the four Context claims, spec006's stale "already
built" assertion, the FK-live-join rename propagation, and the edit-toggle pattern match
against spec007). No second full pass was run.

**Task-decomposition pass retrospective (`/spec-tasks`):** while breaking this spec into
steps, re-reading Design #2 against the codebase's actual import graph surfaced a real spec
bug the red-team pass hadn't caught: the draft placed `CATEGORY_NAME_MAX_LENGTH` in
`src/routes/categories.tsx`, but the `CHECK` constraint in `src/db/schema.ts` also needs
that same constant — which would have required `schema.ts` to import from a route file,
backwards from every existing dependency direction in this codebase (routes import from
`db/schema`, never the reverse). Fixed directly in Design #2 above: the constant now lives
in `schema.ts`, exported for `categories.tsx` to import alongside the `categories` table it
already imports from there.
