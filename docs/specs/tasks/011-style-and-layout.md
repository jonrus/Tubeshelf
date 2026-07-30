# Tasks: Style and Layout Foundation
Spec: docs/specs/011-style-and-layout.md
Generated: 2026-07-30

- [x] 1. Shared libs: YouTube URL builders + relative-time formatting, per the spec's
  "Shared libs" section. No consumers wired yet — this task only creates the two new files
  and their tests, isolated from anything that currently duplicates this logic.
  - Create `src/lib/youtube.ts` exporting `youtubeWatchUrl(youtubeVideoId: string): string`
    (returns `https://www.youtube.com/watch?v=${youtubeVideoId}`) and
    `youtubeThumbnailUrl(youtubeVideoId: string): string` (returns
    `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`).
  - Create `src/lib/relative-time.ts` exporting `formatRelativeTime(date: Date, now: Date =
    new Date()): string`, exactly as sketched in the spec's "`src/lib/relative-time.ts`
    (new)" section (branches: `diffMs <= 0` or `< MINUTE` → `"just now"`; `< HOUR` →
    `"{n}m"`; `< DAY` → `"{n}h"`; `< WEEK` → `"{n}d"`; `< 4 * WEEK` → `"{n}w"`; else an
    absolute `date.toLocaleDateString(...)` with `month: "short", day: "numeric"` and `year`
    included only when `date`'s year differs from `now`'s).
  - Add `test/lib/relative-time.test.ts` covering all six branches (just-now, `Nm`, `Nh`,
    `Nd`, `Nw`, absolute-date fallback with both the same-year-omits-year case and the
    cross-year-includes-year case) plus the negative-diff clamp (a `date` after `now` returns
    `"just now"`, not a negative duration).
  - Add `test/lib/youtube.test.ts` covering both functions' exact output strings for a sample
    video id.
  - Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun test test/lib/relative-time.test.ts
    test/lib/youtube.test.ts` all pass. (No other file imports either new module yet — that's
    expected and doesn't affect this task's own compile/test status.)

- [x] 2. Design tokens, per the spec's "Design tokens" section.
  - Replace `src/styles/input.css`'s content with the `@theme` block exactly as specified:
    `@import "tailwindcss";` followed by a `@theme { ... }` block defining `--color-bg:
    #020617`, `--color-surface: #0f172a`, `--color-surface-raised: #1e293b`,
    `--color-border: #334155`, `--color-text: #f1f5f9`, `--color-text-muted: #94a3b8`,
    `--color-accent: #2dd4bf`, `--color-accent-strong: #14b8a6`, `--color-danger: #f87171`.
  - Run `bun run css:build` to regenerate `public/css/tailwind.css`.
  - No view/route files are touched in this task — every consumer of these new
    `bg-*`/`text-*`/`border-*` utility classes (`bg-bg`, `text-text`, `text-danger`, etc.) is
    wired up in later tasks.
  - Done when: `bun run css:build` exits 0, and `public/css/tailwind.css` contains the new
    custom properties/utilities (e.g. `grep -c "color-accent\|color-danger\|color-surface"
    public/css/tailwind.css` returns a non-zero count).

