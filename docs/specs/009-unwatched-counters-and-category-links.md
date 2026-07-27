---
status: implemented
created: 2026-07-27
---

# Unwatched Counters and Category Queue Links

## Context

Ahead of the *Styling* pass (`docs/app_idea.md`'s *Path to v1.0*, step 1), a few UX
decisions were deliberately pulled out and resolved first so the styling spec doesn't have
to make functional decisions disguised as visual ones. This spec is the result of that
scoping conversation. It has no schema changes and touches no watch-status semantics —
purely new read-only counts and one new link, layered on queries that already exist in
`src/routes/queue.tsx`.

## Scope

**In:**
1. The persistent nav (`src/views/layout.tsx`) shows a count next to three links:
   `Queue (x)`, `Continue Watching (x)`, `Watched (x)`.
2. The Categories page (`src/routes/categories.tsx`, `src/views/categories-list.tsx`) shows
   an unwatched+watching count next to every category, including the system
   `Uncategorized` row, and the category name becomes a link to that category's filtered
   Queue view.
3. The Channels page (`src/routes/channels.tsx`, `src/views/subscription-list.tsx`) shows
   an unwatched+watching count next to every subscribed channel. No link.

**Out (deferred, not this spec):**
- Any visual/styling treatment of the new counts or link (color, weight, badge shape,
  spacing) — that's exactly the kind of decision this spec exists to keep out of the
  styling spec's way, not to pre-empt it. The counts render as plain
  `Label (N)`/`Name (N)` text, matching the nav's existing plain-text-link style.
  `docs/specs/008-mvp-completion-gaps.md`'s `⚠ Possible missed videos` notice is the
  closest existing precedent for "unstyled but functional," and this follows the same
  approach.
- Linking each **channel** name on the Channels page to a filtered Queue view. `queueVideos`
  and its siblings in `src/routes/queue.tsx` only support an optional `categoryId` filter
  today — there is no `channelId`/`subscriptionId` filter anywhere in that file. Adding one
  is a real backend change (new query param, a `resolveChannelFilter` parser mirroring
  `resolveCategoryFilter`, a new `where` clause across all four list functions), not UI
  wiring against something that already exists like the category link is. Left for a future
  spec if wanted.
- Live-updating any of the new counts after an in-page HTMX action (mark watched, ignore,
  mark watching, toggle) that doesn't do a full page navigation. Counts are computed fresh
  on every full-page `Layout`/Categories/Channels render, which is correct as of that render,
  but can go stale relative to an HTMX partial swap on the same page until the next full
  navigation. Deliberately accepted — see Design's "Nav counter staleness" note.
- Any change to sort order on the Categories or Channels page. Counts are additive display
  only.
- Category delete, per-video tags, or any other item already listed Out of Scope by
  `docs/specs/006-category-queue-filtering.md` / `007-ignore-rules-and-ignored-view.md` /
  `008-mvp-completion-gaps.md` — unaffected by this spec.

## Design

### Count definitions

All "unwatched" counts in this spec mean `status IN ('unwatched', 'watching')` — i.e. the
same union `queueVideos()` (`src/routes/queue.tsx:22-58`) already uses for the default Queue
view — not strictly `status = 'unwatched'`. This keeps every badge number equal to what
you'd actually see if you clicked through to the corresponding filtered Queue view, which
was the deciding factor over the more literal "unwatched only" reading during scoping.

| Badge | Status filter | Active-subscription scoped? | Category filter applied? |
|---|---|---|---|
| `Queue (x)` | `unwatched ∪ watching` | Yes | No — always the global total, independent of any `?category=` filter currently applied on the Queue page itself |
| `Continue Watching (x)` | `watching` | Yes | No |
| `Watched (x)` | `watched` | **No** — true history, matches `watchedVideos()` (`queue.tsx:92-127`) exactly | No |
| Category row count | `unwatched ∪ watching` | Yes | Scoped to that one category |
| Channel row count | `unwatched ∪ watching` | Yes (page already only lists active subscriptions) | N/A — scoped to that one channel |

The Watched nav badge's true-history scope is a deliberate asymmetry with the other two nav
badges, matching `app_idea.md`'s existing statement that Watched "is not scoped to active
subscriptions" (line 41) — keeping the badge scoped-differently-but-correctly was chosen
over forcing all three badges to share one scoping rule, since the alternative would make
the badge disagree with the page it links to.

### New file: `src/lib/nav-counts.ts`

```ts
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos } from "../db/schema";

export type NavCounts = {
  queueCount: number;
  continueWatchingCount: number;
  watchedCount: number;
};

export function getNavCounts(userId: number): NavCounts {
  const queueCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, videos.channelId))
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          inArray(videos.status, ["unwatched", "watching"]),
        ),
      )
      .get()?.count ?? 0;

  const continueWatchingCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, videos.channelId))
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          eq(videos.status, "watching"),
        ),
      )
      .get()?.count ?? 0;

  const watchedCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, videos.channelId))
      .where(and(eq(subscriptions.userId, userId), eq(videos.status, "watched")))
      .get()?.count ?? 0;

  return { queueCount, continueWatchingCount, watchedCount };
}
```

Two deliberate departures from the row-listing queries it mirrors:

- **No `youtubeChannels`/`categories` join.** `queueVideos()` et al. join through
  `youtubeChannels` only to read `youtubeChannels.name`/`categories.name` for display
  columns a count query doesn't need. `subscriptions.youtubeChannelId` and
  `videos.channelId` both point at the same `youtube_channels.id` space, so joining
  `subscriptions` directly against `videos.channelId` is sufficient and correct.
- **`count()` (from `drizzle-orm`, confirmed present in the installed `drizzle-orm@0.45.2`
  at `sql/functions/aggregate.d.ts`), not `.all().length`.** Avoids materializing full row
  data just to count it. `.get()` always returns exactly one row for an unconditional
  `COUNT(*)` (even when the count is 0), but Drizzle's return type is `Row | undefined`
  regardless — `?? 0` satisfies that without a non-null assertion.

This lives in `src/lib/`, not inside `queue.tsx`, specifically because `categories.tsx`,
`channels.tsx`, and `ignore-rules.tsx` all need it too, and none of them otherwise depend on
`queue.tsx` — every existing route file in this codebase imports from `lib/`/`db/`/`views/`,
never from another `routes/` file, and this spec keeps that direction intact rather than
introducing the first route-to-route import.

### `Layout` gains a required `navCounts` prop

`src/views/layout.tsx`'s `Layout` component takes a new required prop (not optional — see
below for why) and renders it into the three links:

