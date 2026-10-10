---
status: implemented
created: 2026-10-10
---

# Channel Category Change, Per-Category Default Sort, Unsubscribe Confirm

## Context

Three small, related management-UX gaps found while using the app:

1. A channel's category can only be chosen at subscribe time (`POST /subscriptions`);
   there is no way to move an existing subscription to another category short of
   unsubscribing and resubscribing.
2. The queue is always newest-first unless `?sort=oldest` is passed via the toggle. Some
   categories (e.g. serial content watched in order) are better oldest-first by default.
3. **Unsubscribe** on the channels list fires immediately with no confirmation, unlike
   category **Delete**, which uses `hx-confirm` (docs/specs/021-category-delete.md).

Product-doc anchors: `docs/app_idea.md` — Category/Channel data model, and the Queue views
bullet describing newest-first sort with a toggle (docs/specs/005-subscribe-default-category-and-queue-sort-toggle.md).
These are bundled into one spec (one branch/PR, `spec/channel-category-and-sort`) because
each is small; the parts are independent and touch mostly different files.

## Scope

In:
- **Part A** — change an existing subscription's category from the channels list.
- **Part B** — per-category default queue sort (`newest` | `oldest`), settable from the
  category edit row, honored when a category's link is followed.
- **Part C** — `hx-confirm` on the Unsubscribe button.

Out:
- An edit modal for channels (no modal pattern exists in the app; category is the only
  editable field).
- Refreshing the sidebar's per-category unwatched counts after a category move. Unsubscribe
  already leaves the sidebar stale until the next page load; same accepted gap here.
- Sort defaults for any view other than `/queue` (Continue Watching, Watched, and Ignored
  have no sort toggle or `sort` param).
- A default sort for the system "Uncategorized" category (always newest; see Design B).
- Making the Newest/Oldest toggle persist (it stays a temporary per-view override).
- Confirmation on "Dismiss" for the missed-videos badge.

## Design

### Part A — change a channel's category