- [x] 3. `src/lib/categories.ts`, per the spec's "`src/lib/categories.ts` (new)" section and
  its "Real type mismatch caught in review" fix. This migrates `categories.tsx`'s existing
  category-listing logic to a shared location without changing its behavior — the Categories
  page's own rendered output is unchanged by this task.
  - Create `src/lib/categories.ts` exporting `CategoryWithCount = typeof categories.$inferSelect
    & { unwatchedCount: number }` (the **same full-row-plus-count shape**
    `categories-list.tsx`'s current local `Category` type already is — do not narrow it to
    just `{id, name, isSystem, unwatchedCount}`) and `listCategoriesWithCounts(userId:
    number): CategoryWithCount[]`, moved verbatim from `src/routes/categories.tsx`'s current
    `listCategories(userId)` + `categoryUnwatchedCount(userId, categoryId)` (lines 15-45 of
    that file today).
  - `src/routes/categories.tsx`: delete the local `categoryUnwatchedCount`/`listCategories`
    functions; import `listCategoriesWithCounts` from `../lib/categories` instead; update all
    14 call sites (`GET /categories`'s 1, `POST /categories`'s 5, `GET /categories/:id/edit`'s
    2, `POST /categories/:id`'s 6 — already enumerated in full in spec009's Design section)
    from `listCategories(user.id)` to `listCategoriesWithCounts(user.id)`.
  - `src/views/categories-list.tsx`: delete the local `export type Category = typeof
    categories.$inferSelect & { unwatchedCount: number }` declaration and its now-unused
    `import type { categories } from "../db/schema"`; import `type { CategoryWithCount } from
    "../lib/categories"` instead and use it everywhere `Category` was used (the `categories`
    prop's type, etc.).
  - `src/views/categories-page.tsx`: replace `import { type Category, CategoriesList } from
    "./categories-list"` with `import { CategoriesList } from "./categories-list"; import
    type { CategoryWithCount } from "../lib/categories"`, and retype `CategoriesPage`'s
    `categories` prop as `CategoryWithCount[]`.
  - Add `test/lib/categories.test.ts`: seed a category with at least one active subscription
    carrying an `unwatched` and a `watching` video, call `listCategoriesWithCounts(userId)`,
    and assert the returned array includes that category with the correct `unwatchedCount`
    and the system Uncategorized category ordered first (`isSystem desc, name asc`).
  - Done when: `bunx tsc --noEmit` passes, `bun run lint` passes, `bun test` passes
    (including the existing `test/routes/categories.test.ts` suite unchanged — this task must
    not alter `GET /categories`'s rendered output, only where its data comes from).

- [x] 4. `src/lib/queue-urls.ts`, per the spec's "`src/lib/queue-urls.ts` (new)" section. A
  pure relocation — `CategoryFilterLinks` and its four render call sites in `queue.tsx` still
  exist after this task and still work identically; only the four helper functions' file
  location changes.
  - Create `src/lib/queue-urls.ts` exporting `buildQueueHref(sort: "newest" | "oldest",
    category?: number): string`, `buildContinueWatchingHref(category?: number): string`,
    `buildWatchedHref(category?: number): string`, and `buildIgnoredHref(category?: number):
    string`, moved verbatim from `src/routes/queue.tsx`'s current private functions (today at
    lines 268-274 and 303-322).
  - `src/routes/queue.tsx`: delete the four local declarations; import all four from
    `../lib/queue-urls` instead. Every existing call site (`GET /queue`'s sort-toggle links
    and `CategoryFilterLinks`'s `buildHref` prop on all four GET handlers) is unchanged
    otherwise.
  - Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun test test/routes/queue.test.ts`
    all pass with no behavioral change (existing category-picker/sort-toggle assertions in
    that file still pass unmodified).

- [x] 5. Sidebar: `layout.tsx` rewrite + wire all 8 `<Layout>`-rendering call sites + delete
  `CategoryFilterLinks`/`allCategories`, per the spec's "Sidebar", "Sidebar category links are
  view-aware", "Sidebar structure and reachability", and "Mobile collapse" sections. This is
  the largest task — `Layout`'s new props are required, so every caller must be updated in
  the same task or the repo won't compile; do not split this across sessions.
  - `src/views/layout.tsx`:
    - Add `export type SidebarView = "queue" | "continue-watching" | "watched" | "ignored" |
      "categories" | "ignore-rules" | "channels";`.
    - Import `type { CategoryWithCount } from "../lib/categories"` and `{
      buildQueueHref, buildContinueWatchingHref, buildWatchedHref, buildIgnoredHref } from
      "../lib/queue-urls"`.
    - `Layout`'s props grow to `{ title, navCounts, categories: CategoryWithCount[],
      currentView?: SidebarView, currentCategory?: number, currentSort?: "newest" |
      "oldest", children? }`, exactly as sketched in the spec.
    - Add the `FILTERABLE_VIEWS`/`isFilterableView`/`sidebarCategoryHref` helpers exactly as
      sketched in "Sidebar category links are view-aware".
    - Replace the current flat `<nav>` (today's `Categories | Channels | Queue (n) | ...`)
      with the sidebar structure from "Sidebar structure and reachability": Queue/Continue
      Watching/Watched as direct links with `data-active`; a "Categories" link+section with
      one sub-item per `props.categories` entry via `sidebarCategoryHref`; an "Ignored"
      link+section with a nested "Ignore Rules" sub-item; a "Channels" link. Every link
      carries `data-active={...}` per the spec's exact conditions (top-level:
      `props.currentView === "<this-view>"`; category sub-item:
      `isFilterableView(props.currentView) && props.currentCategory === cat.id`).
    - Wrap the nav in an `<aside id="sidebar" data-open="false">` with the off-canvas/
      docked-at-`lg` CSS classes described in "Mobile collapse"; add the `<button
      id="sidebar-toggle" aria-expanded="false" aria-controls="sidebar">` (visible only
      below `lg`) and `<div id="sidebar-backdrop">`; add the `toggleSidebar()` inline
      `<script>` exactly as sketched, following the same pattern as the existing
      `WATCH_LINK_CLICK_SCRIPT` block.
    - Update `<body>`'s classes from `bg-gray-50 text-gray-900` to `bg-bg text-text`.
  - `src/routes/queue.tsx`:
    - Import `listCategoriesWithCounts` from `../lib/categories`.
    - In each of the four video-list `GET` handlers (`/queue`, `/continue-watching`,
      `/watched`, `/ignored`), delete the `<CategoryFilterLinks .../>` render call and add
      `categories={listCategoriesWithCounts(user.id)}`, `currentView="queue"` (respectively
      `"continue-watching"`/`"watched"`/`"ignored"`), `currentCategory={category}`, and (on
      `/queue` only) `currentSort={sort}` to the existing `<Layout>` call.
    - Delete the local `allCategories()` function (no longer called anywhere once
      `CategoryFilterLinks`'s four render sites above are gone).
    - `GET /watching/:id`: add `categories={listCategoriesWithCounts(user.id)}` and
      `currentView={undefined}` to the `<WatchingPage>` call.
  - `src/views/queue-list.tsx`: delete the `CategoryFilterLinks` component and its export
    (its `buildHref`/`categories`/`current` props are no longer referenced anywhere).
  - `src/views/watching-page.tsx`: `WatchingPageProps` gains `categories: CategoryWithCount[]`
    (import the type from `../lib/categories`) and `currentView?: SidebarView` (import from
    `./layout`); forward both to the internal `<Layout categories={props.categories}
    currentView={props.currentView} ...>`.
  - `src/views/categories-page.tsx`: `CategoriesPage`'s props gain `currentView:
    "categories"` — typed as that exact string-literal type (not the broader `SidebarView`
    union, and not plain `string`, which wouldn't satisfy `Layout`'s `currentView?:
    SidebarView` prop) — since this component only ever renders for `GET /categories`;
    forward `props.categories` (its existing prop, unchanged shape) and `currentView` to
    `<Layout>`. `ChannelsPage`'s new `currentView: "channels"` and `IgnoreRulesPage`'s new
    `currentView: "ignore-rules"` props (below) follow the identical single-literal-type
    pattern.
  - `src/routes/categories.tsx`: `GET /categories` adds `currentView="categories"` to its
    existing `<CategoriesPage categories={listCategoriesWithCounts(user.id)} .../>` call —
    the same already-computed `categories` value now serves both `CategoriesList`'s rows and
    `Layout`'s sidebar, no second query needed.
  - `src/views/channels-page.tsx`: rename `ChannelsPage`'s existing `categories: Category[]`
    prop to `subscribeCategories: Category[]` (its forwarding to `<BlankSubscribeForm
    categories={props.subscribeCategories} />` updates accordingly); add a new `categories:
    CategoryWithCount[]` prop (import the type from `../lib/categories`) and `currentView:
    "channels"` prop, both forwarded to `<Layout>`.
  - `src/routes/channels.tsx`: import `listCategoriesWithCounts` from `../lib/categories`;
    `GET /channels`'s `<ChannelsPage categories={listNonSystemCategories()} .../>` becomes
    `<ChannelsPage subscribeCategories={listNonSystemCategories()}
    categories={listCategoriesWithCounts(user.id)} currentView="channels" .../>`.
  - `src/views/ignore-rules-page.tsx`: `IgnoreRulesPage` gains `categories:
    CategoryWithCount[]` and `currentView: "ignore-rules"` props, forwarded to `<Layout>`.
  - `src/routes/ignore-rules.tsx`: import `listCategoriesWithCounts` from
    `../lib/categories`; `GET /ignore-rules` adds `categories={listCategoriesWithCounts(user.id)}`
    and `currentView="ignore-rules"` to its `<IgnoreRulesPage>` call.
  - Update `test/routes/queue.test.ts`: replace the existing `CategoryFilterLinks`-shaped
    assertions (the "Category picker rendering" coverage, roughly around the response-body
    `>All</a>`/per-category-link/`&category=` checks) with assertions against the new sidebar
    markup instead — same underlying behavior (a link per category including Uncategorized,
    `sort`/`category` composing correctly), just read out of the sidebar's rendered HTML.
    Add: (a) for each of `/queue`, `/continue-watching`, `/watched`, `/ignored`,
    `/categories`, `/channels`, `/ignore-rules`, the matching top-level sidebar link carries
    `data-active="true"` and every other top-level link carries `data-active="false"`; (b) on
    `GET /watched?category=<id>`, that category's sidebar sub-item carries `data-active="true"`
    while `/categories`'s own link does not; (c) **the view-aware regression test**: parse a
    category sidebar link's `href` out of a `GET /ignored?category=<id>` response and assert
    it points at `/ignored?category=<other-id>` (not `/queue?category=<other-id>`) — this is
    the direct test for the Context section's identified risk.
  - Done when: `bunx tsc --noEmit` passes (proves no call site was missed, since every new
    `Layout`/wrapper-component prop is required), `bun run lint` passes, and `bun test` passes
    including all new/updated assertions above.

- [x] 6. Video-card grid, per the spec's "Video-card grid" and "Empty states" sections
  (video-list portion). Depends on tasks 1 (youtube.ts/relative-time.ts) and 5 (Layout no
  longer imports `CategoryFilterLinks` from this file).
  - `src/routes/queue.tsx`: add `youtubeVideoId: videos.youtubeVideoId` to `ignoredVideos()`'s
    `.select({...})` object (already available off that query's `.from(videos)` base table).
  - `src/views/queue-list.tsx`:
    - Delete the local `youtubeUrl` function; import `youtubeWatchUrl`,
      `youtubeThumbnailUrl` from `../lib/youtube`; import `formatRelativeTime` from
      `../lib/relative-time`.
    - `IgnoredRow` gains `youtubeVideoId: string`.
    - Change `#queue-list`'s wrapper element's class to the responsive grid (`grid gap-4
      [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]`) — **keep the exact same
      `id="queue-list"` on the exact same wrapping element**; every existing `hx-target`
      (`toggleHref`, `ignoreHref`, `unignoreHref`) depends on it unchanged.
    - Rewrite each of the four `props.view` branches' row markup as a card, per the spec's
      sketch: queue/continue-watching cards get a `.watch-link` anchor wrapping the thumbnail
      `<img>` (with `alt`, `loading="lazy"`, `onerror="this.style.visibility='hidden'"`,
      `class="aspect-video w-full object-cover"`), title, and metadata line (channel ·
      category · `formatRelativeTime(row.publishedAt)` when non-null) — **the anchor must
      carry `data-youtube-url={youtubeWatchUrl(row.youtubeVideoId)}`, not just `href`** (this
      is the attribute this spec's own red-team review caught missing — do not drop it); a
      "▶ Watching" badge when `row.status === "watching"`; the Mark Watched/Clear-to-Unwatched
      and Ignore buttons as siblings *outside* the anchor, not nested inside it. Watched cards
      drop the action buttons and show `watched {formatRelativeTime(row.watchedAt)}` in place
      of `published`. Ignored cards keep their non-clickable design (plain `<img>` with no
      wrapping anchor, plain title text, `[manual]`/`[auto]` as a small pill instead of
      bracketed text, Un-ignore as the only action).
    - Add a small `EmptyState` component (or equivalent) and wire it into all four `props.view`
      branches: when `props.rows.length === 0`, render a short per-view message ("Nothing in
      your queue — your subscriptions are all caught up." / a Continue-Watching-specific
      message / a Watched-specific message / "Nothing ignored.") in place of the grid.
  - Add tests to `test/routes/queue.test.ts`: (a) each of Queue/Continue Watching/Watched's
    cards renders `data-youtube-url` matching `youtubeWatchUrl(row.youtubeVideoId)` — the
    direct regression test for the bug this spec's review caught; (b) each of Queue/Continue
    Watching/Watched/Ignored's cards renders a thumbnail `<img>` whose `src` matches
    `youtubeThumbnailUrl(row.youtubeVideoId)`; (c) each of the four views renders its
    empty-state message when seeded with zero matching rows, and does not render it when at
    least one row exists.
  - Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun test` all pass, including the new
    assertions above and the existing (now-updated, per task 5) queue.test.ts suite.

- [ ] 7. CRUD list/table treatment + empty states, per the spec's "CRUD list/table treatment"
  section and the empty-state portion covering Categories/Ignore Rules/Channels. Depends on
  task 2 (design tokens must exist to reference `bg-surface`/`divide-border`/`text-danger`
  etc.). Independent of tasks 5/6 otherwise.
  - `src/views/categories-list.tsx`, `src/views/ignore-rules-list.tsx`,
    `src/views/subscription-list.tsx`: restyle each `<ul>`/`<li>` row list with a bordered/
    divided-row treatment on the `bg-surface` token (e.g. `divide-y divide-border`,
    `hover:bg-surface-raised` per row) — **the interaction pattern is unchanged**: keep the
    exact same `#category-list`/`#ignore-rules-list`/`#subscription-list` ids each file's
    HTMX `hx-target`s already depend on, the same inline Edit-toggles-a-form pattern, the
    same Add-form-pinned-at-the-bottom. Replace each file's `text-red-600` error paragraph
    with `text-danger`. Style the add/edit `<input>`/`<button>` elements consistently across
    all three files.
  - `src/views/subscribe-confirm.tsx`: apply the same input/button/error styling to
    `BlankSubscribeForm`, `ConfirmPanel`, and `ConfirmError` (its `text-red-600` →
    `text-danger`), keeping the same `#confirm-panel` id all three swap into.
  - Add empty-state messaging to `categories-list.tsx` ("No categories yet — add one
    below."), `ignore-rules-list.tsx`, and `subscription-list.tsx` — same `rows.length === 0`
    pattern as task 6's video views, reusing the same `EmptyState` component if one was
    created there.
  - Add tests: `test/routes/categories.test.ts`, `test/routes/ignore-rules.test.ts`,
    `test/routes/channels.test.ts` each get one new assertion that the empty-state message
    renders when seeded with zero categories/rules/subscriptions respectively, and does not
    render otherwise.
  - Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun test` all pass, including the
    three new empty-state assertions and every existing test in these three route test files
    (interaction behavior — add/edit/delete — must be unaffected).

- [ ] 8. Watching page restyle, per the spec's "Watching page" section. Depends on task 1
  (`youtube.ts`) and task 2 (design tokens). No behavioral change — purely visual.
  - `src/views/watching-page.tsx`: delete the local `thumbnailUrl` function; import
    `youtubeThumbnailUrl` from `../lib/youtube`. Restyle the thumbnail `<img>` as a bounded
    `aspect-video`/`object-cover` box (replacing the current unconstrained full-width image);
    restyle `WatchStatusBadge` as a colored pill (`bg-accent`/`text-bg` when `watching`, a
    neutral `bg-surface-raised` otherwise, instead of plain text); restyle the "Mark
    Watching," "Mark Watched/Unwatched & Return," and "Return to X" elements as buttons/link
    consistent with the rest of the app's new token-based styling. Do not touch the existing
    `hx-trigger="load delay:10s"` auto-timer, `hx-swap-oob` badge update, bfcache `pageshow`
    reload script, or double-submit guard.
  - Done when: `bunx tsc --noEmit`, `bun run lint`, and `bun test` all pass with every
    existing Watching-page test (auto-timer presence, badge label, return-navigation,
    double-submit guard) unaffected.

- [ ] 9. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo, then `bun run css:build` once more to confirm the final generated
  stylesheet reflects every class used across all touched views. Then do manual end-to-end
  verification, split per CLAUDE.md's convention:
  - **Claude performs directly** (via `curl` inside the devcontainer): for each of `/queue`,
    `/continue-watching`, `/watched`, `/ignored`, `/categories`, `/channels`,
    `/ignore-rules`, and `/watching/:id` (a seeded video id), confirm the response's sidebar
    markup has `data-active="true"` on exactly the one matching link (none, for
    `/watching/:id`) and no leftover reference to the deleted `CategoryFilterLinks`/old flat
    `<nav>` markup; `curl "/queue?category=<id>"` and `/watched?category=<id>` and confirm the
    matching category sidebar sub-item carries `data-active="true"`; `curl` a view filtered to
    a category with zero matching videos and confirm the empty-state message appears with no
    dangling grid markup; confirm via a direct SQLite read that no table's row count/contents
    changed from before this spec (this spec touches only rendering and read-only query
    shapes).
  - **User performs live in a browser**: open `/queue` at a desktop width (~1920×1080) and
    confirm the sidebar is persistently docked, the grid shows more than 3 columns if enough
    videos exist, thumbnails load, and the dark theme reads correctly with no light-background
    flash; resize below ~1024px and confirm the sidebar collapses behind a hamburger toggle
    with a working backdrop-tap-to-close, and the grid reflows without horizontal scroll;
    click a sidebar category while on `/watched` and confirm it filters Watched in place
    (doesn't jump to Queue); click a video's card anywhere on the thumbnail or title and
    confirm it opens YouTube in a new tab and navigates to `/watching/:id`; use the Mark
    Watched/Ignore buttons on a card and confirm the HTMX partial swap still works with no
    full page reload; exercise the Categories/Ignore Rules/Channels add/edit/delete flows and
    confirm they still work under the new list styling; throttle/block `i.ytimg.com` in dev
    tools and confirm a broken thumbnail is hidden without visibly collapsing the card layout.
  - Done when: all three commands are clean, Claude's curl/DB-read checks above all pass, and
    the user confirms the browser-only checks. Then update
    `docs/specs/011-style-and-layout.md`'s frontmatter to `status: implemented`.