```tsx
import type { NavCounts } from "../lib/nav-counts";

export const Layout: FC<{ title: string; navCounts: NavCounts; children?: Child }> = (
  props,
) => (
  // ...
  <a href="/queue">Queue ({props.navCounts.queueCount})</a> |{" "}
  <a href="/continue-watching">
    Continue Watching ({props.navCounts.continueWatchingCount})
  </a> |{" "}
  <a href="/watched">Watched ({props.navCounts.watchedCount})</a> |{" "}
  <a href="/ignored">Ignored</a> | ...
);
```

`navCounts` is required, not optional, so a call site that forgets to compute and pass it
is a `tsc --noEmit` compile error, not a silently-blank badge — worth being strict about
given this touches 8 render call sites across 4 route files.

**Every call site that renders `<Layout>`, directly or via a wrapping view, must supply
`navCounts={getNavCounts(user.id)}`:**

| Call site | File | Currently calls `getCurrentUser()`? | Change needed |
|---|---|---|---|
| `GET /queue` | `src/routes/queue.tsx:275-298` | Yes | Add `navCounts={getNavCounts(user.id)}` to the existing `<Layout>` |
| `GET /continue-watching` | `queue.tsx:321-338` | Yes | Same |
| `GET /watched` | `queue.tsx:340-357` | Yes | Same |
| `GET /ignored` | `queue.tsx:359-376` | Yes | Same |
| `GET /watching/:id` | `queue.tsx:378-401` | **No** | Add `const user = getCurrentUser();` (already imported), pass a new `navCounts: NavCounts` field through `WatchingPageProps` (`src/views/watching-page.tsx:43-53`) to its internal `<Layout navCounts={props.navCounts}>` (`watching-page.tsx:61`) |
| `GET /` (Categories) | `src/routes/categories.tsx:18-20` | **No** (`getCurrentUser` not imported) | Import `getCurrentUser`; thread a new `navCounts: NavCounts` prop through `CategoriesPage` (`src/views/categories-page.tsx`) to its `<Layout>` |
| `GET /channels` | `src/routes/channels.tsx:107-115` | Yes | Thread a new `navCounts: NavCounts` prop through `ChannelsPage` (`src/views/channels-page.tsx`) to its `<Layout>` |
| `GET /ignore-rules` | `src/routes/ignore-rules.tsx:11-13` | **No** (`getCurrentUser` not imported) | Import `getCurrentUser`; thread a new `navCounts: NavCounts` prop through `IgnoreRulesPage` (`src/views/ignore-rules-page.tsx`) to its `<Layout>` |

Every other route handler in these files (`POST /categories`, `POST /categories/:id`,
`POST /subscriptions`, `POST /videos/:id/toggle`, etc.) returns an HTMX partial that
doesn't touch `<Layout>` at all, so none of them need `navCounts` — consistent with the
"no live update" decision below.

