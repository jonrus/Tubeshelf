# Tasks: Unwatched Counters and Category Queue Links
Spec: docs/specs/009-unwatched-counters-and-category-links.md
Generated: 2026-07-27

- [ ] 1. Create `src/lib/nav-counts.ts` exporting `NavCounts` and `getNavCounts(userId)`,
  exactly as specified in the spec's "New file: `src/lib/nav-counts.ts`" section (three
  `count()` queries joining `subscriptions` directly against `videos.channelId`, no
  `youtubeChannels`/`categories` join). Add `test/lib/nav-counts.test.ts` covering: (a) an
  active subscription's `unwatched`/`watching` videos are counted in `queueCount`, an
  `ignored` or `watched` video on that same subscription is not; (b) `continueWatchingCount`
  only counts `watching`, not `unwatched`; (c) `watchedCount` counts a `watched` video even
  after its subscription's `unsubscribedAt` is set (true-history behavior), while
  `queueCount`/`continueWatchingCount` do not count anything from that unsubscribed
  subscription. Done when: `bun test test/lib/nav-counts.test.ts` passes and exercises all
  three cases above.

- [ ] 2. Wire `navCounts` through `Layout` and all 8 render call sites, per the spec's
  "`Layout` gains a required `navCounts` prop" table:
  - `src/views/layout.tsx`: `Layout` takes a required `navCounts: NavCounts` prop (import
    the type from `../lib/nav-counts`); render `Queue (N)`, `Continue Watching (N)`,
    `Watched (N)` in the nav using it. `Ignored` link unchanged.
  - `src/routes/queue.tsx`: add `navCounts={getNavCounts(user.id)}` to the four existing
    `<Layout>` usages (`GET /queue`, `/continue-watching`, `/watched`, `/ignored`). In
    `GET /watching/:id`, add `const user = getCurrentUser();` and pass a new `navCounts`
    field through `WatchingPageProps`.
  - `src/views/watching-page.tsx`: `WatchingPageProps` gains `navCounts: NavCounts`; pass it
    to the internal `<Layout>`.
  - `src/routes/categories.tsx`: import `getCurrentUser`; in `GET /`, compute
    `const user = getCurrentUser();` and pass `navCounts={getNavCounts(user.id)}` through to
    `CategoriesPage`.
  - `src/views/categories-page.tsx`: `CategoriesPage` gains a `navCounts: NavCounts` prop,
    passed to its `<Layout>`.
  - `src/routes/channels.tsx`: in `GET /channels`, pass `navCounts={getNavCounts(user.id)}`
    through to `ChannelsPage` (already has `user` in scope).
  - `src/views/channels-page.tsx`: `ChannelsPage` gains a `navCounts: NavCounts` prop, passed
    to its `<Layout>`.
  - `src/routes/ignore-rules.tsx`: import `getCurrentUser`; in `GET /ignore-rules`, compute
    `const user = getCurrentUser();` and pass `navCounts={getNavCounts(user.id)}` through to
    `IgnoreRulesPage`.
  - `src/views/ignore-rules-page.tsx`: `IgnoreRulesPage` gains a `navCounts: NavCounts` prop,
    passed to its `<Layout>`.
  - Add a test to `test/routes/queue.test.ts` asserting the nav badges are wired correctly.
    **Don't hardcode expected numbers**: this file runs every test against one shared
    module-level in-memory db with no reset between tests (`seed(db)` runs once at module
    load, and each test's `makeChannel`/`makeSubscription`/`makeVideo` helpers just append
    more rows via counters), so by the time any given test runs, the true queue/continue-
    watching/watched totals for `defaultUser` depend on every test that happened to run
    before it. Instead, import `getNavCounts` from `../../src/lib/nav-counts` in the test
    file, call `getNavCounts(defaultUser.id)` immediately before making the `GET /queue`
    request, and assert the response HTML contains `Queue (${counts.queueCount})`,
    `Continue Watching (${counts.continueWatchingCount})`, and
    `Watched (${counts.watchedCount})` — this is correct regardless of execution order and
    directly tests the thing task 2 actually adds (that `Layout` renders whatever
    `getNavCounts` returns), without re-deriving the counting logic itself (already
    unit-tested in isolation by task 1).
  Done when: `bunx tsc --noEmit` passes (proves no call site was missed, since `navCounts` is
  required), `bun test` passes, and the new queue.test.ts assertion passes.