- `src/views/subscription-list.tsx`: replace the static category badge with an inline
  `<select name="categoryId">` per row, `hx-post={`/subscriptions/${id}/category`}`,
  `hx-trigger="change"`, `hx-target="#subscription-list"`, `hx-swap="outerHTML"` (same
  swap as Unsubscribe/Dismiss), plus `hx-disabled-elt="this"` (precedent: the queue card
  buttons) so rapid changes don't stack requests. Focus is lost on the outerHTML swap;
  accepted, as for the existing buttons. The current category is `selected`.
  `SubscriptionList` therefore needs the category options and each row's current
  `categoryId`: add `categoryId` to `listActiveSubscriptions`'s select and the `Subscription`
  type, and drop `categoryName` plus the now-pointless `categories` join (nothing renders
  the name any more; fallow). `ChannelsPage` already receives `subscribeCategories`, so
  thread that into `SubscriptionList` rather than re-querying. A select whose current
  category was deleted in another tab would silently show the first option; since delete
  reassigns subscriptions to Uncategorized, a reload shows the truth, and this is accepted. Options = "Uncategorized" (value `""`; `selected` when the row's `categoryId` is the system
  category's id, not matching on value, matching the subscribe form and
  `resolveCategoryId`'s existing contract) plus all non-system categories
  (`listNonSystemCategories()`), alphabetical.
  The `<select>` needs an accessible label (`aria-label` with the channel name).
- New route `POST /subscriptions/:id/category` in `src/routes/channels.tsx`. It parses
  `categoryId`, validates with the existing `resolveCategoryId` (rejects system-category
  ids and unknown ids with "Invalid category."; `""` → Uncategorized), then calls the
  existing `updateOwnedSubscription(c, userId, id, { categoryId })`, which already scopes to
  the owning user and to active (not unsubscribed) subscriptions and 404s otherwise.
  On a validation error, re-render `SubscriptionList` with `error` set (the component
  already supports an `error` prop) rather than a bare 4xx, so the swap target is never
  replaced by an error fragment. `updateOwnedSubscription` hard-codes the success render
  today, so the validation path is a separate early return in the new handler, before
  calling it.
- Every renderer of `SubscriptionList` (`ChannelsPage`, `POST /subscriptions`, and
  `updateOwnedSubscription`, now serving three routes: unsubscribe, dismiss, category) must
  pass the category options, via one shared helper rather than ad hoc calls.
- Moving a channel does not touch its videos: videos join to a category through the
  subscription, so the queue picks up the new category immediately
  (`docs/app_idea.md` data model: Category 1-to-many Subscription).

### Part B — per-category default sort

**Data.** New column `categories.default_sort` in `src/db/schema.ts`:
`text("default_sort", { enum: ["newest", "oldest"] }).notNull().default("newest")`, so the
TS type is the union `"newest" | "oldest"` (not `string`). **No DB `CHECK`**: the existing
table-level `name_length_check` lives on `categories`, and adding another table-level check
makes drizzle-kit emit a full table rebuild (`CREATE TABLE __new_categories` / `DROP TABLE`),
which is risky because `subscriptions.category_id` references `categories` and drizzle's
migrator runs inside a transaction where `PRAGMA foreign_keys=OFF` is a no-op. The value is
validated in the app instead (the edit handler). The generated migration should be a plain
`ALTER TABLE categories ADD default_sort text DEFAULT 'newest' NOT NULL` like
`drizzle/0005*.sql`; the task must inspect the generated SQL and, if it is anything else,
stop and rethink. Verify the migration against a copy of a populated DB (existing
subscriptions plus the seeded Uncategorized row), since the test suite only migrates empty
`:memory:` DBs. Existing rows (including "Uncategorized") get `'newest'` from the default. Categories are global (not per-user), like the rest of
the `categories` table, so the default is global too.

**Resolution on `GET /queue`.** `sort = ?sort= (if exactly "newest" or "oldest") ?? the
filtered category's default_sort ?? "newest"`. The category used is the one already
validated by `resolveCategoryFilter`. An unknown/invalid `category` param resolves to
no category (existing behavior), hence `newest` (a deleted category's default is simply
gone). Implementation: `resolveCategoryFilter` currently returns only the id; extend it (or
add a sibling) to return the category row's `defaultSort` as well, and build one
`resolveSort(rawSort, categoryDefault)` helper in `src/routes/queue.tsx`, used by the
`/queue` handler (called *before* its `cursor !== undefined` branch, so a stale sentinel URL
without `sort` resolves consistently rather than to newest) and `POST /videos/:id/toggle`.
The watching routes only have a raw category string and no need of the category default;
they use a plain validator (`newest`/`oldest`/`undefined`). Keep it module-private unless a second file needs it (fallow). Any `sort` value other than
`newest`/`oldest` is treated as absent (falls through to the category default), not
silently coerced to newest as `resolveSort` does today.

**The `sort` param's meaning changes**, so link construction does too. Previously the absence
of `sort` meant newest, so `buildQueueHref` omitted it for newest. Now absence means "use
the category's default" and the two cases separate:

- *Links that mean "show me this category's default"* send **no** `sort`:
  the sidebar category links (`sidebarCategoryHref` in `src/views/layout.tsx`, queue case)
  and the Categories page links (`/queue?category=N`, already param-free).
  The sidebar stops carrying the current sort into those links (`sidebarCategoryHref` loses
  its `currentSort` param; `queue.tsx` stops passing `currentSort` to `Layout`); otherwise being on "oldest"
  would override the next category's default and defeat the feature.
  The sidebar's top-level **Queue** link (no category) also sends no `sort`, i.e. newest.
  This is a behavior change: today it preserves the current sort. It is the simplest
  consistent rule, and `Layout`'s `currentSort` prop becomes unused and is removed
  (fallow would flag it otherwise).
- *Links that mean "keep exactly this order"* send an **explicit** `sort=newest|oldest`,
  always, both values:
  - the Newest/Oldest toggle links on `/queue` (these must not drop `sort=newest`, or on
    an oldest-default category "Newest first" would resolve back to oldest);
  - the endless-scroll cursor/sentinel URL (`sentinelHrefFor` → `buildQueueHref`), so page
    2+ cannot re-resolve to a different order than page 1;
  - the per-card `watchingHref`, `toggleHref`, and `ignoreHref` in `queue-list.tsx`
    (they already include any resolved `sort`, newest included — no change needed);
  - the watching page's return path (`buildReturnPath` in `src/routes/queue.tsx` currently
    emits only `sort=oldest`) — it must emit `sort=newest` too. The raw `sort` string is
    validated once, in the `/watching/:id` and `watched-toggle` handlers, to exactly
    `newest`/`oldest`/`undefined` before it reaches `WatchingPage` (whose
    `watchedToggleAction` form action would otherwise echo garbage) or `buildReturnPath`.
  `buildQueueHref(sort, category, cursor)` therefore always sets `sort` when given one.
  Its first param is a required positional today; make it `sort: "newest" | "oldest" |
  undefined` (omit when `undefined`) and update every caller (`layout.tsx` Queue link and
  `sidebarCategoryHref`, `queue-list.tsx` sentinel, `queue.tsx` toggle links).
