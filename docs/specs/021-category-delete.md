---
status: in-progress
created: 2026-08-11
---

# Category Delete

## Context

`docs/app_idea.md:129` currently states: *"No explicit delete operation is needed for MVP -
a category with zero channels attached just stops appearing anywhere; it can linger
harmlessly or be auto-pruned later."* That reasoning assumed delete would only ever be
useful once a category was already empty. This spec supersedes it: the user wants to delete
a category **with channels still assigned to it**, reassigning every one of those channels
to the system `Uncategorized` category rather than requiring manual reassignment first. This
is also deliberately laying groundwork for a future spec that lets a user change which
category a single channel belongs to (not itself in scope here) — delete-with-reassignment
exercises the same "move a subscription's `categoryId` to Uncategorized" mechanics that
per-channel recategorization will need, without yet building the UI for the general case.

Bundled into the same spec at the user's request, since it's small, pure-markup, and was
already being discussed in the same conversation: the Channels page's category label
(`src/views/subscription-list.tsx`) currently renders as `(categoryName)` plain text; it
gets restyled to match the pill (`rounded-full bg-surface-raised px-2 py-0.5 text-xs
text-text-muted`) already used for a video's category on every queue-view card
(`src/views/queue-list.tsx:158-160`, `189-191`, `239-241`).

