# Tasks: Category Queue Filtering
Spec: docs/specs/006-category-queue-filtering.md
Generated: 2026-07-24

- [x] 1. In `src/routes/queue.tsx`, add `resolveCategoryFilter(raw: string | undefined):
  number | undefined` and `allCategories()` per the spec's Design > Category filter
  resolution and Category option list sections (exact code sketched there). Add an
  optional `categoryId?: number` parameter to `queueVideos` (currently `queue.tsx:20`),
  `continueWatchingVideos` (currently `queue.tsx:51`), and `watchedVideos` (currently
  `queue.tsx:80`), each appending `eq(subscriptions.categoryId, categoryId)` to their
  `where(and(...))` clause only when `categoryId !== undefined`, per the spec's Design >
  Query changes section. Do not change any route handler or call site yet — all three
  functions' new parameter must be optional so `queueVideos(user.id, sort)` (no third
  arg) still compiles and behaves identically to today. Confirm the
  conditional-array-spread-into-`and(...)` shape (`...(categoryId !== undefined ? [...] :
  [])`) actually compiles against the installed `drizzle-orm@0.45.2` — if it doesn't,
  fall back to building the conditions array with a plain `if` push before calling
  `and(...)`, per the spec's Open Questions. Done when: `bun run lint` is clean, `bunx
  tsc --noEmit` (or the project's equivalent typecheck) reports no new errors, and `bun
  test test/routes/queue.test.ts` still passes unmodified (proves the new optional
  parameters didn't change existing unfiltered behavior).

- [x] 2. In `src/views/queue-list.tsx`, add the `CategoryFilterLinks` component exactly
  per the spec's Design > Picker component section (`categories`/`buildHref`/`current`
  props, "All" link plus one link per category, no active-link styling). Add an optional
  `category?: number` parameter to `watchingHref` and `toggleHref` (currently
  `queue-list.tsx:31` and `:41`), setting `params.set("category", String(category))`
  when present — per the spec's Design > Row links section, this must stay `number`, not
  `string`, matching what `resolveCategoryFilter` produces. Add a matching
  `category?: number` field to each of `QueueListProps`'s three view variants (`queue`,
  `continue-watching`, `watched`), and thread it into the `watchingHref`/`toggleHref`
  calls inside `QueueList`'s render body. Do not change `src/routes/queue.tsx` in this
  step — its calls to `QueueList`/`watchingHref`/`toggleHref` keep omitting the new
  param, so this step is additive-only. Done when: `bun run lint` is clean, `bunx tsc
  --noEmit` reports no new errors, and `bun test test/routes/queue.test.ts` still passes
  unmodified.

- [x] 3. Wire category filtering into the `GET /queue` handler (`queueRoute.get(
  "/queue", ...)` — locate by route path; task 1's edits above it will have shifted its
  line number from the pre-task-1 `queue.tsx:172`) per the spec's Design > Routes
  section: add the `buildQueueHref(sort, category?)` helper (exact code
  sketched there), replace the two hardcoded sort-toggle `<a href="/queue">`/`<a
  href="/queue?sort=oldest">` links with calls to `buildQueueHref("newest", category)` /
  `buildQueueHref("oldest", category)`, render `<CategoryFilterLinks
  categories={allCategories()} current={category} buildHref={(catId) =>
  buildQueueHref(sort, catId)} />` between the sort-toggle `<p>` and `<QueueList>`, call
  `resolveCategoryFilter(c.req.query("category"))` and pass the result into both
  `queueVideos(user.id, sort, category)` and `<QueueList category={category} ...>`.
  Verify `buildQueueHref("newest", undefined)` and `buildQueueHref("oldest", undefined)`
  produce byte-identical output to today's hardcoded `href="/queue"` / `href="/queue?
  sort=oldest"` (this is what keeps the existing sort-toggle tests passing unmodified —
  see done-when). Done when: `bun run lint` is clean, `bun test
  test/routes/queue.test.ts` still passes unmodified (proves the rewritten sort-toggle
  links didn't change output for the no-category case), and manually curling `/queue?
  category=<a real category id>` from inside the devcontainer returns HTML scoped to
  that category only.

- [x] 4. Wire category filtering into the `GET /continue-watching` and `GET /watched`
  handlers (locate by route path — prior tasks' edits mean their line numbers have
  shifted from the pre-task-1 `queue.tsx:186`/`:198`) the same way task 3 did for
  `/queue`: add
  `buildContinueWatchingHref(category?)` and `buildWatchedHref(category?)` helpers (same
  `URLSearchParams`-then-conditional-`?` shape as `buildQueueHref`, no `sort` branch),
  render a `<CategoryFilterLinks>` block on each page, call `resolveCategoryFilter` and
  pass the result into `continueWatchingVideos`/`watchedVideos` and each `<QueueList
  category={category} ...>`. Done when: `bun run lint` is clean, `bun test
  test/routes/queue.test.ts` still passes unmodified, and manually curling
  `/continue-watching?category=<id>` and `/watched?category=<id>` from inside the
  devcontainer each return HTML scoped to that category only.

- [x] 5. Wire `category` through the `POST /videos/:id/toggle` handler (locate by route
  path — its line number has shifted from the pre-task-1 `queue.tsx:248`) per the
  spec's Design > Routes section: read `const category =
  resolveCategoryFilter(c.req.query("category"))` alongside the existing `view`/`sort`
  reads, and pass it into **both** re-render branches — the `continue-watching` branch's
  `continueWatchingVideos(user.id, category)` / `<QueueList category={category} ...>`
  call, and the `queue` (default/fallback) branch's `queueVideos(user.id, sort,
  category)` / `<QueueList category={category} ...>` call. Both branches must be
  updated, not just one — this is the exact slip the spec's Testing section calls out as
  plausible. Done when: `bun run lint` is clean and `bun test test/routes/queue.test.ts`
  still passes unmodified.

- [x] 6. Add `category` to the return-to-origin navigation machinery in
  `src/routes/queue.tsx` per the spec's Design > Return-to-origin navigation section:
  add the `buildReturnPath(base, sort?, category?)` helper (exact code sketched there,
  routing through `URLSearchParams` — do not use raw template-string interpolation for
  `category`, since it is unvalidated at this point in the flow), rewrite all three
  `RETURN_VIEWS` entries' `path` functions to call it, and add a third `category:
  string | undefined` parameter to `resolveReturnTarget` (locate by function name —
  its line number has shifted from the pre-task-1 `queue.tsx:141-151`). Update the
  `GET /watching/:id` handler (locate by route path — shifted from the pre-task-1
  `queue.tsx:207`) to read `const category = c.req.query("category")` and pass it as
  the third argument to `resolveReturnTarget(from, sort, category)`. Update the `POST
  /videos/:id/watched-toggle` handler (locate by route path — shifted from the
  pre-task-1 `queue.tsx:238`) the same way. Verify
  `resolveReturnTarget(from, sort, undefined)` produces byte-identical output to
  today's two-argument version for every `from` value (this is what keeps the existing
  return-navigation tests passing unmodified). Done when: `bun run lint` is clean, `bunx
  tsc --noEmit` reports no new errors (this is exactly the arity/signature pitfall the
  spec's inline comment on `RETURN_VIEWS` warns about — all three `path` functions must
  keep matching call signatures), and `bun test test/routes/queue.test.ts` still passes
  unmodified.

- [x] 7. In `src/views/watching-page.tsx`, add a 4th `category: string | undefined`
  parameter to `watchedToggleAction` (currently `watching-page.tsx:18`), setting
  `params.set("category", category)` when present, per the spec's Design > Row links
  section's full code sketch. Add a `category: string | undefined` field to
  `WatchingPageProps` and update the `<form action={watchedToggleAction(props.id,
  props.from, props.sort, props.category)}>` call site. In `src/routes/queue.tsx`'s
  `GET /watching/:id` handler (already reading `category` off the query string from
  task 6), pass `category={category}` into the `<WatchingPage>` render alongside its
  existing props. Done when: `bun run lint` is clean, `bunx tsc --noEmit` reports no new
  errors, and `bun test test/routes/queue.test.ts` still passes unmodified.

- [x] 8. Add filtering-behavior test coverage to `test/routes/queue.test.ts` per the
  spec's Testing section. First add a second category fixture alongside the existing
  module-level `category` (`queue.test.ts:27-31`, `"Queue Test Category"`) — e.g. `const
  otherCategory = db.insert(categories).values({ name: "Other Queue Test Category"
  }).returning().get();` — and look up the seeded system category via `db.select().from(
  categories).where(eq(categories.isSystem, true)).get()` for the Uncategorized cases,
  since `makeSubscription` currently hardcodes `categoryId: category.id`
  (`queue.test.ts:48-62` — extend it to accept an optional `categoryId` override
  defaulting to the existing `category.id`, so existing calls need no changes). Add
  tests: `GET /queue?category=<id>` only returns that category's videos (use both
  categories' subscriptions to prove exclusion, not just inclusion); `?category=<system
  category id>` returns exactly the Uncategorized-channel videos; an invalid
  (non-numeric) and a well-formed-but-nonexistent `category` value both behave
  identically to no `category` param; `category` composes correctly with
  `?sort=oldest`. Repeat the filtering assertions for `GET /continue-watching?
  category=<id>` and `GET /watched?category=<id>` (including watched's since-unsubscribed-
  channel case still holding under a category filter). Add picker-rendering assertions:
  each of `/queue`, `/continue-watching`, `/watched` includes a link per existing
  category (including Uncategorized) plus an "All" link; on `/queue`, a category link's
  href preserves the current `sort`, and a sort link's href preserves the current
  `category`. Add `POST /videos/:id/toggle?view=queue&category=...` and
  `?view=continue-watching&category=...` tests confirming the re-rendered partial stays
  scoped to the given category. Done when: `bun test test/routes/queue.test.ts` passes
  covering all of the above.

- [ ] 9. Add return-navigation test coverage to `test/routes/queue.test.ts` per the
  spec's Testing section. Extend the existing test named `"GET /watching/:id resolves
  the return target from from/sort, with fallback for missing/unrecognized from"`
  (locate by test name — task 8's additions will have shifted its line number from the
  pre-task-8 `queue.test.ts:248-285`) or add a new one: `/watching/:id?
  from=queue&sort=oldest&category=<id>` renders "Return to Queue" pointing at
  `/queue?sort=oldest&category=<id>`, and the "Mark Watched & Return" form's `action`
  attribute carries the same `category`; repeat for `from=continue-watching` and
  `from=watched` with just `&category=<id>` (no `sort`); `POST
  /videos/:id/watched-toggle?from=queue&sort=oldest&category=<id>` redirects to that
  same URL (extend the existing test named `"POST /videos/:id/watched-toggle redirects
  to resolveReturnTarget's url for all from values plus the fallback"` — locate by test
  name, its line number has shifted from the pre-task-8 `queue.test.ts:345-381`). Add an
  adversarial-value test: request `/watching/:id?from=continue-watching&category=` +
  `encodeURIComponent("3&evil=true")`, and assert the rendered return link/redirect
  target contains `category` as a single correctly-encoded value (e.g. via
  `URLSearchParams` parsing of the target URL, confirming `evil` is not a separate
  parsed key) rather than an injected second querystring parameter — this is the test
  that would catch a regression back to raw template-string interpolation in
  `buildReturnPath`. Add the end-to-end row-link round trip: `GET /queue?category=<id>`,
  extract a row's actual rendered `<a href="/watching/...">` from the response body via
  string/regex parsing (not hand-constructed), request that exact URL, and assert the
  resulting page's "Return to Queue" link/form both point back at
  `/queue?category=<id>` — repeat once each for `continue-watching` and `watched`.
  Done when: `bun test test/routes/queue.test.ts` passes covering all of the above.

- [ ] 10. Run full verification: `bun test`, `bun run lint`, and `bunx tsc --noEmit`
  clean across the whole repo — done when: all three commands exit 0 with no failures
  (the typecheck in particular catches issues neither `bun test` nor `bun run lint`
  run a full type-check for, e.g. the pre-existing `noUncheckedIndexedAccess` error
  fixed separately in `test/routes/channels.test.ts` on 2026-07-25 — it wasn't caught
  until someone ran `tsc --noEmit` by hand).

Manual end-to-end verification (spec's "Verification" section, steps 1–9) is
browser/DB-driven and not part of this checklist — run it once all tasks above are
checked off.
