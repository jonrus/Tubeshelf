---
status: in-progress
created: 2026-07-30
---

# Style and Layout Foundation

## Context

The app is functionally complete for MVP (specs 001–010) but visually unstyled: every page
is a bare `<ul>`/`<li>` list, Tailwind v4 is wired in but only 3 color utilities are used
anywhere (`bg-gray-50`, `text-gray-900`, `text-red-600`), and there is no dark theme, no
thumbnails on any list view, and a single flat horizontal top-nav with no active-link
indication. `docs/app_idea.md`'s *Path to v1.0* names this the deliberate next step, ahead
of Auth, specifically because the app's specs lean on manual browser verification and doing
the visual-iteration-heavy work while the app is still auth-free keeps that loop cheap.

This spec originates from `docs/features/002-style-and-layout.md` (`status: refined`), which
already ran a scoping pass grounded in the current codebase and resolved the big-picture
questions: dark-mode-only (no toggle), a sidebar nav replacing the flat top-nav, a card-grid
treatment for the four video-list views (Queue, Continue Watching, Watched, Ignored) modeled
on `docs/features/002-UI_wireframe.html`, a distinct simpler list/table treatment for the
three CRUD-style pages (Categories, Ignore Rules, Channels), reused (not newly-fetched)
video thumbnails, relative-time formatting instead of absolute dates, and no new detail
pages/view-count capture/ignored-count. This spec confirms that scope against the current
code, resolves the implementation-level design the feature file didn't get into, and is now
the source of truth for this work.

One functional risk surfaced while writing this spec, not present in the feature file:
today, `/queue`, `/continue-watching`, `/watched`, and `/ignored` each have their own
in-page category filter row (`CategoryFilterLinks`, `src/views/queue-list.tsx:82-96`), so a
user can filter *any one* of those four pages by category while staying on it (e.g. filter
Watched to "Podcasts" and stay on Watched). The feature file's decision to replace that row
with sidebar category links, if the sidebar always targeted `/queue`, would silently regress
that per-page capability down to "browse Queue by category, then start over to browse another
view." Confirmed during spec scoping: the sidebar is **view-aware** — see Design's *Sidebar
category links* section — so this capability is preserved, not dropped.

## Scope

**In** (see Design for the full breakdown):
- Dark-theme design tokens layered on Tailwind v4's `@theme` mechanism, applied globally —
  no toggle, no `prefers-color-scheme` detection, matching the feature file's explicit
  out-of-scope call.
- A sidebar nav (`src/views/layout.tsx`) replacing the flat top-nav, with:
  - Top-level links: Queue, Continue Watching, Watched, Categories, Ignored, Channels — each
    showing its existing count where one already exists (Queue/Continue Watching/Watched
    from `NavCounts`; Categories/Ignored/Channels show no count, matching today).
  - A "Categories" section whose sub-items are the live category list (each showing its
    existing per-category unwatched count), linking into a category filter — view-aware (see
    below), not hardcoded to Queue.
  - An "Ignored" section with "Ignore Rules" nested under it as a sub-item, preserving
    `/ignore-rules`'s reachability (the wireframe's sidebar sketch doesn't show a `/categories`
    or `/ignore-rules` link explicitly — see Design for how this spec resolves that gap).
  - Active-link highlighting for the current top-level view and, when applicable, the current
    category filter — explicitly deferred by specs 004/006/009/010 to "whenever the styling
    pass happens"; this is that pass.
  - Collapses to an off-canvas drawer behind a hamburger toggle below the `lg` (1024px)
    breakpoint; persistently docked at `lg` and above.
- Removing the four video-list views' in-page `CategoryFilterLinks` row now that the sidebar
  covers the same function (view-aware, per the Context note above).
- Video thumbnails on Queue, Continue Watching, Watched, and Ignored (reusing the same
  `i.ytimg.com` URL pattern already used on the Watching page — no new data/API calls).
- Restyling Queue, Continue Watching, Watched, and Ignored as a responsive card grid.
- Relative-time formatting (`2h`, `3d`, `1w`, falling back to an absolute date past 4 weeks)
  replacing `toLocaleDateString()` on Queue/Continue Watching/Watched row dates.
- Empty-state messaging on all four video-list views (and the three CRUD list views) when
  their row count is zero.
- Restyling Categories, Ignore Rules, and Channels/Subscribe as a distinct, simpler
  list/table treatment (not the card grid) — their inline-edit-swaps-to-a-form interaction
  pattern is unchanged, only visual.
- Restyling the Watching page (thumbnail, status badge, buttons) to match the same design
  tokens as every other page, even though the wireframe itself doesn't depict it.
- Everything above works at both the primary desktop width (1920×1080) and a mobile
  viewport, per the feature file's Firm Scope.

