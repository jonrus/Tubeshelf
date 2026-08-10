# Tasks: Endless Scroll for Video List Views
Spec: docs/specs/019-endless-scroll.md
Generated: 2026-08-10

- [ ] 1. Add three composite indexes to `videos` in `src/db/schema.ts` (import `index` from
      `drizzle-orm/sqlite-core` alongside the existing `check`/`unique`; add
      `index("videos_status_published_idx").on(t.status, t.publishedAt, t.id)`,
      `index("videos_status_watched_idx").on(t.status, t.watchedAt, t.id)`,
      `index("videos_status_created_idx").on(t.status, t.createdAt, t.id)` to the `videos`
      table's `(t) => [...]` extra-config array), then generate the migration with
      `devcontainer exec --docker-path podman --workspace-folder . bun run db:generate`. —
      done when: `src/db/schema.ts` has the three `index(...)` entries, a new file exists
      under `drizzle/` containing three `CREATE INDEX` statements matching them, and
      `devcontainer exec --docker-path podman --workspace-folder . bunx tsc --noEmit`
      passes.

- [ ] 2. In `src/routes/queue.tsx`, add a `PAGE_SIZE = 20` constant and a `parseCursor`
      helper per the spec's Design → "Page size, sort keys, and cursor shape" section
      (signature `parseCursor(cursor: string | undefined, cursorId: string | undefined):
      { at: Date; id: number } | undefined`, returns `undefined` on missing/malformed
      input rather than throwing). Add `gt`, `lt`, `or` to the existing `drizzle-orm`
      import. — done when: `parseCursor` exists in `queue.tsx`, is exported or
      module-local as appropriate for use later in this file, and
      `bunx tsc --noEmit` passes.

- [ ] 3. Rewrite `queueVideos` in `src/routes/queue.tsx` (currently lines 26-62) to accept a
      fourth `cursor: { at: Date; id: number } | undefined` parameter, add the compound
      cursor `WHERE` clause (`or(lt/gt(publishedAt, cursor.at), and(eq(publishedAt,
      cursor.at), lt/gt(id, cursor.id)))`, direction matching `sort`), add `id` as an
      explicit secondary `orderBy` key alongside `publishedAt`, and change to
      `.limit(PAGE_SIZE + 1).all()`. Compute `nextCursor` internally per the spec's "Query
      changes" section's exact code sample: slice to `PAGE_SIZE`, take the last row via an
      explicit `rows.length > 0 ? rows[rows.length - 1] : undefined` check (not `.at(-1)`
      or a non-null assertion — `noUncheckedIndexedAccess` is on), guard
      `lastRow.publishedAt !== null` before building `{ at, id }`. Return
      `{ rows, nextCursor }` instead of a bare array. — done when: `queueVideos` matches
      that shape, `bunx tsc --noEmit` passes (its two call sites will now be type-errors
      until steps 8/9 update them — that's expected and resolved by those later steps, not
      this one).

- [ ] 4. Apply the same rewrite to `continueWatchingVideos`, `watchedVideos`, and
      `ignoredVideos` in `src/routes/queue.tsx` (currently lines 64-94, 96-131, 133-162),
      per the per-function deltas listed in the spec's "Query changes" section (each keeps
      its own existing status filter and sort column; `continueWatchingVideos` and
      `queueVideos` share `(publishedAt, id)`, `watchedVideos` uses `(watchedAt, id)` with
      no null guard needed (DB-guaranteed non-null via `watched_at_check`),
      `ignoredVideos` uses `(createdAt, id)` with no null guard needed (`.notNull()`);
      `watchedVideos` keeps its existing lack of an `unsubscribedAt` filter unchanged).
      Each gains a `cursor` parameter and returns `{ rows, nextCursor }`. — done when: all
      three match the pattern established in step 3, and `bunx tsc --noEmit` shows only the
      same expected call-site errors as step 3 (not new ones from these three functions'
      own bodies).

- [ ] 5. Add a new `queueRowById(id: number)` function in `src/routes/queue.tsx`, running
      the same `videos`/`youtubeChannels`/`subscriptions`/`categories` join `queueVideos`
      uses but scoped to `eq(videos.id, id)` with no cursor/limit/status filter, returning
      the same select shape as `queueVideos`'s rows (so it satisfies `QueueRow` from
      `src/views/queue-list.tsx`). Per the spec's "Action handlers" section — this is what
      the `/toggle` handler will use in step 9 to re-render a single card after a mutation,
      since neither `toggleQueueStatus`'s return value nor the request params carry the
      channel/category display data. — done when: `queueRowById` exists, returns
      `undefined`/`null`-safe (single row via `.get()`) matching `QueueRow`'s shape, and
      `bunx tsc --noEmit` passes for this function in isolation.