- Old bookmarks like `/queue?category=3` simply resolve to the category default.
- `POST /videos/:id/toggle` re-renders a card using the same helper, so a hand-built or old
  URL without `sort` gets the category's default, same as `/queue`. Cards always carry
  explicit `sort`, so normal use is unaffected.
- `/watching/:id` and `POST /videos/:id/watched-toggle` read a raw, unvalidated `sort`.
  Validated as described above, so garbage is never echoed into the return link, form
  action, or redirect; with no valid `sort` the
  return link carries none, i.e. the category default.
- The Newest/Oldest toggle has no active-state indicator today, and on an oldest-default
  category the URL has no `sort`, so the user can't tell which order is showing. Render the
  resolved order as non-link text (bold, no anchor) and the other as the link.

**Setting it.** The category edit row (`categories-list.tsx`, shown for `editingId`)
gains a `<select name="defaultSort">` (Newest first / Oldest first) beside the name
input, submitted by the existing `POST /categories/:id`. That handler
validates `defaultSort ∈ {newest, oldest}`; a missing, non-string, or other value is an
error re-render with the edit row still open (matching name errors), never a silent keep.
`parseAndValidateCategoryName` is shared with `POST /categories` (create), which takes no
sort, so `defaultSort` is parsed and *required* only on the edit route (one `parseBody()`
call only; e.g. an opt-in parameter), and create is unchanged. Name and `default_sort` update in
one statement, and the unique-name error path still applies. As with name errors today, the
re-rendered edit form shows DB state, so an unsaved sort choice is lost on error.
The non-edit list row shows the current default (e.g. a small "oldest first" label only when
it is not the default, to keep newest-default rows uncluttered).
`POST /categories` (create) takes no sort; new categories are `newest` until edited.
The system category has no Edit button and `categoryEditGuard` already rejects it, so
Uncategorized is always newest with no extra code.

**Rejected alternatives.**
- Sticky toggle (toggle saves the default): faster to set but accidental clicks silently
  change a persistent setting. Edit row is the one place to change it.
- A separate "sort" resolution layer in the URL (e.g. `sort=default`): unnecessary —
  "absent" already naturally means "default" once every pass-through link is explicit.

### Part C — confirm before unsubscribing

`hx-confirm` on the Unsubscribe button in `subscription-list.tsx`, same mechanism as
category Delete: `Unsubscribe from "${channelName}"?`. No server change. The prompt makes no
claim about resubscribe behavior (not verified here). Hono's JSX escapes attribute values,
so channel names containing quotes are safe in the attribute.

### Testing

- **Existing tests that must change** (line numbers approximate; verify when implementing):
  `test/routes/queue.test.ts` ~L196 (oldest page: Newest toggle `href="/queue"` becomes
  `/queue?sort=newest`; the old assertion would still pass but via the sidebar Queue link,
  testing nothing); ~L565-583 ("category links preserve sort" — sidebar category links now
  carry **no** `sort`; the toggle-preserves-category half stays valid); ~L1036 and the
  `action` assertion after it (queue-originated return link gains `sort=newest`, i.e.
  `/queue?sort=newest&category=N`). Unchanged and verified OK: ~L174, L436-456, L677-692,
  L781, L812-825, L884, L977/980, L1167. `test/routes/categories.test.ts`: `postRename`
  (~L106-115) must send `defaultSort`, affecting the rename-success (~L201) and unique-name
  (~L261) tests, plus edit-row assertions for the new select.
  `test/routes/channels.test.ts` ~L858-888 asserts the category pill
  `<span ...>Tech</span>`; it becomes an assertion on the select's selected option.
