# Tasks: Channel Category Change, Per-Category Default Sort, Unsubscribe Confirm
Spec: docs/specs/034-channel-category-and-sort.md
Generated: 2026-10-10

Notes for every step: run commands via the devcontainer (CLAUDE.md). Branch is
`spec/channel-category-and-sort`; ask before every commit, never push. Test line numbers
quoted below are approximate (from spec-writing time) — re-locate by searching for the
described assertion, and re-verify the spec's "Existing tests that must change" list against
the code before editing. Steps are ordered so each leaves `bun test` green.

- [x] 1. Part C: confirm before unsubscribing — in `src/views/subscription-list.tsx`, add
  `hx-confirm={`Unsubscribe from "${subscription.channelName}"?`}` to the Unsubscribe button
  (mirror category Delete's `hx-confirm` in `src/views/categories-list.tsx`). Add a test in
  `test/routes/channels.test.ts` that renders `/channels` with a subscription whose channel
  name contains a double quote (e.g. `The "Best" Channel`) and asserts the exact escaped
  attribute (`hx-confirm="Unsubscribe from &quot;The &quot;Best&quot; Channel&quot;?"` — use
  whatever Hono actually emits; check the real output) and that Dismiss has no `hx-confirm`.
  — done when: `bun test` passes and the new test fails if `hx-confirm` is removed.

- [x] 2. Part A: change a channel's category — (a) `src/routes/channels.tsx`:
  `listActiveSubscriptions` selects `subscriptions.categoryId` (type `categoryId`), and drops
  `categoryName` and its `innerJoin(categories…)`; (b) `src/views/subscription-list.tsx`:
  `Subscription` type gets `categoryId: number` and loses `categoryName`; `SubscriptionList`
  takes a `categories: Category[]` prop (non-system rows, as `subscribeCategories`); replace
  the category pill with a `<select name="categoryId" aria-label={`Category for
  ${channelName}`} hx-post={`/subscriptions/${id}/category`} hx-trigger="change"
  hx-target="#subscription-list" hx-swap="outerHTML" hx-disabled-elt="this">` with an
  "Uncategorized" option (value `""`, `selected` when the row's `categoryId` equals
  `getSystemCategory().id` — pass the system id or a precomputed flag per row, don't match on
  option value) followed by the non-system categories (`selected` on the row's category);
  (c) thread `categories` through every `SubscriptionList` renderer: `ChannelsPage` (reuse
  its `subscribeCategories` prop), `POST /subscriptions`'s OOB render, and
  `updateOwnedSubscription`'s render (share one small helper rather than repeating
  `listNonSystemCategories()` ad hoc); (d) new `POST /subscriptions/:id/category` handler:
  parse `categoryId` from the body, validate with `resolveCategoryId`; on `!ok` return
  `SubscriptionList` with `error` set (early return — `updateOwnedSubscription` has no error
  path); otherwise `updateOwnedSubscription(c, userId, id, { categoryId })`. Tests in
  `test/routes/channels.test.ts`: change to a non-system category (DB row updated, response
  list shows it selected); change back to Uncategorized via `""`; system-category id and
  unknown id rejected with "Invalid category." and subscription unchanged; 404 for another
  user's subscription and for an unsubscribed one; a row in Uncategorized renders the
  `""` option selected; replace the existing category-pill assertion (~L858-888, the
  `<span ...>Tech</span>` check) with a selected-option assertion; confirm `categoryName` is
  no longer referenced anywhere (`grep`). — done when: `bun test` passes and `bunx tsc
  --noEmit` is clean.

- [x] 3. Part B schema + migration — in `src/db/schema.ts` add to `categories`:
  `defaultSort: text("default_sort", { enum: ["newest", "oldest"] }).notNull().default("newest")`
  (no `CHECK`, and don't touch the table's existing `name_length_check`). Run `bun run
  db:generate` in the devcontainer (if it prompts and needs a TTY, hand the user the exact
  command per CLAUDE.md). Inspect the generated SQL in `drizzle/`: it must be a single plain
  `ALTER TABLE \`categories\` ADD \`default_sort\` text DEFAULT 'newest' NOT NULL;` — if it is
  a table rebuild (`__new_categories`/`DROP TABLE`), stop, fix the schema, and regenerate. Then
  verify against a populated DB: write a throwaway script file (not inline `bun -e`) that
  copies the dev DB (or builds one via migrations up to the prior one, inserts a subscription
  plus the seeded Uncategorized row), applies the new migration via `src/db/migrate.ts`, and
  confirms existing categories read `default_sort = 'newest'` and subscriptions are intact;
  delete the script/copies afterward. — done when: the migration is a plain ADD COLUMN, the
  populated-DB check passed, `bun test` and `bunx tsc --noEmit` are clean, and existing
  categories tests still pass without sending `defaultSort`.

- [x] 4. Part B: sort resolution and explicit-sort links (backend) — (a) `src/routes/queue.tsx`:
  extend `resolveCategoryFilter` (or add a sibling) to also yield the category's `defaultSort`;
  replace `resolveSort(sort)` with `resolveSort(rawSort, categoryDefault)` = raw `sort` if
  exactly `newest`/`oldest`, else the category default, else `newest` (invalid values fall
  through to the default, not coerced to newest); call it in `GET /queue` **before** the
  `cursor !== undefined` branch and in `POST /videos/:id/toggle`; add a separate plain
  validator (`newest`/`oldest`/`undefined`) used by `GET /watching/:id` and `POST
  /videos/:id/watched-toggle` so garbage `sort` is never passed to `WatchingPage` (its
  `watchedToggleAction`) or `buildReturnPath`; (b) `buildReturnPath` emits `sort=newest` as
  well as `sort=oldest`; (c) `src/lib/queue-urls.ts`: `buildQueueHref`'s `sort` param becomes
  `"newest" | "oldest" | undefined`, omitted from the URL only when `undefined`, always set
  when given (newest included); update every caller to compile (`layout.tsx`, `queue-list.tsx`
  sentinel, `queue.tsx` toggle links) and the sidebar in
  `src/views/layout.tsx` in this same step (otherwise newest would start emitting `sort=newest`
  into sidebar links mid-way): `sidebarCategoryHref` drops its `currentSort` param and the
  queue case calls `buildQueueHref(undefined, categoryId)` (no `sort`); the top-level Queue
  link calls `buildQueueHref(undefined)` (always newest — user-confirmed decision, see the
  spec's Open Questions); remove the now-unused `currentSort` prop from `Layout` and stop
  passing it in `src/routes/queue.tsx`. Toggle links and the sentinel pass explicit `sort`. Update the
  existing tests this changes (re-verify first): `test/routes/queue.test.ts` the oldest-page
  Newest-toggle assertion (~L196 → `/queue?sort=newest`) and the queue-return-link assertions
  near ~L1036 (→ `/queue?sort=newest&category=N`, including the `action` assertion after it),
  and rewrite "category links preserve sort, and sort links preserve category" (~L565-583):
  sidebar category links now carry **no** `sort`, the top Queue link is `/queue`, toggle links
  preserve category and carry explicit `sort`; confirm categories-page links
  (`/queue?category=N`) are unchanged.
  Add tests: with a category whose `default_sort` is set to `oldest` directly in the DB,
  `/queue?category=N` is oldest-ordered; `sort=newest` overrides it and `sort=oldest` overrides
  a newest default; `sort=garbage` falls back to the default; unknown category → newest;
  toggle links and sentinel URL contain explicit `sort`; page 2 via the sentinel URL
  continues in the same order as page 1 (oldest-default category, several videos); a cursor
  request without `sort` resolves to the category default; `POST /videos/:id/toggle` without
  `sort` uses the category default; `sort=garbage` on `/watching/:id` and `watched-toggle`
  is dropped (not present in the form action, return link, or redirect), while
  `sort=newest`/`sort=oldest` round-trip. — done when: `bun test` and `bunx tsc --noEmit`
  pass.

- [x] 5. Part B: toggle active-order indicator — in `GET /queue` (`src/routes/queue.tsx`), render
  the resolved order's toggle label as bold non-link text and the other order as a link with
  explicit `sort`, preserving `category`. Add a test: on an oldest-default category with no
  `sort` in the URL, "Oldest first" is not a link and "Newest first" links to
  `/queue?sort=newest&category=N`; on the plain `/queue` newest page "Newest first" is plain
  text and "Oldest first" links to `/queue?sort=oldest`; adjust any existing toggle-link
  assertions this affects (e.g. the ~L174 `href="/queue?sort=oldest"` check still holds).
  Run `bun run fallow` to confirm nothing from steps 4-5 became dead (e.g. the removed
  `Layout.currentSort`). — done when: `bun test`, `bunx tsc --noEmit`, and `bun run fallow`
  pass.

- [x] 6. Part B: setting the default sort — (a) `src/routes/categories.tsx`:
  `parseAndValidateCategoryName` stays name-only for `POST /categories`; for `POST
  /categories/:id` (edit) additionally parse `defaultSort` from the same single `parseBody()`
  call (e.g. an opt-in parameter or small wrapper) — missing, non-string, or not
  `newest`/`oldest` → re-render `CategoriesList` with `editingId` and an error (no silent
  keep); update `name` and `defaultSort` in one `UPDATE`, keeping the unique-name error path;
  (b) `src/views/categories-list.tsx`: the edit row gains `<select name="defaultSort">` (Newest
  first / Oldest first, current value `selected`) beside the name input inside the same form;
  non-edit rows show a small muted "oldest first" label only when `defaultSort` is `oldest`
  (nothing for newest; nothing for the system row, which still has no Edit button); (c)
  update `test/routes/categories.test.ts`: `postRename` (~L106-115) sends `defaultSort` (so
  the rename-success ~L201 and unique-name ~L261 tests keep passing); add tests that edit
  persists `defaultSort` (and name together), missing/invalid `defaultSort` re-renders the
  edit row with an error and changes nothing, the system category still can't be edited, the
  edit row renders the select with the current value selected, and the list label appears only
  for `oldest`. — done when: `bun test`, `bunx tsc --noEmit`, and `bun run lint` pass.

- [x] 7. Manual verification, Claude-performed — in the devcontainer: `bun run css:build` if
  needed, start the dev server, `scripts/dev-login.sh`, then via `curl -b
  /tmp/tubeshelf-dev-cookies.txt http://localhost:3000/...` from inside the container (write any
  `bun:sqlite` throwaway-row script to a file first; delete rows/files afterward): (a)
  `/channels` shows a select per row with the correct selected option, and `POST
  /subscriptions/:id/category` (with the CSRF `Origin` header as in `scripts/dev-login.sh`)
  moves a subscription and the DB row reflects it; invalid category returns the list with
  "Invalid category."; Unsubscribe button HTML carries `hx-confirm`; (b) set a category's
  `default_sort='oldest'` via the edit route (`POST /categories/:id` with `name` and
  `defaultSort`), then `/queue?category=N` lists oldest-first with the toggle showing
  "Oldest first" as plain text, `?sort=newest` flips it, and sidebar category links carry no
  `sort`; the Queue link is `/queue`; (c) page 2 via the sentinel URL in the response
  continues the order. Stop the dev server via a `/proc` scan script file (CLAUDE.md gotcha).
  — done when: results are reported.

- [x] 8. Manual verification, user-performed in a browser — give the user exact URLs and what to
  look for: (a) on `/channels`, changing a channel's category dropdown swaps the list in place
  with no full page reload and the new category sticks after reload; Unsubscribe shows a
  browser confirm naming the channel, Cancel leaves it subscribed, OK unsubscribes; (b) on
  `/categories`, Edit a category, set Oldest first, Save; click that category in the sidebar —
  oldest-first order, "Oldest first" shown as plain text; click "Newest first" — order flips
  and stays flipped while scrolling past the first page (endless scroll), marking a video
  watched, and via the watching page's Return to Queue; click another category and the top
  Queue link — each opens in its own default (newest for Queue). — done when: the user reports
  results back.

- [ ] 9. Final verification, flip spec to implemented, open the PR — run `bun test`, `bun run
  lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across the repo; set
  `docs/specs/034-channel-category-and-sort.md` frontmatter to `status: implemented`. Draft the
  PR (summary + test plan; end with the Claude Code attribution line) per CLAUDE.md's git
  workflow: check this step's box *before* pushing, commit, then ask whether the user is
  pushing or Claude should; never merge. — done when: all four commands are green, spec is
  `implemented`, this file is fully checked, and the PR is open (or the user has been handed
  the push/PR command).