- [ ] 6. Extend each `build*Href` function in `src/lib/queue-urls.ts`
      (`buildQueueHref`, `buildContinueWatchingHref`, `buildWatchedHref`,
      `buildIgnoredHref`) to accept an optional `cursor?: { at: Date; id: number }`
      parameter, adding `cursor`/`cursorId` (epoch-milliseconds string + row id string) to
      the built `URLSearchParams` when present, following the same
      "only set the param if it differs from the default" style already used for `sort`/
      `category` in each function. — done when: all four functions accept the new
      parameter, existing call sites (which don't pass it) still compile unchanged, and
      `bunx tsc --noEmit` passes.

- [ ] 7. Restructure `src/views/queue-list.tsx` per the spec's "`QueueList` / card rendering
      restructuring" section:
      - Add `id={`video-${row.id}`}` to every card `<div>` across all four `props.view`
        branches (currently only a JSX `key`).
      - Extract the three inline `.map()` row-rendering bodies into standalone functions
        `queueCard(row: QueueRow, view: "queue" | "continue-watching", sort:
        "newest" | "oldest" | undefined, category: number | undefined)`, `watchedCard(row:
        WatchedRow, category: number | undefined)`, `ignoredCard(row: IgnoredRow, category:
        number | undefined)`, each returning one card's JSX (identical markup to today,
        just wrapped in a named function instead of an inline map callback).
      - On the queue/continue-watching and ignored cards' action buttons (`toggleHref`,
        `ignoreHref`, `unignoreHref` targets), change `hx-target="#queue-list"` to
        `hx-target={`#video-${row.id}`}`, keeping `hx-swap="outerHTML"`.
      - Add a `LoadMoreSentinel` component taking a `href: string` prop: `hx-get={href}`,
        `hx-trigger="revealed"`, `hx-target="this"`, `hx-swap="outerHTML"`, per the spec's
        Design section.
      - `QueueList`/`QueueListMore`'s props gain `nextCursor: { at: Date; id: number } |
        undefined` (forwarded opaquely from the route — the component never inspects which
        column it came from). When defined, the component builds the sentinel's href
        itself by calling the `build*Href` function matching its own `props.view` (from
        `src/lib/queue-urls.ts`, extended in step 6) with `nextCursor` as the new cursor
        argument. `QueueList` becomes a thin wrapper: `<div id="queue-list">
        {rows.map(cardFn)}{sentinelHref && <LoadMoreSentinel href={sentinelHref} />}
        </div>` (or the existing `EmptyState` when `rows.length === 0`, unchanged from
        today).
      - Add a new export `QueueListMore` with the same props shape as `QueueList` minus the
        wrapping `#queue-list` div — just `{rows.map(cardFn)}{sentinelHref &&
        <LoadMoreSentinel href={sentinelHref} />}` — for the load-more fragment response.
      — done when: `queue-list.tsx` exports `QueueList` and `QueueListMore`, both build
      their own sentinel href internally from a passed-through `nextCursor`, both card
      lists render via the shared `queueCard`/`watchedCard`/`ignoredCard` functions, every
      card has a `video-${id}` DOM id, and `bunx tsc --noEmit` passes (call sites in
      `queue.tsx` will still be on the old shape until steps 8-9 — expected).

- [ ] 8. Update the four `GET` routes in `src/routes/queue.tsx` (`/queue`,
      `/continue-watching`, `/watched`, `/ignored`, currently lines 260-345) to parse
      `cursor`/`cursorId` via `parseCursor`, pass it through to the corresponding list
      function, and branch per the spec's "Route/handler changes" section: no cursor →
      full `<Layout>` page wrapping `<QueueList rows={...} nextCursor={...} .../>`; cursor
      present → bare `c.html(<QueueListMore rows={...} nextCursor={...} .../>)` with no
      `<Layout>`. The route passes `nextCursor` straight through from the list function's
      return value — it does not inspect or rebuild it. — done when: all four routes
      compile against the new `{ rows, nextCursor }` return shape from steps 3-4, hitting
      each route with no query params still returns a full page (existing tests from
      before this spec still pass conceptually, pending step 10's updates), and
      `bunx tsc --noEmit` passes.

- [ ] 9. Rewrite `POST /videos/:id/toggle`, `/videos/:id/ignore`, `/videos/:id/unignore` in
      `src/routes/queue.tsx` (currently lines 395-467) per the spec's "Action handlers"
      section:
      - `/ignore` and `/unignore`: after the mutation succeeds, return an empty body with
        response header `HX-Reswap: delete` (via Hono's `c.header("HX-Reswap", "delete")`
        then `c.body(null)`, or equivalent) instead of re-rendering `QueueList` against
        `continueWatchingVideos`/`queueVideos`/`ignoredVideos`.
      - `/toggle`: after calling `toggleQueueStatus`, branch on `result.status` (not on any
        assumption about the prior status): `"watched"` → `HX-Reswap: delete`, empty body,
        for either `view`. `"unwatched"` with `view=continue-watching` → `HX-Reswap:
        delete`, empty body. `"unwatched"` with `view=queue` → no `HX-Reswap` header, body
        is `queueCard(queueRowById(id), "queue", sort, category)` (the row re-fetched via
        step 5's `queueRowById`, since `toggleQueueStatus`'s return value alone doesn't
        carry the display fields `queueCard` needs).
      — done when: none of these three handlers call `queueVideos`/
      `continueWatchingVideos`/`ignoredVideos` anymore, the toggle handler's `queue`+
      `unwatched` branch renders via `queueRowById`, and `bunx tsc --noEmit` passes.

- [ ] 10. Update `test/routes/queue.test.ts` per the spec's "Testing implications" section:
      - Add a test seeding more than `PAGE_SIZE` (20) videos into one view (e.g. Watched)
        and asserting the first-page response contains exactly 20 cards plus a load-more
        sentinel, and that a follow-up request with that sentinel's `cursor`/`cursorId`
        returns the remaining rows with no overlap or gap against page 1.
      - Add a test with two videos sharing an identical `publishedAt` (or `watchedAt`/
        `createdAt` depending on view) confirming the `id` secondary sort deterministically
        places them on either side of a page boundary with no duplicate/skip.
      - Update every existing assertion that a toggle/ignore/unignore `POST` response
        contains the full re-rendered list — those now assert either a single-card HTML
        fragment (for the `queue`+`unwatched` toggle branch) or an empty body with the
        `HX-Reswap: delete` response header (every other branch).
      — done when: `devcontainer exec --docker-path podman --workspace-folder . bun test`
      passes, including the new pagination-boundary and tiebreak tests.

- [ ] 11. Run the full verification suite and do manual end-to-end verification, per
      `CLAUDE.md`'s convention of splitting manual verification into what Claude can check
      directly vs. what needs a live browser:
      - **Claude performs directly** (via `devcontainer exec ... curl` and/or direct SQLite
        reads against the dev DB): confirm `GET /queue` (and the other three views) with no
        query params returns ≤20 cards; confirm a `GET /queue?cursor=...&cursorId=...`
        request (using a real cursor value copied from the first response's sentinel href)
        returns the next page's HTML with no `<Layout>` wrapper; confirm
        `POST /videos/:id/ignore` returns an empty body with `HX-Reswap: delete`; confirm
        the three new indexes exist in the dev SQLite file
        (`sqlite3 data/*.db ".indexes videos"` or equivalent inside the container).
      - **User performs live in a browser**: load a view with more than 20 items (Watched
        is the most likely to already have enough real data) and scroll to confirm new
        cards load in automatically near the bottom with no full-page reload; confirm
        toggling/ignoring a card while scrolled several pages deep removes or updates only
        that card in place, without the list jumping back to the top; confirm changing the
        Queue sort toggle or a category filter while scrolled down resets cleanly to a
        fresh first page rather than mixing cursor state from the old filter.
      — done when: `devcontainer exec --docker-path podman --workspace-folder . bun test`,
      `bun run lint`, and `bunx tsc --noEmit` are all clean, Claude's direct checks above
      pass, and the user has confirmed the live-browser checks above.

- [ ] 12. Flip `docs/specs/019-endless-scroll.md`'s frontmatter to `status: implemented`,
      then open the PR (summary + test plan filled out, referencing this task file and the
      manual verification results from step 11) — check this box *before* pushing, per
      `CLAUDE.md`'s git workflow ("Finishing a spec" section), so the push carries a
      fully-checked-off task file. — done when: the spec's `status` is `implemented`, this
      box is checked, and a PR against `main` exists for the `spec/endless-scroll` branch
      (confirm with the user beforehand whether they are pushing themselves or want Claude
      to, per `CLAUDE.md` — never push without asking).