- [ ] 3. Categories page count + link, per the spec's "Categories page: count + link"
  section:
  - `src/routes/categories.tsx`: add `categoryUnwatchedCount(userId, categoryId)`; change
    `listCategories()` to `listCategories(userId: number)` returning each category plus
    `unwatchedCount`; update all 14 call sites in `categoriesRoute` (`GET /`'s 1, `POST
    /categories`'s 5, `GET /categories/:id/edit`'s 2, `POST /categories/:id`'s 6) to pass
    `user.id` — each handler already has or gains `const user = getCurrentUser();` (already
    imported per task 2). Add the new imports (`and`, `count`, `inArray`, `isNull` from
    `drizzle-orm`; `subscriptions`, `videos` from `../db/schema`).
  - `src/views/categories-list.tsx`: export its `Category` type intersected with `{
    unwatchedCount: number }`; wrap each non-edit-mode row's `Name (N)` in
    `<a href="/queue?category=${category.id}">...</a>`, including the system row.
  - `src/views/categories-page.tsx`: replace its local `Category` type declaration with
    `import { type Category, CategoriesList } from "./categories-list";`.
  - Update `test/routes/categories.test.ts`: seed a category with at least one active
    subscription carrying an `unwatched` and a `watching` video, and assert `GET /` HTML
    contains both the `(N)` count matching the expected total and an
    `href="/queue?category=<id>"` link wrapping that category's name.
  Done when: `bunx tsc --noEmit` passes, `bun test` passes, and the new categories.test.ts
  assertions pass.

- [ ] 4. Channels page count, per the spec's "Channels page: count only, no link" section:
  - `src/routes/channels.tsx`: add `youtubeChannelId: youtubeChannels.id` to
    `listActiveSubscriptions`'s select object; add `channelUnwatchedCount(youtubeChannelId)`;
    in the `.map(...)`, destructure `youtubeChannelId` out of `rest` and add
    `unwatchedCount: channelUnwatchedCount(youtubeChannelId)` to each returned row. Add the
    new imports (`count`, `inArray` from `drizzle-orm`; `videos` from `../db/schema`).
  - `src/views/subscription-list.tsx`: `Subscription` type gains `unwatchedCount: number`;
    render `{subscription.channelName} ({subscription.unwatchedCount})
    ({subscription.categoryName})` (plain text, no link).
  - Update `test/routes/channels.test.ts`: seed an active subscription with an `unwatched`
    video and assert `GET /channels` HTML contains the matching `(N)` count next to that
    channel's name.
  Done when: `bunx tsc --noEmit` passes, `bun test` passes, and the new channels.test.ts
  assertion passes.

- [ ] 5. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo. Then do manual end-to-end verification, split per CLAUDE.md's convention:
  - **Claude performs directly** (via `curl` inside the devcontainer, per the
    port-forwarding gotcha in CLAUDE.md): `GET /queue`, `/continue-watching`, `/watched`,
    `/channels`, `/` (Categories), and `/ignore-rules` each return nav text with all three
    counts; `GET /` (Categories) returns an `href="/queue?category=<id>"` link around a
    non-system category's `Name (N)`, and `GET /channels` returns a plain-text `(N)` next to
    a channel name with no surrounding `<a>`. Toggle one video's status via
    `POST /videos/:id/toggle` and confirm a subsequent `GET /queue` reflects the new
    `Queue (N)` count (full-navigation freshness, not live-update).
  - **User performs live in a browser**: click a category's `Name (N)` link on `/` and
    confirm it navigates to `/queue?category=<id>` filtered to that category (real
    navigation, not just a curl-observable response); visually confirm the counts render
    inline and legibly next to each nav link/category/channel row (no styling expected yet,
    just "not obviously broken").
  Done when: all three commands are clean, Claude's curl-based checks above all pass, and
  the user confirms the browser-only checks. Then update `docs/specs/009-unwatched-counters-
  and-category-links.md`'s frontmatter to `status: implemented`.