- **Part A:** route tests in `test/routes/channels.test.ts` — change to a non-system
  category; change back to Uncategorized (`""`); reject system-category id and unknown id
  (list re-rendered with error, subscription unchanged); 404 for another user's or an
  unsubscribed subscription; rendered list contains the select with the current category
  selected.
- **Part B:** unit/route tests in `test/routes/queue.test.ts` and categories tests —
  `/queue?category=N` uses the category default (oldest) with no `sort`; explicit
  `sort=newest` overrides an oldest default and vice versa; invalid `sort` value falls
  back to the default; unknown category → newest; the rendered toggle links, sentinel URL
  and card links all contain explicit `sort`; sidebar category links contain no `sort`;
  the watching page return path round-trips `sort=newest` and `sort=oldest`; category edit
  persists `defaultSort`, rejects missing/invalid values, and the system category cannot be
  edited; `sort=garbage` on `/watching/:id` and `watched-toggle` is dropped, not echoed; the
  toggle shows the resolved order as non-link text on an oldest-default category with no
  `sort` in the URL; a cursor request without `sort` resolves to the category default.
  Paginated ordering test: with an oldest-default category and several videos, page 2 (via
  the sentinel URL) continues in the same order as page 1.
- **Part C:** rendered-HTML test that the button carries `hx-confirm` including a
  channel name with a quote character, escaped.
- **Manual verification** (task file will split it per CLAUDE.md): Claude checks rendered
  HTML/DB state via `curl` + `scripts/dev-login.sh`; the user verifies in a browser the real
  HTMX swap on category change, the confirm dialog, and the oldest-default click-through
  (sidebar link, toggle override, scrolling past page 1, mark watched and return).
- The final step runs `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow`.

## Open Questions

- **Resolved (user, 2026-10-10):** the top-level sidebar **Queue** link no longer preserves
  the current sort (see Part B) — it always opens newest-first. Rejected alternative: carry
  `sort` through that link only when it was explicit in the URL; it needs an
  explicit-vs-defaulted flag plumbed through `Layout` for one link, and makes the all-
  categories link behave differently from the category links.
- Migration generation: `drizzle-kit generate` for an additive `NOT NULL DEFAULT` column
  shouldn't prompt, but if it does need a TTY (see CLAUDE.md), the task file hands the exact
  command to the user.

### Red-team retrospective

Pass 1 (independent subagent) found no design-level flaws. It caught: (1) a DB `CHECK` on
the new column would likely force a table rebuild of a foreign-key-referenced table, invisible
to empty-DB tests — fixed by dropping the CHECK in favor of a typed drizzle `enum` and
app-side validation, plus a populated-DB migration check; (2) the sort resolver, the
`toggle` fallback, and raw-`sort` echoing in `buildReturnPath` were under-specified — fixed in
Part B; (3) select `change` stacking and focus — `hx-disabled-elt`, focus loss accepted;
(4) imprecise Part A claims (renderer count, `categoryName`/join becoming dead) — corrected;
(5) existing tests that flip were unlisted — enumerated in Testing; (6) no active-order
indicator on the toggle — added; (7) edit-row body parsing and missing-field behavior —
specified. 
Pass 2 (narrow, on the fixes) confirmed the migration reasoning (drizzle-orm ^0.45.2 /
drizzle-kit ^0.31.10; `0005` is a plain ADD COLUMN on a table with CHECKs; `0002`/`0003` are
the rebuild precedents) and caught: a contradiction about raw `sort` in the watching form
action (now validated once in the handlers); `resolveSort` must run before the cursor branch;
create-vs-edit sharing of the name parser (defaultSort required on edit only); the
Uncategorized `selected` mismatch (`""` value vs system id); several wrong or missing
existing-test line refs (corrected above); and `watchingHref`/`toggleHref`/`ignoreHref`
needing no change. A final scoped check is left to the task file's first step, which
re-verifies those test refs against the code.