**Nav counter staleness (accepted tradeoff):** several of those partial-response handlers
change what the nav counts *should* say (e.g. `POST /videos/:id/toggle` moves a video
between Queue and Watched) without re-rendering the nav. The visible list under the action
updates immediately via its own HTMX swap; the nav badge only catches up on the next full
navigation. This was chosen deliberately over adding an out-of-band nav-badge fragment to
every mutating endpoint (the same pattern `WatchStatusBadge`/`SubscriptionList` already use
for their own OOB updates) because it avoids new plumbing in roughly five route handlers for
a staleness window that self-corrects on the very next click to any nav link.

### Categories page: count + link

`src/routes/categories.tsx`'s `listCategories()` (currently `() => ...`, no params) becomes
`listCategories(userId: number)`, joining in a per-row count:

```ts
function categoryUnwatchedCount(userId: number, categoryId: number): number {
  const row = db
    .select({ count: count() })
    .from(videos)
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, videos.channelId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.categoryId, categoryId),
        isNull(subscriptions.unsubscribedAt),
        inArray(videos.status, ["unwatched", "watching"]),
      ),
    )
    .get();
  return row?.count ?? 0;
}

function listCategories(userId: number) {
  return db
    .select()
    .from(categories)
    .orderBy(desc(categories.isSystem), asc(categories.name))
    .all()
    .map((category) => ({
      ...category,
      unwatchedCount: categoryUnwatchedCount(userId, category.id),
    }));
}
```

One count query per category (N+1), not a single grouped query — a `LEFT JOIN` +
conditional-`COUNT` + `GROUP BY` expressed through Drizzle's typed query builder would be
substantially harder to read for no real benefit at this app's scale (a personal tool with,
realistically, a handful to a few dozen categories). Same tradeoff applies to the Channels
page below.

`listCategories` is called from every handler in `categoriesRoute` — 14 call sites total:
`GET /` (1), `POST /categories`'s five return paths (too-long name, empty name, reserved
name, unique-constraint catch, success), `GET /categories/:id/edit`'s two paths (found,
not-found-or-system), `POST /categories/:id`'s six return paths (not-found, isSystem,
too-long name, empty name, reserved name, unique-constraint catch, success — note this is
actually seven conditions but the not-found branch returns `c.notFound()` directly without
calling `listCategories()`, so six of the seven call it). Every one of these becomes a
`tsc --noEmit` arity error the moment `listCategories()`'s signature requires `userId`,
which is exactly the enforcement mechanism relied on here — each already has or gains a
`const user = getCurrentUser();` at the top (needed for `GET /` per the `navCounts` table
above; the `POST`/`edit` handlers need it newly, purely to pass `user.id` into
`listCategories`, since none of them render `<Layout>` and so don't need `navCounts`
themselves).

`categories.tsx` needs new imports: `and`, `count`, `inArray`, `isNull` from `drizzle-orm`
(currently only imports `asc, desc, eq`); `subscriptions`, `videos` from `../db/schema`
(currently only imports `CATEGORY_NAME_MAX_LENGTH, categories`); `getCurrentUser` from
`../lib/current-user`.

**`CategoriesList` view** (`src/views/categories-list.tsx`): its `Category` type (currently
`typeof categories.$inferSelect`, declared locally and not exported) becomes that shape
intersected with `{ unwatchedCount: number }`, **and must now be exported** — `export type
Category = ...`. `src/views/categories-page.tsx` currently declares its own separate,
non-exported `type Category = typeof categories.$inferSelect` (`categories-page.tsx:6`)
rather than importing `CategoriesList`'s; that has to change to `import { type Category,
CategoriesList } from "./categories-list";`, dropping its local declaration, or
`CategoriesPage`'s `props.categories: Category[]` (the old, `unwatchedCount`-less shape)
won't satisfy `CategoriesList`'s new prop type and `tsc --noEmit` will fail at
`categories-page.tsx:11`. This mirrors the pattern `channels-page.tsx` already uses —
`import { type Subscription, SubscriptionList } from "./subscription-list";` — which is
exactly why the equivalent gap doesn't exist on the Channels side. The non-edit-mode row's
plain-text name becomes a link, applying to every
category including the system row (no special-casing — `/queue?category=<id>` already
works for the system category's id today, since `resolveCategoryFilter`
(`queue.tsx:159-169`) only checks existence, not `isSystem`):

```tsx
<a href={`/queue?category=${category.id}`}>
  {category.name} ({category.unwatchedCount})