Decided during pre-spec scoping (recorded here so this spec doesn't re-litigate it):
skip `/new-feature` and go straight to `/new-spec` — the scope was already well-bounded
going in, matching the existing add/rename CRUD pattern in `src/routes/categories.tsx`, and
the two open questions (confirmation UX, whether to bundle the pill restyle) were simple
enough to resolve directly rather than warranting a feature-file interview.

## Scope

**In:**
1. `DELETE /categories/:id` route: reassigns every `Subscription` row referencing that
   category (across all users, active or unsubscribed — see Design for why) to the system
   `Uncategorized` category, then deletes the category row, in one transaction.
2. A "Delete" button on each non-system category row in `src/views/categories-list.tsx`,
   right of "Edit" — hidden for the system row, same as Edit already is. Uses `hx-confirm`
   (htmx's built-in native-`confirm()` attribute, already available via the `htmx.org@2.0.4`
   script tag in `src/views/layout.tsx:121` — no new dependency) stating how many channels
   will move to Uncategorized.
3. `listCategoriesWithCounts` (`src/lib/categories.ts`) gains a `channelCount` field per
   category, needed to word the confirm message.
4. Extract the existing "find the system category or throw" query (currently only in
   `src/routes/channels.tsx:32-40`) into a shared `getSystemCategory()` in
   `src/lib/categories.ts`, used by both the new delete route and `channels.tsx`'s existing
   `resolveCategoryId`.
5. `src/views/subscription-list.tsx`: the `({subscription.categoryName})` parenthetical
   becomes the same pill-styled `<span>` `queue-list.tsx` already uses for a video's
   category.
6. `docs/app_idea.md:129` gets an inline pointer to this spec, per CLAUDE.md's
   product-doc-stays-stable convention.

**Out (deferred, not this spec):**
- Editing which category an individual channel/subscription belongs to (spec's own stated
  motivation for *why now*, but explicitly not built here — a future spec).
- Any confirmation UI beyond native `hx-confirm` (no custom modal/dialog component).
- Any change to the sidebar (`src/views/layout.tsx`)'s per-category link list beyond its
  existing behavior: a deleted category simply stops appearing on the next full-page render,
  identical to how the sidebar already goes stale after a rename until the next navigation —
  no OOB update is added, consistent with spec009's already-accepted nav-staleness tradeoff.
- Any change to `resolveCategoryFilter` (`src/routes/queue.tsx:306-316`) — already degrades
  gracefully for a since-deleted category id (falls back to unfiltered) with no code change
  needed; confirmed by reading it, not modified by this spec.
- Bulk/multi-select category deletion — one category at a time, matching every other
  category/ignore-rule mutation in this codebase.
- Undo/soft-delete — matches the hard-delete precedent already set by `IgnoreRule` delete
  (`src/routes/ignore-rules.tsx`'s `DELETE /ignore-rules/:id`).
- Any multi-user isolation change — categories remain global entities shared across users,
  as established by spec002 and already true of category rename today (renaming a category
  already changes what every user with a subscription in it sees; delete follows the same
  existing precedent, not a new one).

## Design

### Reassignment must be global, not scoped to the current user

`subscriptions.categoryId` (`src/db/schema.ts:73-75`) has no `onDelete` cascade — Drizzle
defaults to `NO ACTION`/`RESTRICT`. Deleting a category row while any `Subscription` still
references it (any user's, active or not) would violate that FK and throw at the SQLite
level. So every `Subscription` row with `categoryId = :id` must be repointed to
`Uncategorized` first — not just the current user's active ones — before the `DELETE` runs.
This mirrors the existing precedent `db.transaction` already established in
`src/lib/ignore-rules.ts:41` (`reconcileIgnoreRules`, "a single transaction makes the whole
pass atomic instead").

Unsubscribed (`unsubscribedAt` not null) rows are included in the reassignment too, even
though they're invisible in every current UI list — they still hold a live FK to the
category being deleted, so leaving them pointed at a deleted row is not an option (and isn't
even representable — the row would still say `categoryId: 5` after category `5` no longer
exists, which SQLite's FK constraint won't allow in the first place).

### `getSystemCategory()` — new shared helper in `src/lib/categories.ts`

```ts
export function getSystemCategory(): typeof categories.$inferSelect {
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.isSystem, true))
    .get();
  if (!category) throw new Error("seed did not create the system category");
  return category;
}
```

This is the exact query + invariant-violation throw already inline in
`src/routes/channels.tsx:32-40`'s `resolveCategoryId`. Extracting it now (rather than
writing a third near-duplicate for the delete route) means `channels.tsx` changes too:

```ts
function resolveCategoryId(categoryIdRaw: string): CategoryResolution {
  if (categoryIdRaw === "") {
    return { ok: true, categoryId: getSystemCategory().id };
  }
  // ... unchanged below
}
```

`channels.tsx` drops its now-unused inline system-category query (the `categories` import
stays — still used by `listNonSystemCategories`, `listActiveSubscriptions`'s join, and the
new pill markup's data doesn't need it directly).

### `DELETE /categories/:id` route (`src/routes/categories.tsx`)

Placed after the existing `POST /categories/:id` (rename) handler, mirroring
`ignore-rules.tsx`'s add → edit-form → rename → delete ordering:

```ts
categoriesRoute.delete("/categories/:id", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));
  const category = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!category) return c.notFound();

  if (category.isSystem) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        error="Cannot delete the system category."
      />,
    );
  }

  const systemCategory = getSystemCategory();

  db.transaction((tx) => {
    tx.update(subscriptions)
      .set({ categoryId: systemCategory.id })
      .where(eq(subscriptions.categoryId, id))
      .run();
    tx.delete(categories).where(eq(categories.id, id)).run();
  });

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});
```

- Nonexistent id → `c.notFound()` (404), same as `POST /categories/:id`'s existing
  not-found branch (`categories.tsx:106`) and `ignore-rules.tsx`'s `DELETE
  /ignore-rules/:id` (`ignore-rules.tsx:81`).
- System category → HTML error swap into `#category-list`, same shape as the existing
  "Cannot rename the system category." branch (`categories.tsx:108-115`) — deliberately not
  a 4xx status, matching that precedent exactly (the button is hidden client-side too, so
  this is defense-in-depth against a hand-crafted request, not a reachable UI path).
- `categories.tsx` needs one new import: `subscriptions` from `../db/schema` (currently only
  imports `CATEGORY_NAME_MAX_LENGTH, categories`), plus `getSystemCategory` from
  `../lib/categories` (currently only imports `listCategoriesWithCounts` from there).

### `channelCount` on `CategoryWithCount` (`src/lib/categories.ts`)

```ts
function categoryChannelCount(categoryId: number): number {
  const row = db
    .select({ count: count() })
    .from(subscriptions)
    .where(eq(subscriptions.categoryId, categoryId))
    .get();
  return row?.count ?? 0;
}
```

Deliberately **not** scoped to `userId` or filtered to active subscriptions, unlike
`categoryUnwatchedCount` right above it in the same file — it needs to match exactly what
the delete transaction's `UPDATE ... WHERE category_id = :id` will actually touch (every
subscription row across every user, active or not), not what's visible to the current user
in the UI. `CategoryWithCount` gains `channelCount: number`; `listCategoriesWithCounts`'s
`.map()` gains `channelCount: categoryChannelCount(category.id)` alongside the existing
`unwatchedCount`.

Naming caveat: this counts `Subscription` rows, not distinct `YoutubeChannel`s. Per
spec002's Channel/Subscription split, the same physical channel could have two `Subscription`
rows in the same category if two different users each subscribed to it under that category
— `channelCount` would then over-count relative to "distinct channels" by one. Accepted as
a known imprecision: today's app is effectively single-user, and the confirm message's
purpose is to communicate "here's roughly what's about to move," using this app's existing
loose channel/subscription vocabulary (`unwatchedCount` and the Channels-page row count are
also phrased in terms of channels without distinguishing from subscriptions), not to provide
an exact distinct-channel audit.

This function lives in `lib/categories.ts` and computes off `categories.id` alone (no
`userId` parameter), so none of `listCategoriesWithCounts`'s 21 existing call sites across
`categories.tsx`, `channels.tsx`, `ignore-rules.tsx`, and `queue.tsx` need any code change —
they all already receive whatever shape `CategoryWithCount` currently has.

### `CategoriesList` view: Delete button (`src/views/categories-list.tsx`)

The non-edit-mode row's action `<span>` (currently only rendering `[system]` text or an Edit
button) gains a Delete button alongside Edit, both still gated on `!category.isSystem`:

```tsx
<span class="flex items-center gap-2 text-sm text-text-muted">
  {category.isSystem ? "[system]" : null}
  {category.isSystem ? null : (
    <>
      <button
        type="button"
        hx-get={`/categories/${category.id}/edit`}
        hx-target="#category-list"
        hx-swap="outerHTML"
        class={SECONDARY_BUTTON_CLASS}
      >
        Edit
      </button>
      <button
        type="button"
        hx-delete={`/categories/${category.id}`}
        hx-target="#category-list"
        hx-swap="outerHTML"
        hx-confirm={`Delete "${category.name}"? ${category.channelCount} channel${category.channelCount === 1 ? "" : "s"} will move to Uncategorized.`}
        class={SECONDARY_BUTTON_CLASS}
      >
        Delete
      </button>
    </>
  )}
</span>
```

Fragment syntax (`<>...</>`) is already used elsewhere in this codebase
(`src/views/subscription-list.tsx:39`, `src/views/queue-list.tsx:301/309/317`), so this
isn't introducing a new JSX pattern. `hx-confirm`'s value is plain HTML-escaped text (Hono
JSX escapes attribute values by default) — a category named e.g. `Tom & Jerry's Picks` needs
no special handling beyond what `category.name` already gets everywhere else in this file
(the same interpolation already happens unescaped-of-concern in the `<a>` link text above
it). A 0-channel category still shows a confirm (`"...? 0 channels will move..."`) — no
special-casing to skip confirmation when nothing would actually move, since the delete
itself is still irreversible regardless of count.

### `SubscriptionList` pill restyle (`src/views/subscription-list.tsx`)

Current (`subscription-list.tsx:35-37`):

```tsx
<span class="flex flex-wrap items-center gap-2">
  {subscription.channelName} ({subscription.unwatchedCount}) (
  {subscription.categoryName})
```

Becomes:

```tsx
<span class="flex flex-wrap items-center gap-2">
  {subscription.channelName} ({subscription.unwatchedCount})
  <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
    {subscription.categoryName}
  </span>
```

Exact class list copied verbatim from `queue-list.tsx:158`/`189`/`239`. No change to
`Subscription`'s type, the surrounding `showMissedVideosBadge`/Dismiss/Unsubscribe markup
(spec020's `justify-between` restructure), or any route logic — purely swapping one
parenthetical text run for a pill `<span>` with the same text content.

### `docs/app_idea.md` update

Line 129's final sentence:

> No explicit delete operation is needed for MVP - a category with zero channels attached
> just stops appearing anywhere; it can linger harmlessly or be auto-pruned later.

becomes:

> Delete is supported for any non-system category, reassigning its channels to
> `Uncategorized` rather than requiring it be empty first (refined in
> docs/specs/021-category-delete.md).

## Testing

New tests, following this codebase's existing per-route/per-lib test file split
(`test/routes/categories.test.ts`, `test/lib/categories.test.ts`):

- `test/lib/categories.test.ts`: `listCategoriesWithCounts` returns the correct
  `channelCount` for a category with 0, 1, and multiple subscriptions, including one from a
  second user (confirming the count is global, not user-scoped) and one that's unsubscribed
  (confirming inactive rows still count, since they still hold the FK).
- `test/routes/categories.test.ts`:
  - `DELETE /categories/:id` on a category with active subscriptions moves every one of them
    to the system category (assert each affected `Subscription.categoryId` afterward) and
    removes the category row.
  - Same, but including an unsubscribed row in that category — also reassigned, not left
    dangling.
  - `DELETE` on the system category id is rejected with the "Cannot delete the system
    category." error and the row still exists afterward (mirrors the existing rename-rejection
    test at `categories.test.ts` for the system row).
  - `DELETE` on a nonexistent id 404s (mirrors the existing "renaming a nonexistent id
    404s" test).
  - The rendered `CategoriesList` HTML after a successful delete contains a Delete button
    with the correct `hx-confirm` text for a remaining category (spot-checking the channel
    count wording), and contains no Delete button for the system row.
- `test/routes/channels.test.ts`: confirmed (full-file read during red-team review) that no
  existing test asserts on `categoryName` in any form — `extractSubscriptionRow` and related
  helpers only ever check channel name and unwatched count text — so no existing test needs
  updating for the pill restyle. A new test is added instead: `GET /channels` renders a
  subscription's category name inside a `rounded-full` `<span>`, not as a bare
  `(categoryName)` parenthetical.

No migration/schema test needed — this spec adds no column, table, or index.

## Verification

Per CLAUDE.md's split:

**Claude performs directly** (via `curl` from inside the devcontainer, or direct SQLite
reads against the dev DB):
1. `bun test`, `bun run lint`, and `bunx tsc --noEmit` all clean.
2. Create a category, subscribe a channel to it, `curl -X DELETE
   /categories/:id` with a valid session/CSRF, then read the `subscriptions` table directly
   to confirm that channel's `categoryId` now points at the system category, and that the
   category row is gone.
3. `curl -X DELETE` against the system category's id — confirm the response still contains
   "Cannot delete the system category." and the row is unchanged in the DB.
4. `curl /channels` — confirm the category name now renders inside a `rounded-full` `<span>`
   rather than in parentheses.

**User performs live in a browser:**
1. Visit `/categories`, delete a category that has channels in it — confirm the native
   browser confirm dialog shows the right channel count, and after confirming, the category
   disappears from the list (HTMX partial swap, no full reload) with no page-level error.
2. Visit `/channels` — confirm those channels now show `Uncategorized` in their category
   pill.
3. Visit `/channels` generally — confirm the category label now renders as a rounded pill
   matching the look of a category pill on a queue-view video card, at both desktop and
   mobile widths.
4. Confirm the sidebar's category list on `/categories` still shows the deleted category
   until the next full navigation (accepted staleness, per Scope), then disappears once you
   navigate anywhere.

## Open Questions

None outstanding — confirmation UX (native `hx-confirm`), pill-restyle bundling, and
straight-to-`/new-spec` were all settled in the pre-spec scoping conversation (see Context).

**Red-team retrospective:** One independent pass (subagent, no memory of the drafting
conversation, checking every line citation and factual claim against the actual source
files) found four things: (1) flagged that `docs/app_idea.md` was already edited to
describe delete as present-tense working behavior while this spec is still `status: draft`,
appearing to break precedent. Checked against git history and found the opposite: `git log
-S` on the `docs/specs/008-mvp-completion-gaps.md` app_idea.md pointer shows that spec's
cross-reference was added to `app_idea.md` in the *same commit* that added spec008 itself
at `status: draft` (commit `84ec43a`) — i.e. this spec's Step-5 product-doc edit, made at
draft time, matches established practice exactly, not an inconsistency. No change made. (2)
A real off-by-one: the `subscription-list.tsx` "Current" snippet was cited as lines 36-38;
actual lines are 35-37 — fixed. (3) `channelCount` counts `Subscription` rows, not distinct
`YoutubeChannel`s, so it could over-count in the (currently unreachable in practice)
cross-user-shared-category case — added an explicit naming-caveat paragraph documenting and
accepting this rather than silently leaving it unstated. (4) The Testing section had hedged
uncertainty about whether `test/routes/channels.test.ts` already asserts on category-name
text; the pass read the full file and confirmed it doesn't — tightened that bullet to state
this definitively and added a new-test bullet for the pill markup instead of an
update-existing-test bullet. All other citations (FK/transaction reasoning including the
actual `ON DELETE no action` clause in `drizzle/0000_baseline.sql:36`, the 21-call-site
count, `getSystemCategory()`'s collision-freedom, `hx-confirm`/Hono-JSX-escaping behavior,
and both cited existing-test mirror claims) were confirmed accurate. No second full pass run
— per the skill's guidance, these are straightforward corrections (one non-issue resolved by
evidence, two citation/wording nits, one hedge resolved to a confirmed fact) rather than new
design questions, so a second full pass isn't warranted.