**Out (deferred, per the feature file and unchanged here):**
- A light/dark toggle or `prefers-color-scheme` detection.
- View-count display (the data doesn't exist in the schema — real new capability).
- New detail pages for an individual Channel or Category.
- An `ignoredCount` badge (Ignored/Ignore Rules stay countless in the sidebar).
- Any change to watch-status transitions, ignore-rule matching/reconciliation, subscribe
  flow validation, or any other business logic — this spec only touches rendering
  (views/layout) and the small amount of new read-only query logic needed to feed it
  (relative-time formatting is pure display, not a new data source).
- Auth/CSRF — unchanged deferred posture, same as every prior spec.

## Design

### Design tokens (`src/styles/input.css`)

Tailwind v4 is CSS-first — there is no `tailwind.config.js` in this repo, and none is added.
Custom design tokens are declared in a `@theme` block, which auto-generates matching
utilities (`--color-*` tokens produce `bg-*`/`text-*`/`border-*` classes under that name):

```css
@import "tailwindcss";

@theme {
  --color-bg: #020617; /* page background */
  --color-surface: #0f172a; /* cards, sidebar, panels */
  --color-surface-raised: #1e293b; /* hover/elevated surfaces, input backgrounds */
  --color-border: #334155; /* borders, dividers */
  --color-text: #f1f5f9; /* primary text */
  --color-text-muted: #94a3b8; /* secondary text (metadata, timestamps) */
  --color-accent: #2dd4bf; /* links, active nav state, watching indicator */
  --color-accent-strong: #14b8a6; /* button backgrounds/hover */
  --color-danger: #f87171; /* errors, warnings -- replaces text-red-600 */
}
```

Values are drawn from Tailwind's own default `slate`/`teal`/`red` scales (slate-950/900/800/
700/100/400, teal-400/500, red-400) rather than invented from scratch — keeps the palette
inside Tailwind's already-accessible, already-tuned-for-contrast set rather than picking
arbitrary hex values. `text-red-600` (used today in `categories-list.tsx:57`,
`subscription-list.tsx:48`, `ignore-rules-list.tsx:57`, `subscribe-confirm.tsx:75`) is
replaced with the new `text-danger` token everywhere it appears, and `layout.tsx:30`'s
`bg-gray-50 text-gray-900` body classes (the app's only other pre-existing color utilities)
become `bg-bg text-text` — no page keeps the old gray-on-white Tailwind defaults once this
spec lands.

**Font stays a system stack, not the wireframe's Google Fonts import.** The wireframe
(`docs/features/002-UI_wireframe.html:12-19`) pulls in "Patrick Hand"/"Architects Daughter"
— that's the wireframing tool's own hand-drawn-mockup convention for indicating "this is a
rough sketch," not a literal font choice to carry into the real app. The app uses Tailwind's
default `font-sans` stack (`ui-sans-serif, system-ui, ...`), consistent with the project's
zero-external-runtime-dependency posture (no new Google Fonts network fetch on every page
load of a self-hosted app).

### Shared libs (new/moved)

Three small lib modules are introduced or consolidated so views/routes stop duplicating
logic — the same "move it to `lib/` once more than one file needs it" pattern spec009
already used for `getNavCounts`/`getCurrentUser`.

**`src/lib/youtube.ts` (new)** — consolidates the two independent, near-identical URL
builders that exist today (`queue-list.tsx:35-37`'s `youtubeUrl` and
`watching-page.tsx:15-17`'s `thumbnailUrl`):

```ts
export function youtubeWatchUrl(youtubeVideoId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
}

export function youtubeThumbnailUrl(youtubeVideoId: string): string {
  return `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
}
```

`queue-list.tsx` and `watching-page.tsx` both import from here instead of declaring their
own copy; `queue-list.tsx`'s three video-list card variants (queue/continue-watching,
watched) gain a thumbnail `<img src={youtubeThumbnailUrl(row.youtubeVideoId)} ...>` they
didn't render before. The Ignored view's `IgnoredRow` type (`queue-list.tsx:27-33`) has no
`youtubeVideoId` field today (spec007 didn't need it, since Ignored rows render plain
non-clickable text) — it gains one, added to `ignoredVideos()`'s `.select({...})` object in
`src/routes/queue.tsx:130-158` (`videos.youtubeVideoId`, the column already available off the
query's own `.from(videos)` base table — no new join needed, just one more field in an
existing select), purely to build its thumbnail's `src`. The Ignored card's thumbnail is a plain
`<img>`, not wrapped in the `.watch-link` anchor, matching spec007's existing
"non-clickable — these are things to *not* watch" design (unchanged by this spec).

**Broken/missing thumbnail fallback:** spec004's Open Questions flagged "no fallback for a
missing/404'ing thumbnail image... revisit if it turns out to look broken often in
practice" — with thumbnails now on 4 more views instead of 1, this is worth a small
addition rather than continuing to defer: every thumbnail `<img>` gets
`onerror="this.style.visibility='hidden'"`. This doesn't need a placeholder asset — the
card's own `bg-surface`-colored, fixed-aspect-ratio box (see Video-card grid below) is
already visually intact underneath; hiding a broken `<img>` just leaves that box's
background color showing instead of a broken-image icon.

**`src/lib/relative-time.ts` (new)**:

```ts
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  // Clamp negative diffs (a future publishedAt from clock skew, or a malformed/adversarial
  // RSS timestamp -- publishedAt is untrusted external feed data, same posture rss.ts
  // already takes toward it elsewhere) to "just now" rather than rendering "-1h" or similar.
  if (diffMs <= 0) return "just now";
  if (diffMs < MINUTE) return "just now";
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h`;
  if (diffMs < WEEK) return `${Math.floor(diffMs / DAY)}d`;
  if (diffMs < 4 * WEEK) return `${Math.floor(diffMs / WEEK)}w`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
```

Used wherever `row.publishedAt`/`row.watchedAt` are rendered in `queue-list.tsx` (currently
`row.publishedAt.toLocaleDateString()` at line 169, `row.watchedAt.toLocaleDateString()` at
line 130) — same existing null-guard (`row.publishedAt ? ... : ""`) stays, only the
formatting call inside it changes. The compact no-"ago"-suffix style (`2h`, not `2h ago`)
matches the wireframe's card labels (`docs/features/002-UI_wireframe.html:67,94,105`, etc.)
directly.

**`src/lib/categories.ts` (new)** — consolidates `categories.tsx`'s local `listCategories`
(`src/routes/categories.tsx`, already computes id/name/isSystem/unwatchedCount for the
Categories management page) and `queue.tsx`'s local `allCategories()`
(`src/routes/queue.tsx:172-182`, only id/name/isSystem, feeding the now-deleted
`CategoryFilterLinks`) into one shared function — both callers actually want the same
richer shape (the sidebar's category sub-items show the same unwatched count the Categories
page already shows per row, since this is carrying forward existing functionality into a
new location, not adding a new one):

```ts
// Deliberately the SAME shape categories-list.tsx's existing (currently locally-declared)
// Category type already is -- typeof categories.$inferSelect & { unwatchedCount: number },
// i.e. the full category row (id, name, isSystem, createdAt) plus the count. NOT narrowed
// down to just the fields the sidebar happens to use (id/name/isSystem/unwatchedCount) --
// see the note below on why that narrower shape doesn't actually work here.
export type CategoryWithCount = typeof categories.$inferSelect & {
  unwatchedCount: number;
};

export function listCategoriesWithCounts(userId: number): CategoryWithCount[] {
  // Same query shape as categories.tsx's current listCategories(userId) + its
  // categoryUnwatchedCount(userId, categoryId) helper -- moved here verbatim, not
  // redesigned.
}
```

**Real type mismatch caught in review, fixed here rather than left implicit:** an earlier
draft of this section typed `CategoryWithCount` narrowed to just
`{ id, name, isSystem, unwatchedCount }` (the fields the sidebar actually reads). But
`categories-list.tsx:4-6` already declares its own `Category = typeof categories.$inferSelect
& { unwatchedCount: number }` — which includes `createdAt: Date` — and both `CategoriesList`
and `CategoriesPage` (`categories-page.tsx:6-9`) type their `categories` prop as `Category[]`.
Feeding the narrowed shape into `listCategoriesWithCounts`'s 14 `categories.tsx` call sites
(which render `CategoriesList`/`CategoriesPage`) would be a `tsc --noEmit` missing-property
error, not just a style inconsistency — the exact "nullable/missing-field mismatch that
`tsc --noEmit` catches but `bun test`/lint don't" failure category CLAUDE.md already flags as
having bitten this project once (spec005→spec006). Fixed by having the shared
`CategoryWithCount` be the *same* full-row-plus-count shape `categories-list.tsx` already
uses, and having `categories-list.tsx` **import it instead of declaring its own**
(`export type Category = ...` there is deleted; `categories-list.tsx`/`categories-page.tsx`
both `import { type CategoryWithCount, listCategoriesWithCounts } from
"../lib/categories"` and use `CategoryWithCount` wherever they previously used their local
`Category`). The sidebar's `Layout` prop (Design → *Sidebar*) is typed `categories:
CategoryWithCount[]` too — it only reads `id`/`name`/`isSystem`/`unwatchedCount` off each
entry, but TypeScript's structural typing accepts the wider row-plus-count shape wherever
the narrower field set is used, so one shared type serves both consumers with no adapter
needed.

`categories.tsx`'s 14 call sites (already enumerated in full in
`docs/specs/009-unwatched-counters-and-category-links.md`'s Design section — `GET /`, five
`POST /categories` return paths, two `GET /categories/:id/edit` paths, six `POST
/categories/:id` return paths) each change their call from `listCategories(user.id)` to
`listCategoriesWithCounts(user.id)`, importing it from `../lib/categories` instead of a local
declaration — a mechanical rename plus import change, not a behavior change; the
count/query logic itself is unchanged. `queue.tsx`'s `allCategories()`
and its four call sites (the `CategoryFilterLinks` renders being deleted per Scope) are
deleted outright, not migrated — nothing in the new design calls the bare id/name/isSystem
shape once the sidebar (which needs `unwatchedCount` too) is the only remaining category-list
consumer besides the Categories page itself.

**`src/lib/queue-urls.ts` (new)** — moves `queue.tsx`'s four existing `buildXHref` helpers
(`buildQueueHref`, `buildContinueWatchingHref`, `buildWatchedHref`, `buildIgnoredHref`,
currently private functions in `src/routes/queue.tsx:268-274,303-322`) here unchanged, so
`layout.tsx`'s sidebar can build the same URLs `queue.tsx`'s own sort-toggle links already
do. This is a `views/` file needing logic today owned by a `routes/` file — moving it to
`lib/` (rather than having `layout.tsx` import from `routes/queue.tsx`, or reimplementing
the same four functions a second time) keeps the existing "routes import from
lib/db/views, views/lib never import from routes" direction spec009 already established
intact. Only `buildQueueHref` keeps an active caller inside `queue.tsx` itself after this
spec (the sort-toggle links in `GET /queue`) — its import just moves from a local
declaration to `../lib/queue-urls`. `buildContinueWatchingHref`, `buildWatchedHref`, and
`buildIgnoredHref` lose their only `queue.tsx` callers entirely once `CategoryFilterLinks`
and its four render sites are deleted (see Scope); their sole remaining caller after this
spec is `layout.tsx`'s `sidebarCategoryHref`, via the same `../lib/queue-urls` import.

### Sidebar (`src/views/layout.tsx`)

`Layout`'s props grow from `{ title, navCounts, children }` to:

```ts
export type SidebarView =
  | "queue"
  | "continue-watching"
  | "watched"
  | "ignored"
  | "categories"
  | "ignore-rules"
  | "channels";

export const Layout: FC<{
  title: string;
  navCounts: NavCounts;
  categories: CategoryWithCount[];
  currentView?: SidebarView; // undefined only for the Watching page -- see below
  currentCategory?: number; // the active ?category= filter, if any (queue/continue-watching/watched/ignored only)
  currentSort?: "newest" | "oldest"; // only meaningful when currentView === "queue"
  children?: Child;
}> = (props) => { /* ... */ };
```

**Every route that renders `<Layout>` (directly or via a wrapping `*Page` component) must
supply all of the new required props**, extending spec009's exact call-site table (that
spec's inventory of the 8 render call sites — `GET /queue`, `/continue-watching`, `/watched`,
`/ignored`, `/watching/:id`, `GET /categories`, `/channels`, `/ignore-rules` — is unchanged
in count/location, just each gains `categories={listCategoriesWithCounts(user.id)}` plus a
literal `currentView` and, for the four video-list routes, the already-computed
`category`/`sort` values passed through as `currentCategory`/`currentSort`):

| Route | `currentView` | `currentCategory` | `currentSort` |
|---|---|---|---|
| `GET /queue` | `"queue"` | the route's existing `category` | the route's existing `sort` |
| `GET /continue-watching` | `"continue-watching"` | the route's existing `category` | — |
| `GET /watched` | `"watched"` | the route's existing `category` | — |
| `GET /ignored` | `"ignored"` | the route's existing `category` | — |
| `GET /categories` | `"categories"` | — | — |
| `GET /channels` | `"channels"` | — | — |
| `GET /ignore-rules` | `"ignore-rules"` | — | — |
| `GET /watching/:id` | `undefined` | — | — |

The Watching page intentionally passes `currentView: undefined` — it isn't itself a nav
destination, so no top-level sidebar item is highlighted while on it (its existing
`from`/`sort`/`category` query params already serve return-navigation; reusing them to also
drive sidebar highlighting would conflate two different concerns for no real benefit, since
the user is looking at one video, not browsing a list).

**Four of these eight call sites are wrapper `*Page` components, not the route handler
itself — each needs its own prop-type change, not just its route.** Only the four video-list
`GET` handlers in `queue.tsx` (`/queue`, `/continue-watching`, `/watched`, `/ignored`) render
`<Layout>` directly. The other four go through a wrapping view component that itself renders
`<Layout>` internally, and each of those four components' own prop type must grow by
`categories: CategoryWithCount[]` and `currentView` (a literal, per Design → *Sidebar*'s
table) before the route handler can pass them through:

| Route | Wrapper component | File |
|---|---|---|
| `GET /categories` | `CategoriesPage` | `src/views/categories-page.tsx` |
| `GET /channels` | `ChannelsPage` | `src/views/channels-page.tsx` |
| `GET /ignore-rules` | `IgnoreRulesPage` | `src/views/ignore-rules-page.tsx` |
| `GET /watching/:id` | `WatchingPage` | `src/views/watching-page.tsx` |

`categories.tsx`, `channels.tsx`, and `ignore-rules.tsx`'s route handlers each gain a
`categories={listCategoriesWithCounts(user.id)}` (and literal `currentView`) prop passed
*into the wrapper component*, which the wrapper then forwards to its own internal `<Layout>`
call — the same two-hop shape `navCounts` already threads through today (e.g.
`CategoriesPage` already receives `navCounts` and forwards it to `<Layout navCounts=
{props.navCounts}>`, `categories-page.tsx:9-13`).

**Real prop-name collision caught in review, resolved here:** `ChannelsPage` already has a
required `categories: Category[]` prop (`channels-page.tsx:10-13`) — the *full* category rows
(no count) that `BlankSubscribeForm`'s `<select>` needs for its option list, sourced from
`channels.tsx`'s existing `listNonSystemCategories()` query. Adding a second, differently-typed
`categories` for the sidebar under the same prop name doesn't type-check (or, worse, would
silently mean one caller overwrites the other depending on object literal key order — not
actually possible in TS/JS but exactly the kind of ambiguity worth naming explicitly rather
than leaving for an implementer to improvise). Resolved by renaming `ChannelsPage`'s existing
prop from `categories` to `subscribeCategories` (and its route call site in `channels.tsx`
accordingly); `ChannelsPage` then has two distinct, clearly-named props:
`subscribeCategories: Category[]` (unchanged data, forwarded to `BlankSubscribeForm`) and
`categories: CategoryWithCount[]` (new, forwarded to `Layout`'s sidebar).

### Sidebar category links are view-aware

The Categories section's sub-items (one per `props.categories` entry) link into whichever
of the four filterable views is current, defaulting to Queue when the current page isn't one
of them (Categories/Ignore Rules/Channels/Watching page):

```ts
const FILTERABLE_VIEWS = ["queue", "continue-watching", "watched", "ignored"] as const;
type FilterableView = (typeof FILTERABLE_VIEWS)[number];

function isFilterableView(view: SidebarView | undefined): view is FilterableView {
  return view !== undefined && (FILTERABLE_VIEWS as readonly string[]).includes(view);
}

function sidebarCategoryHref(
  currentView: SidebarView | undefined,
  currentSort: "newest" | "oldest" | undefined,
  categoryId?: number,
): string {
  const view = isFilterableView(currentView) ? currentView : "queue";
  const sort = view === "queue" ? currentSort : undefined;
  switch (view) {
    case "queue":
      return buildQueueHref(sort ?? "newest", categoryId);
    case "continue-watching":
      return buildContinueWatchingHref(categoryId);
    case "watched":
      return buildWatchedHref(categoryId);
    case "ignored":
      return buildIgnoredHref(categoryId);
  }
}
```

This is what makes "filter Watched by Podcasts and stay on Watched" keep working: clicking
"Podcasts" in the sidebar while `currentView === "watched"` calls `buildWatchedHref(podcastsId)`
→ `/watched?category=<id>`, not `/queue?category=<id>`. From any non-filterable page
(Categories/Ignore Rules/Channels) or the Watching page, the same click falls back to
`/queue?category=<id>` — there's no "current list" to stay on, so Queue (the default/most-used
view) is the sensible landing spot, matching how `resolveReturnTarget`'s existing fallback
posture (`from` missing/unrecognized → Queue) already works elsewhere in this codebase.

### Sidebar structure and reachability

The wireframe's sidebar sketch (`docs/features/002-UI_wireframe.html:45-59`) shows Queue/
Continue Watching/Watched as direct links, "Categories" as a header with category names
nested under it, "Ignored" as a link with "Ignore Rules" nested under it, and "Channels" as
a direct link — but the sketch's "Categories" header has no link of its own, only its
sub-items do. Taken literally, that would make `/categories` (the category-management page —
add/rename) unreachable through the sidebar at all, a real regression (today's flat nav links
directly to it). Resolved here: **the "Categories" and "Ignored" section headers are
themselves links** (`/categories`, `/ignored` respectively) in addition to being section
labels for their nested sub-items — the same duality, spelled out concretely:

```tsx
<nav>
  <a href={buildQueueHref(props.currentSort ?? "newest")} data-active={props.currentView === "queue"}>
    Queue ({props.navCounts.queueCount})
  </a>
  <a href="/continue-watching" data-active={props.currentView === "continue-watching"}>
    Continue Watching ({props.navCounts.continueWatchingCount})
  </a>
  <a href="/watched" data-active={props.currentView === "watched"}>
    Watched ({props.navCounts.watchedCount})
  </a>

  <a href="/categories" data-active={props.currentView === "categories"}>Categories</a>
  <ul>
    {props.categories.map((cat) => (
      <li key={cat.id}>
        <a
          href={sidebarCategoryHref(props.currentView, props.currentSort, cat.id)}
          data-active={isFilterableView(props.currentView) && props.currentCategory === cat.id}
        >
          {cat.name} ({cat.unwatchedCount})
        </a>
      </li>
    ))}
  </ul>

  <a href="/ignored" data-active={props.currentView === "ignored"}>Ignored</a>
  <ul>
    <li>
      <a href="/ignore-rules" data-active={props.currentView === "ignore-rules"}>
        Ignore Rules
      </a>
    </li>
  </ul>

  <a href="/channels" data-active={props.currentView === "channels"}>Channels</a>
</nav>
```

`data-active` is a plain boolean attribute rather than conditionally building a class string
— Tailwind v4 supports `data-[active=true]:` variants directly off an attribute, so styling
the active state is a CSS concern (`data-[active=true]:text-accent
data-[active=true]:font-semibold` or similar), not a JS string-building one. Rendering
`data-active="false"` (rather than omitting the attribute) is intentional and harmless: Hono
JSX renders boolean-valued custom `data-*` attributes as their string form, and the CSS
attribute selector `[data-active=true]` only ever matches the `"true"` string, never
`"false"` — no falsy-attribute-presence ambiguity to worry about, unlike a bare boolean HTML
attribute (e.g. `disabled`) would have.

### Mobile collapse (below `lg`, 1024px)

Below Tailwind's `lg` breakpoint, `<nav>` above is rendered inside an `<aside>` positioned
off-canvas (`-translate-x-full`, `fixed inset-y-0 left-0`) with a `transition-transform`; a
hamburger `<button aria-expanded="false" aria-controls="sidebar">` fixed to the top of the
viewport (visible only `lg:hidden`) toggles a `data-open` attribute on the `<aside>` (and its
own `aria-expanded`) via a small inline `<script>` — the same "small vanilla-JS snippet in
`layout.tsx`" pattern already established for `WATCH_LINK_CLICK_SCRIPT`
(`layout.tsx:4-14`), not a new client-side dependency:

```js
function toggleSidebar() {
  const aside = document.getElementById("sidebar");
  const btn = document.getElementById("sidebar-toggle");
  const isOpen = aside.dataset.open === "true";
  aside.dataset.open = String(!isOpen);
  btn.setAttribute("aria-expanded", String(!isOpen));
}
document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
```

A semi-transparent backdrop (`<div id="sidebar-backdrop">`, shown only while `data-open="true"`,
`lg:hidden`) sits behind the open drawer and also calls `toggleSidebar()` on click — standard
tap-outside-to-close drawer behavior. At `lg` and above, the `<aside>` is unconditionally
docked (`lg:translate-x-0 lg:static`) regardless of `data-open`, and the hamburger button/
backdrop are hidden (`lg:hidden`) — the JS toggle only has any visible effect below `lg`.

### Video-card grid (`src/views/queue-list.tsx`)

`CategoryFilterLinks` (`queue-list.tsx:82-96`) and its `buildHref` prop are deleted — the
sidebar's category sub-items replace it (see above). `QueueList`'s four-way branch on
`props.view` is unchanged structurally (still one component, still branches on `queue`/
`continue-watching` sharing one branch, `watched`, `ignored`), but each branch's row markup
changes from a `<li>` inside a `<ul>` to a card inside a responsive grid:

```tsx
<div id="queue-list" class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
  {/* ...one card per row, in place of the current <ul><li> markup... */}
</div>
```

`auto-fill`/`minmax(240px, 1fr)` is the "responsive auto-fill" grid resolved during scoping —
the browser fits as many ~240px-minimum cards as the viewport allows, so 1920px-wide desktop
usage naturally shows more cards at once than a narrower window, with no manual breakpoint
tuning. `#queue-list` — the existing `hx-target`/`hx-swap="outerHTML"` id every mutating
action (`toggleHref`, `ignoreHref`, `unignoreHref`) already targets — **must stay the exact
same id on the exact same wrapping element**; only its class list changes from list-styling
to grid-styling. This is a hard constraint, not a style preference: HTMX's targeting is
id-based, and re-parenting or renaming this element breaks every existing mutating action's
swap silently (no error, just a stale/unswapped page) rather than loudly.

For Queue/Continue Watching cards, the entire thumbnail+title area becomes the click target
(not just the title text, as today) — a card-UI convention, and a strictly larger `.watch-link`
click target than today's title-only anchor, so the existing `handleWatchLinkClick`
delegation logic in `layout.tsx` (event delegation on `document`, matching
`e.target.closest(".watch-link")`) needs no change; it already finds the anchor regardless of
which descendant element was actually clicked. The action buttons (Mark Watched/Clear to
Unwatched, Ignore) stay siblings *outside* that anchor, not nested inside it — nesting a
`<button>` inside an `<a>` is invalid HTML and would make every button click also trigger the
card's own click-to-watch behavior:

```tsx
<div class="card"> {/* one video's card */}
  <a
    href={watchingHref(row.id, props.view, sort, props.category)}
    class="watch-link block"
    data-youtube-url={youtubeWatchUrl(row.youtubeVideoId)}
  >
    <img
      src={youtubeThumbnailUrl(row.youtubeVideoId)}
      alt={row.title}
      loading="lazy"
      onerror="this.style.visibility='hidden'"
      class="aspect-video w-full object-cover"
    />
    <p class="title">{row.title}</p>
    <p class="meta text-text-muted">
      {row.channelName} · {row.categoryName}
      {row.publishedAt ? ` · ${formatRelativeTime(row.publishedAt)}` : ""}
    </p>
  </a>
  {row.status === "watching" ? <span class="badge text-accent">▶ Watching</span> : null}
  <div class="actions">
    <button hx-post={toggleHref(...)} ...>{/* Mark Watched / Clear to Unwatched */}</button>
    <button hx-post={ignoreHref(...)} ...>Ignore</button>
  </div>
</div>
```

**`data-youtube-url` is not optional decoration — it's load-bearing.** The existing
`handleWatchLinkClick` delegation script (`layout.tsx:4-14`, unchanged by this spec) reads
`link.dataset.youtubeUrl` and calls `window.open(...)` on it; today's title-only anchor
already carries this attribute (`queue-list.tsx:124,163`, via the soon-to-be-replaced local
`youtubeUrl()`). Dropping it from the new card anchor — an easy mistake once the anchor's
child content grows from one text node to a thumbnail + title + metadata block — would make
every card silently open a blank tab instead of the YouTube video, with no test or type error
catching it (nothing in Testing currently asserts on this attribute's presence — see the new
Testing bullet added below).

Watched cards drop the action buttons entirely (click-through only, unchanged from spec004)
and show `watched {formatRelativeTime(row.watchedAt)}` instead of `published`. Ignored cards
keep their existing "not a `.watch-link`, plain non-clickable title" design (spec007) — the
thumbnail is a bare `<img>` with no wrapping anchor, the `[manual]`/`[auto]` tag becomes a
small pill (`class="badge"`) instead of bracketed text, and the Un-ignore button is the only
action.

### Empty states

Each of the four video-list views and the three CRUD list views renders a short message in
place of the grid/list when its row array is empty — new, small, reusable per-view copy
(e.g. Queue: "Nothing in your queue — your subscriptions are all caught up." / Ignored:
"Nothing ignored." / Categories: "No categories yet — add one below."), not a shared generic
string, since "what's empty" differs enough per view to be worth one line of specific copy
each. No new data/query — this is purely `rows.length === 0 ? <EmptyState message="..." /> :
<the existing grid/list>`.

### CRUD list/table treatment (Categories, Ignore Rules, Channels/Subscribe)

`categories-list.tsx`, `ignore-rules-list.tsx`, and `subscription-list.tsx` keep their exact
existing interaction pattern (inline Edit-toggles-a-form-in-place-of-the-row, an Add form
pinned at the bottom, HTMX `outerHTML`-swapping the same `#category-list`/
`#ignore-rules-list`/`#subscription-list` ids they already target) — this spec only replaces
each `<ul>`/`<li>` row's Tailwind classes with a styled list treatment (a bordered/divided
row list on the `bg-surface` token, e.g. `divide-y divide-border`, `hover:bg-surface-raised`
per row) distinct from the video-card grid, per the "CRUD pages get a distinct list/table
treatment" decision the feature file already resolved. Inputs, buttons, and the
`text-danger`-styled error paragraphs (replacing today's `text-red-600`) get consistent
Tailwind treatment across all three forms (`add category`, `add ignore rule`, subscribe
form's channel-input + category `<select>`) rather than each remaining fully unstyled.
`subscribe-confirm.tsx`'s three components (`BlankSubscribeForm`, `ConfirmPanel`,
`ConfirmError`) get the same treatment, still swapping the same `#confirm-panel` id.

### Watching page (`src/views/watching-page.tsx`)

Restyled to match the same tokens as every other page — thumbnail becomes a bounded,
`aspect-video`/`object-cover` box instead of an unconstrained full-width `<img>`; the status
badge (`WatchStatusBadge`) becomes a colored pill (`bg-accent`/`text-bg` when `watching`, a
neutral `bg-surface-raised` otherwise) instead of plain text; "Mark Watching," "Mark
Watched/Unwatched & Return," and "Return to X" become styled buttons/link consistent with
the rest of the app. `youtubeThumbnailUrl` now comes from `src/lib/youtube.ts` (see Shared
libs above) instead of a locally-declared copy. No behavioral change — the existing
`hx-trigger="load delay:10s"` auto-timer, `hx-swap-oob` badge update, bfcache `pageshow`
reload script, and double-submit guard are all unchanged.

Purely-visual as this subsection is, `WatchingPageProps` still isn't untouched: like
`CategoriesPage`/`ChannelsPage`/`IgnoreRulesPage`, it's one of the four wrapper components
covered by Design → *Sidebar*'s wrapper-component table, and gains the same
`categories: CategoryWithCount[]` prop plus a literal `currentView: undefined` — see that
section (not repeated here) for the full requirement; `GET /watching/:id`
(`queue.tsx:381-406`) passes both through to its `<WatchingPage>` call alongside its
existing props.

## Testing

Given the scale of markup change, this section splits explicitly into what needs
**updating** (existing tests coupled to markup this spec restructures) vs. what needs
**adding** (new logic this spec introduces) vs. what needs **no change** (tests asserting
behavior, not markup).

**No change needed** (behavioral assertions, not markup-coupled): every status-transition
test in `test/lib/watch-status.test.ts`, `test/lib/ignore-rules.test.ts`; every redirect/404/
DB-state assertion across `test/routes/*.test.ts` that doesn't parse specific rendered HTML
structure (e.g. "returns only unwatched/watching videos," "toggling a row removes it from
the re-rendered list," "a 303 redirects to the resolved return target").

**Needs updating** (markup-coupled, will break against the new structure otherwise):
- Every test in `test/routes/queue.test.ts` that asserts `CategoryFilterLinks`-shaped output
  (spec006's "Category picker rendering" bullet, "each category link preserves the current
  sort value," etc.) — `CategoryFilterLinks` no longer exists; these become assertions
  against the sidebar's rendered category sub-item links instead (same underlying behavior —
  a link per category including Uncategorized, `sort`/`category` composing correctly — just
  reading it out of the new markup location).
- Any test asserting the old flat `<nav>`'s exact link text/structure
  (`src/views/layout.tsx`'s previous `Categories | Channels | Queue (n) | ...` shape) against
  the new sidebar structure.
- Any "end-to-end row-link round trip" test (spec006/007's pattern of parsing a real
  `hx-post`/`href` out of the rendered response rather than hand-constructing it) keeps its
  *approach* unchanged but re-parses from the new card markup instead of the old `<li>` markup.

**New tests needed:**
- `test/lib/relative-time.test.ts`: each of the six branches (just now, `Nm`, `Nh`, `Nd`,
  `Nw`, absolute-date fallback past 4 weeks, including the same-year-omits-year case and the
  cross-year-includes-year case) plus the negative-diff clamp (a future `date` relative to
  `now` returns "just now," not a negative duration).
- `test/lib/categories.test.ts` (or extending existing categories test coverage):
  `listCategoriesWithCounts` returns the same shape/values `categories.tsx`'s current
  `listCategories` + `categoryUnwatchedCount` combination already covers — a straight
  move, asserted to make sure the move didn't change behavior.
- Sidebar rendering, per route: `currentView`'s matching top-level link carries
  `data-active="true"` and every other top-level link carries `data-active="false"`; on a
  filtered `/watched?category=<id>`, that category's sidebar sub-item carries
  `data-active="true"` and `/categories`'s own link (a different, non-filterable view) does
  not; a sidebar category link clicked from `/ignored?category=<id>` points at
  `/ignored?category=<other-id>` (view-aware, not hardcoded to `/queue`) — this is the direct
  regression test for the Context section's identified risk.
- Empty-state rendering: each of the seven list/grid views (four video-list, three CRUD)
  renders its empty-state message when given zero rows, and does **not** render it when given
  at least one row.
- Thumbnail `src` correctness: each of Queue/Continue Watching/Watched/Ignored's cards
  renders an `<img>` whose `src` matches `youtubeThumbnailUrl(row.youtubeVideoId)` for that
  row.
- `data-youtube-url` presence: each of Queue/Continue Watching/Watched's card anchors
  (the ones wrapping a `.watch-link`, i.e. not Ignored's plain non-clickable cards) carries
  `data-youtube-url` matching `youtubeWatchUrl(row.youtubeVideoId)` — the direct regression
  test for the missing-attribute bug this spec's own red-team review caught (see Design →
  *Video-card grid*'s callout); without it, `handleWatchLinkClick`'s existing
  `window.open(link.dataset.youtubeUrl, "_blank")` silently opens a blank tab instead of the
  video, with nothing else in this test suite positioned to catch that regression.

## Verification

Per CLAUDE.md's split: **Claude performs directly** via `curl` from inside the devcontainer
(server-rendered HTML/status codes) or a direct SQLite read; **user performs live in a
browser** for anything `curl` can't observe (real HTMX partial-swap behavior, the mobile
drawer's open/close animation, visual layout/contrast at both viewport sizes).

**Claude performs directly:**
1. `bun test`, `bun run lint`, and `bunx tsc --noEmit` all clean.
2. `curl` each of `/queue`, `/continue-watching`, `/watched`, `/ignored`, `/categories`,
   `/channels`, `/ignore-rules`, and `/watching/:id` (a seeded video id) — confirm each
   response contains the sidebar markup with the expected `data-active="true"` on exactly
   the one matching link (or none, for `/watching/:id`), the expected `navCounts` numbers,
   and no leftover reference to the deleted `CategoryFilterLinks`/old flat-`<nav>` markup.
3. `curl "/queue?category=<id>"` and confirm the sidebar's matching category sub-item
   carries `data-active="true"`; repeat for `/watched?category=<id>` and confirm clicking
   through to that same category's sidebar link (parsed from the response, per the new
   end-to-end test pattern) points at `/watched?category=<id>`, not `/queue?category=<id>`.
4. `curl` a view with zero matching rows (e.g. filter to a category with nothing in it) and
   confirm the empty-state message appears, with no grid/list markup left dangling.
5. Confirm via direct DB read that no data changed — this spec touches only rendering and
   read-only query shapes, so every table's row count/contents before and after should be
   identical.

**User performs live in a browser:**
1. Open `/queue` at a desktop width (~1920×1080) — confirm the sidebar is persistently
   docked (not collapsed), the video grid shows more than 3 columns of cards if enough
   videos exist, thumbnails load, and the dark theme reads correctly (no leftover
   light-background flash, sufficient contrast on text/buttons).
2. Resize the browser below ~1024px width (or use a mobile device/responsive dev tools) —
   confirm the sidebar disappears behind a hamburger toggle, tapping it slides the drawer in
   with a backdrop, tapping the backdrop (or the toggle again) closes it, and the video grid
   reflows to fewer columns without any horizontal scrollbar.
3. Click a category in the sidebar while on `/watched` — confirm it filters Watched (stays
   on Watched, doesn't jump to Queue) and the sidebar highlights that category.
4. Click a video's card anywhere on the thumbnail or title (not just the old title-only
   click target) — confirm it opens YouTube in a new tab and navigates the current tab to
   `/watching/:id`, exactly as before.
5. On `/queue`, use the Mark Watched/Ignore buttons on a card — confirm the HTMX partial
   swap still works (no full page reload, the card grid re-renders in place) and the
   sidebar's nav counts are still only as fresh as spec009's existing accepted staleness
   tradeoff (they don't live-update from a partial swap, matching current behavior,
   unchanged by this spec).
6. Visit `/categories`, `/ignore-rules`, and `/channels` — confirm the add/edit/delete flows
   still work exactly as before (inline edit-to-form swap, add form, delete), now with the
   restyled list treatment, distinct from the video card grid.
7. Force a thumbnail load failure (e.g. throttle/block `i.ytimg.com` in dev tools) — confirm
   the broken image is hidden rather than showing a broken-image icon, and the card's layout
   doesn't visibly collapse/shift.

## Open Questions

None outstanding at spec-draft time. Two real design gaps were caught and resolved while
writing this spec (see Design/Context above for the full reasoning), not left open:
- The feature file's "sidebar replaces the in-page category filter row" decision, taken
  literally, would have regressed the existing per-page (Watched/Continue Watching/Ignored)
  category-filtering capability down to Queue-only. Resolved by making the sidebar's
  category links view-aware (`sidebarCategoryHref`).
- The wireframe's sidebar sketch has no direct link for `/categories` or `/ignore-rules`
  management pages, only for their nested sub-items. Resolved by making the "Categories" and
  "Ignored" section headers themselves links, in addition to being section labels.

**Red-team retrospective:** One independent pass (subagent, no memory of the drafting
conversation, checked every concrete claim — line citations, sketched code, prop-threading
completeness, deletion completeness — against the actual current source and installed
Hono/Tailwind versions) found three real issues, all fixed directly above rather than left
as risk:
- The card markup sketch dropped `data-youtube-url` — the attribute
  `handleWatchLinkClick`'s existing, unchanged click-to-open-YouTube script actually reads.
  As drafted, every card would have silently opened a blank tab instead of the video, with
  no test or type error catching it. Fixed by adding the attribute back to the card's anchor
  (Design → *Video-card grid*) and adding a direct regression test for its presence
  (Testing).
- `CategoryWithCount` was narrowed to just the fields the sidebar reads
  (`id`/`name`/`isSystem`/`unwatchedCount`), but `categories-list.tsx`'s existing `Category`
  type (which `CategoriesList`/`CategoriesPage` are typed against) also includes
  `createdAt`. Feeding the narrowed shape into `listCategoriesWithCounts`'s 14
  `categories.tsx` call sites would have been a `tsc --noEmit` missing-property error, not
  just a style inconsistency — the same failure category CLAUDE.md already documents as
  having bitten this project once before. Fixed by making the shared type the same
  full-row-plus-count shape `categories-list.tsx` already used, and having that file import
  it instead of keeping its own local declaration (Design → *Shared libs*).
- `ChannelsPage`'s existing required `categories: Category[]` prop (full rows, for the
  subscribe form's `<select>`) collides in name with the new sidebar `categories:
  CategoryWithCount[]` prop every `Layout`-rendering wrapper needs. Fixed by renaming the
  existing prop to `subscribeCategories` (Design → *Sidebar*).

The same pass also caught two lower-severity gaps, both fixed: an imprecise claim that
`ignoredVideos()` "already joins" `youtubeVideoId` (it's on the query's own base `.from(videos)`
table, not a join — wording only, no design change) and a miscitation attributing
`text-red-600` to `layout.tsx:30` (that line has `bg-gray-50 text-gray-900`, a different
pair of old-default classes this spec also replaces — both are now cited accurately). It
also flagged that the Design section's eight-call-site table reads as if all eight render
`<Layout>` directly, when four actually go through wrapper `*Page` components
(`CategoriesPage`/`ChannelsPage`/`IgnoreRulesPage`/`WatchingPage`) that each need their own
prop-type change — fixed by adding an explicit subsection naming all four files and the
two-hop prop-forwarding shape (Design → *Sidebar*).

Everything else the first pass checked — every other `file:NN` line citation, the
`formatRelativeTime`/`sidebarCategoryHref`/`isFilterableView` logic, `CategoryFilterLinks`/
`allCategories` deletion completeness (grepped whole-repo, exactly matching this spec's
accounting), the `data-active` boolean-attribute-to-string Hono JSX rendering claim (verified
directly against the installed `hono` package's source), Tailwind v4's `@theme` mechanics,
and the Testing section's "no change needed" vs. "needs updating" characterization (spot-checked
against the actual current `test/routes/queue.test.ts` assertions) — came back clean.

Because the first pass found three real, high-severity issues, a second independent pass was
run (not skipped in favor of self-review — anchoring on one's own just-written fixes is
exactly what an independent pass exists to counteract, per this skill's stopping rule: "run a
second if the first pass finds anything substantive"). The second pass, with no memory of the
first pass's drafting or fixes, cross-checked all three fixes directly against the current
source (`data-youtube-url`'s attribute-name/DOM-mapping correctness against
`handleWatchLinkClick`; grepped the whole repo, including `test/`, for any remaining consumer
of the old narrow `CategoryWithCount` shape or `ChannelsPage`'s old `categories` prop name)
and confirmed all three correct and complete, with zero hidden breakage in tests or other call
sites. It found one low-severity documentation-locality gap, now fixed: the "Watching page"
Design subsection didn't cross-reference that `WatchingPageProps` is also covered by the
Sidebar section's wrapper-component prop requirement, readable as self-contained ("no
behavioral change") in a way that could mislead an implementer reading only that subsection.
Fixed by adding an explicit cross-reference there.

A second pass finding nothing beyond one minor doc nit — no new bugs, no incomplete fixes —
is the stopping signal this skill's process is built around. No third pass was run.