</a>
{category.isSystem ? " [system]" : ""}{" "}
{category.isSystem ? null : (
  <button type="button" hx-get={`/categories/${category.id}/edit`} ...>Edit</button>
)}
```

The whole `Name (N)` label is the link (not just the name text) — decided during scoping
for the larger click target, with no functional downside since the count itself isn't
independently actionable.

### Channels page: count only, no link

`src/routes/channels.tsx`'s `listActiveSubscriptions()` select object
(`channels.tsx:68-75`) gains a new key so a per-row count can key off the channel's id
(currently only `youtubeChannels.name as channelName` is selected, not the id itself):

```ts
.select({
  id: subscriptions.id,
  channelName: youtubeChannels.name,
  categoryName: categories.name,
  youtubeChannelId: youtubeChannels.id, // new
  possibleMissedVideosDetectedAt: youtubeChannels.possibleMissedVideosDetectedAt,
  missedVideosDismissedAt: subscriptions.missedVideosDismissedAt,
})
```

Then each row maps through a new `channelUnwatchedCount`:

```ts
function channelUnwatchedCount(youtubeChannelId: number): number {
  const row = db
    .select({ count: count() })
    .from(videos)
    .where(
      and(
        eq(videos.channelId, youtubeChannelId),
        inArray(videos.status, ["unwatched", "watching"]),
      ),
    )
    .get();
  return row?.count ?? 0;
}
```

No `userId`/subscription join needed here, unlike the category count — a channel row in
`listActiveSubscriptions`'s output already corresponds to exactly one specific
`youtubeChannelId` for the current user (the query is already `WHERE
subscriptions.userId = :userId`), so counting that channel's videos directly is correct
without re-scoping.

`listActiveSubscriptions`'s `.map(...)` (`channels.tsx:90-102`) gains `unwatchedCount:
channelUnwatchedCount(youtubeChannelId)` alongside the existing `showMissedVideosBadge`
computation, destructuring the newly-selected `youtubeChannelId` out of `rest` the same way
`possibleMissedVideosDetectedAt`/`missedVideosDismissedAt` already are, so it doesn't leak
into the `Subscription` shape the view receives.

`channels.tsx` needs new imports: `count`, `inArray` from `drizzle-orm` (currently `and,
asc, eq, isNull`); `videos` from `../db/schema` (currently `categories, subscriptions,
youtubeChannels`).

**`SubscriptionList` view** (`src/views/subscription-list.tsx`): `Subscription` type gains
`unwatchedCount: number`. Row text becomes:

```tsx
{subscription.channelName} ({subscription.unwatchedCount}) ({subscription.categoryName})
```

Plain text, not a link, per Scope above.

## Open Questions

None outstanding — the count definitions, scoping rules, staleness tradeoff, and the
categories-vs-channels link asymmetry were all resolved during the pre-spec scoping
conversation (queue-badge global-vs-filtered question, Watched true-history scoping,
zero-count display, live-update deferral, category-count active-subscription scoping,
system-category inclusion, whole-label-vs-name-only link target).

**Red-team retrospective:** One independent pass (subagent, no memory of the drafting
conversation, given only the draft spec and the actual source files to verify claims
against) found three real issues in the first draft, all fixed directly above: (1) the
`ignore-rules.tsx` Layout call-site citation was off by one line (`10-12` → `11-13`); (2)
the `listCategories()` call-site inventory undercounted — the draft implied 12 total call
sites in `categoriesRoute`, the actual count is 14 (`POST /categories` has five return paths
not four, `POST /categories/:id` has six not five) — corrected with the exact breakdown; (3)
a real `tsc --noEmit` gap: `categories-page.tsx` declares its own separate, non-exported
`Category` type rather than importing `CategoriesList`'s, so adding `unwatchedCount` to
`CategoriesList`'s prop type alone would leave `CategoriesPage`'s render call
type-mismatched — fixed by having `categories-list.tsx` export its `Category` type and
`categories-page.tsx` import it, mirroring the pattern `channels-page.tsx` already uses for
`Subscription`. The pass also confirmed as accurate: the `count()` Drizzle export and
installed version, the FK-equivalence argument for skipping the `youtubeChannels` join in
`nav-counts.ts`, the `resolveCategoryFilter` no-`isSystem`-exclusion claim, the full 8-call-site
`<Layout>` inventory, and all other design self-consistency checks (Watched true-history
scoping, the staleness tradeoff's exact blast radius, the N+1 approach, the required-prop
rationale). A narrower follow-up check (scoped only to these three fixes, per the skill's
guidance that this is a reasonable substitute for a second full pass once a first pass's
findings are all straightforward corrections rather than raising new design questions)
confirmed each fix is internally consistent with the rest of the Design section. No second
full pass was run.
