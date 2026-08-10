---
status: in-progress
created: 2026-08-10
---

# Endless Scroll for Video List Views

## Context

Queue, Continue Watching, Watched, and Ignored — all four rendered by one shared route
file (`src/routes/queue.tsx`) and one shared component (`src/views/queue-list.tsx`) — each
currently run a single unbounded Drizzle query with no `LIMIT`/`OFFSET`, rendering every
matching row on every visit. In practice this is already hundreds of rows per view (536 in
Watched, several hundred in Ignored on the reporter's own instance), with Watched in
particular having no natural upper bound the way Queue does (`docs/app_idea.md` lines
39-44). This wastes both client page-load work and server/DB query cost for views that are
mostly scrolled past, not read in full.

This exact gap was already identified and deliberately deferred in
`docs/specs/004-watch-flow-queue-views.md` (Out of Scope, and Open Questions) as a future
"endless scroll queue"-shaped spec covering all views at once. This spec is that work,
scoped via `docs/features/009-endless-scroll.md` (promoted from — see that file for the
original brainstorming/scoping conversation this spec builds on).

## Scope

**In:**
1. Cursor-based pagination (page size 20) applied uniformly to Queue, Continue Watching,
   Watched, and Ignored.
2. htmx `hx-trigger="revealed"`-driven infinite scroll: a sentinel element at the end of
   the currently-loaded list triggers a load-more request; the response is the next batch
   of cards plus a fresh sentinel, or nothing if that was the last page. No client-side JS
   beyond htmx. (`revealed` is htmx's original scroll-into-view trigger; current htmx docs
   point to `intersect once` as the more actively-documented modern equivalent, but
   `revealed` remains fully supported in the htmx 2.0.4 build this app already pins at
   `src/views/layout.tsx:121` and is simpler to reason about for this one-shot-per-sentinel
   use, so it's used deliberately rather than as legacy carryover.)
3. The initial (first-visit) render of all four views is also limited to the first page —
   not just subsequent scrolling.
4. New DB indexes supporting each view's filter+sort combination.
5. `POST /videos/:id/toggle`, `/ignore`, and `/unignore` change from re-fetching and
   re-rendering the entire list to updating or removing only the single affected card.

**Out (deferred, not this spec):**
- Any live-push mechanism for Queue (polling, SSE, WebSockets) to surface newly-ingested
  videos without a reload, and any "new videos available" banner/indicator. Queue does not
  live-update today — the scheduler's 1-minute tick just drains due channels (each channel
  itself is only actually re-polled roughly hourly, jittered per `docs/app_idea.md` line
  14); new rows simply sit in the DB until the next full page load. This spec preserves
  that behavior exactly: reload picks up new arrivals at the top, scroll loads older ones
  below. Cursor-based pagination is naturally immune to any inconsistency from concurrent
  inserts (a new row landing above the cursor never intrudes into an already-fetched
  range), so no new real-time mechanism is required to make pagination itself correct.
- History/back-navigation state preservation (e.g. via `hx-push-url` restoring all
  previously-loaded batches on back-navigation). Accepted limitation: a user who scrolls
  several batches deep, navigates away, and returns via the browser back button lands back
  on a fresh page 1, not their prior scroll position.
- Any visual/loading-state styling for the sentinel beyond plain text — same
  "unstyled but functional" precedent `docs/specs/009-unwatched-counters-and-category-links.md`
  used for its counts.

## Design

### Page size, sort keys, and cursor shape

`PAGE_SIZE = 20`, a top-level constant in `src/routes/queue.tsx`.

Cursor is represented as two query params reused across all four views —
`cursor` (the sort column's last-seen value, as epoch milliseconds) and `cursorId` (that
row's `videos.id`) — since exactly one sort column is active per view/request. Absence of
either param means "first page":

```ts
function parseCursor(
  cursor: string | undefined,
  cursorId: string | undefined,
): { at: Date; id: number } | undefined {
  if (cursor === undefined || cursorId === undefined) return undefined;
  const at = new Date(Number(cursor));
  const id = Number(cursorId);
  if (Number.isNaN(at.getTime()) || !Number.isInteger(id)) return undefined;
  return { at, id };
}
```

Malformed/missing cursor params silently degrade to "first page" rather than erroring —
matching `resolveCategoryFilter`'s existing pattern (`queue.tsx:164-174`) of falling back
on bad query input instead of 400ing.

**NULL handling:** `videos.watchedAt` is guaranteed non-null whenever `status = 'watched'`
by the existing `watched_at_check` DB constraint (`schema.ts:122-125`), and
`videos.createdAt` is `.notNull()` — so Watched's and Ignored's cursor columns can never be
null. `videos.publishedAt` is nullable in the schema, but `src/lib/rss.ts:10,29-30` shows
every ingested video is written with a real `Date` — a malformed feed `pubDate` drops the
whole RSS entry before it's ever inserted, it never produces a stored row with a null
`publishedAt`. This is treated as a practical invariant (not DB-enforced, but true of every
row ingestion can ever produce) — the cursor/orderBy logic below does not special-case
`NULL`. Concrete failure mode if this invariant is ever violated (e.g. a future non-RSS
insert path, or a test fixture that omits it): SQLite evaluates `publishedAt < cursor.at`
as `NULL`/false when `publishedAt` is `NULL`, so that row would silently stop appearing in
pagination past whichever page it was first returned on, rather than erroring — worth
knowing if a "video that's in the DB but never shows up past page 1" bug ever gets
reported.

### Query changes

All four list functions in `src/routes/queue.tsx` gain a `cursor` parameter and return
`{ rows, nextCursor }` instead of a bare array — `nextCursor` is `undefined` exactly when
there is no further page, so callers never need a separate `hasMore` boolean: "render the
sentinel" is simply "`nextCursor` is defined." `queueVideos` (`queue.tsx:26-62`) becomes:

```ts
function queueVideos(
  userId: number,
  sort: "newest" | "oldest",
  categoryId: number | undefined,
  cursor: { at: Date; id: number } | undefined,
) {
  const fetched = db
    .select({ /* unchanged */ })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        inArray(videos.status, ["unwatched", "watching"]),
        ...(categoryId !== undefined ? [eq(subscriptions.categoryId, categoryId)] : []),
        ...(cursor
          ? [
              sort === "oldest"
                ? or(
                    gt(videos.publishedAt, cursor.at),
                    and(eq(videos.publishedAt, cursor.at), gt(videos.id, cursor.id)),
                  )
                : or(
                    lt(videos.publishedAt, cursor.at),
                    and(eq(videos.publishedAt, cursor.at), lt(videos.id, cursor.id)),
                  ),
            ]
          : []),
      ),
    )
    .orderBy(
      ...(sort === "oldest"
        ? [asc(videos.publishedAt), asc(videos.id)]
        : [desc(videos.publishedAt), desc(videos.id)]),
    )
    .limit(PAGE_SIZE + 1)
    .all();

  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    hasMore && lastRow && lastRow.publishedAt !== null
      ? { at: lastRow.publishedAt, id: lastRow.id }
      : undefined;

  return { rows, nextCursor };
}
```

Fetching `PAGE_SIZE + 1` and slicing is how "is there a next page" is determined without a
separate `COUNT` query. `orderBy` must include `id` as an explicit secondary key, matching
the cursor's tuple exactly — not just in the `WHERE` comparison — because two rows sharing
an identical `publishedAt`/`watchedAt`/`createdAt` would otherwise have no guaranteed stable
relative order between page 1 and page 2, which could silently skip or duplicate a row
across the page boundary.

`nextCursor`'s computation uses an explicit `rows.length > 0 ? rows[rows.length - 1] :
undefined` check rather than `rows.at(-1)` or a non-null assertion — this project's
`tsconfig.json` has `noUncheckedIndexedAccess` on, and `CLAUDE.md` specifically flags this
exact class of `tsc --noEmit`-only-visible gotcha (a prior `match[1]: string | undefined`
slipped past `bun test`/`bun run lint` across multiple commits in spec005/006). The
`lastRow.publishedAt !== null` check exists purely to satisfy the type checker given the
column's nullable schema type — per the NULL-handling invariant above, this branch is not
expected to actually be reached in practice; if it somehow were, the practical effect is
that the sentinel is omitted one page earlier than `hasMore` would suggest (the list
appears to end at that point rather than crashing), which is an acceptable degradation of
an already-documented edge case, not a new failure mode this design introduces.

Placing `nextCursor` construction *inside* each list function (rather than, say, in the
route handler or the view component) matters: each function is the only place that already
knows which sort column it's keyed on, so the alternative — recomputing "which field is the
cursor" once per call site (4 routes) and again in the view layer — would duplicate
per-view logic that belongs in exactly one place. Every downstream consumer (routes, view
components) treats `nextCursor` as an opaque value to forward, never inspects or rebuilds
it.

New imports needed in `queue.tsx`: `gt`, `lt`, `or` from `drizzle-orm` (currently imports
`and, asc, desc, eq, inArray, isNull`).

The other three functions follow the identical shape (including `nextCursor` construction)
with these deltas:
- **`continueWatchingVideos`** (`queue.tsx:64-94`): no `sort` param (fixed
  `desc(publishedAt), desc(id)` only), cursor on `(publishedAt, id)`, status filter
  `eq(videos.status, "watching")`.
- **`watchedVideos`** (`queue.tsx:96-131`): order `desc(watchedAt), desc(id)`; cursor on
  `(watchedAt, id)`; status filter `eq(videos.status, "watched")`; unchanged — still no
  `isNull(subscriptions.unsubscribedAt)` filter (true history, per the existing comment at
  `queue.tsx:117-123`); no `publishedAt !== null` guard needed since `watchedAt` is
  DB-guaranteed non-null here (see NULL-handling invariant above).
- **`ignoredVideos`** (`queue.tsx:133-162`): order `desc(createdAt), desc(id)`; cursor on
  `(createdAt, id)`; status filter `eq(videos.status, "ignored")`; no null guard needed
  (`createdAt` is `.notNull()`).

### New DB indexes

Three composite indexes on `videos`, one per distinct filter+sort shape above (Queue and
Continue Watching share one):

```ts
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
// ...
export const videos = sqliteTable(
  "videos",
  { /* unchanged columns */ },
  (t) => [
    check("status_check", /* unchanged */),
    check("ignore_method_check", /* unchanged */),
    check("watched_at_check", /* unchanged */),
    index("videos_status_published_idx").on(t.status, t.publishedAt, t.id),
    index("videos_status_watched_idx").on(t.status, t.watchedAt, t.id),
    index("videos_status_created_idx").on(t.status, t.createdAt, t.id),
  ],
);
```

Generate the migration with `bun run db:generate` (via the devcontainer, per
`CLAUDE.md`'s `devcontainer exec` requirement) once the schema change lands. This is a
purely additive `CREATE INDEX` — no table/column rename — so it should not hit the
`drizzle-kit generate` interactive disambiguation prompt `CLAUDE.md` warns about
(confirmed not a rename scenario; if it unexpectedly does prompt, hand the exact command to
the user per that same note, don't work around it with a pty wrapper).

**Caveat confirmed via `EXPLAIN QUERY PLAN`:** `videos_status_published_idx` gives
Continue Watching, Watched, and Ignored a pure index-ordered scan for their single-status
`eq()` filters — no separate sort step. Queue's filter is `inArray(status, ["unwatched",
"watching"])`, not a single equality, and SQLite cannot merge two per-status index range
scans in already-sorted order — it still does `USE TEMP B-TREE FOR ORDER BY` even with the
index present. The index still avoids a full table scan (each status branch is range-scanned,
not scanned in full), which is the actual win being claimed here, but it does **not** give
Queue's paginated fetch the same "no sort cost" property the other three views get — worth
knowing rather than assuming pagination fully solved Queue's per-page cost the way it does
for the others.

### Route/handler changes: full page vs. load-more fragment

Each of the four `GET` routes (`/queue`, `/continue-watching`, `/watched`, `/ignored`,
`queue.tsx:260-345`) parses `cursor`/`cursorId` and branches:

- **No cursor (first visit)** — unchanged shape: `c.html(<Layout>...<QueueList /></Layout>)`,
  but `QueueList` now receives only the first page's rows (≤20) and the `nextCursor` value
  returned alongside them, and renders a `LoadMoreSentinel` as the last grid child when
  `nextCursor` is defined.
- **Cursor present (htmx load-more request)** — return only the next batch: new cards plus
  a new `LoadMoreSentinel` (or nothing if `nextCursor` comes back `undefined`) — no
  `<Layout>`, nothing from the already-rendered pages re-sent. This mirrors the existing
  pattern where `POST /videos/:id/toggle` etc. already return a bare partial with no
  `<Layout>`.

Each route passes the list function's `nextCursor` straight through to `QueueList`/
`QueueListMore` as a prop, unmodified — it's already an opaque `{ at: Date; id: number } |
undefined` value by the time it leaves the query function (see "Query changes" above),
so no route handler needs to know which column it came from.

`LoadMoreSentinel` sets `hx-target="this" hx-swap="outerHTML"` explicitly — htmx's defaults
are target=self, swap=`innerHTML`, and without an explicit `outerHTML` override each
load-more response would nest inside the previous sentinel instead of replacing it and
appending the new cards as siblings.

### `QueueList` / card rendering restructuring (`src/views/queue-list.tsx`)

Two changes support both (a) a load-more response with no wrapping `#queue-list` div and
(b) per-card `id`s so the action handlers below can target/replace a single card:

1. Every card gains a stable `id={`video-${row.id}`}` (all four `props.view` branches) —
   currently only a JSX `key`, no DOM id.
2. The three inline `.map()` branches inside `QueueList` are extracted into standalone
   per-row card functions — `queueCard(row, view, sort, category)`, `watchedCard(row,
   category)`, `ignoredCard(row, category)` — each returning one card's JSX.
   `QueueList`/`QueueListMore`'s props gain `nextCursor: { at: Date; id: number } |
   undefined` (forwarded opaquely from the route, per "Route/handler changes" above).
   When `nextCursor` is defined, the component builds the sentinel's href itself by calling
   the `build*Href` function matching its own `props.view` (already known — the same
   discriminator that picks which card-rendering branch runs) with `nextCursor` as that
   function's new cursor argument, from `src/lib/queue-urls.ts` (extended in a prior step
   to accept it). `QueueList` becomes a thin wrapper: `<div id="queue-list">
   {rows.map(cardFn)}{sentinelHref && <LoadMoreSentinel href={sentinelHref} />}</div>`. A
   new export, `QueueListMore`, renders the bare `rows.map(cardFn)` + sentinel with **no**
   wrapping div, for the load-more fragment response. Both call the same per-row
   functions — exactly one JSX implementation per card shape — which is also what lets the
   action handlers below reuse identical markup for a single-card swap response instead of
   a second hand-maintained copy.

### Action handlers: single-card update-or-delete instead of full-list re-fetch

`POST /videos/:id/toggle`, `/ignore`, `/unignore` (`queue.tsx:395-467`) stop calling
`queueVideos()`/`continueWatchingVideos()`/`ignoredVideos()` to re-render the whole list —
a full-list re-swap would otherwise collapse a scrolled-down paginated view back to page 1
on every action. Instead:

- Each card's action buttons change `hx-target` from `#queue-list` to the card itself:
  `hx-target={`#video-${row.id}`}`, keeping `hx-swap="outerHTML"` as the button's static
  default.
- **`/ignore` and `/unignore`**: the video unconditionally leaves the view it's being acted
  on from (Ignore always removes from Queue/Continue Watching; Un-ignore always removes
  from Ignored). The handler returns an empty `200` body with response header
  `HX-Reswap: delete` — htmx's `delete` swap style removes the *target* element regardless
  of response body, so no re-render or lookup is needed beyond the mutation itself.
- **`/toggle`**: branches purely on `toggleQueueStatus`'s **resulting** `status`
  (`{ status: "watched" | "unwatched" }`, `src/lib/watch-status.ts:33-58`) — not on any
  assumption about what the video's status was before the toggle. This matters because the
  Queue page a user is looking at can go stale: e.g. a video is `watching` when Queue
  renders, gets separately marked `watched` from another tab via `/videos/:id/watched-toggle`,
  and the still-open Queue tab's toggle button (still wired to `/videos/:id/toggle?view=queue`)
  is then clicked — `toggleQueueStatus` reads `current.status === "watched"` and produces
  `nextStatus === "unwatched"`, a transition the naive "Queue only ever shows
  unwatched/watching, so `watched→unwatched` can't happen here" reasoning would wrongly
  call impossible. Branching on the *outcome* rather than the assumed prior state sidesteps
  this entirely — an `unwatched` outcome always belongs in Queue/never belongs in Continue
  Watching regardless of what it transitioned from, and a `watched` outcome always leaves
  both:
  - `result.status === "watched"`: leaves both Queue (`unwatched ∪ watching` only) and
    Continue Watching (`watching` only) → `HX-Reswap: delete`, empty body, for either view.
  - `result.status === "unwatched"`: leaves Continue Watching (`watching` only) →
    `HX-Reswap: delete` when `view=continue-watching`. Stays in Queue
    (`unwatched ∪ watching` still matches) when `view=queue` → no reswap override (falls
    back to the button's static `hx-swap="outerHTML"`), body is a freshly-queried single
    card for the row's new `unwatched` state (drops the "▶ Watching" badge, button label
    flips from "Mark Unwatched" to "Mark Watched").

  The one re-render branch (`view=queue`, outcome `unwatched`) needs more than
  `toggleQueueStatus`'s return value provides — that function returns only `{ status }`,
  not `title`/`youtubeVideoId`/`channelName`/`categoryName`, and neither the path param
  (`id`) nor the query params (`view`/`sort`/`category`) carry them either. This needs a
  new single-row query, e.g. `queueRowById(id: number)` in `queue.tsx`, running the same
  `videos`/`youtubeChannels`/`subscriptions`/`categories` join `queueVideos` uses but
  scoped to `eq(videos.id, id)` with no cursor/limit — called once, after the mutation, only
  on this one branch. (The existing `videoForWatchingPage`, `queue.tsx:241-252`, is not a
  fit as-is — it selects only `id, youtubeVideoId, title, status`, missing the
  channel/category columns `queueCard` needs.)

This removes the `/ignore` and `/unignore` handlers' dependency on
`continueWatchingVideos`/`queueVideos`/`ignoredVideos` entirely, and reduces `/toggle`'s
dependency to the new single-row `queueRowById` lookup on exactly one outcome branch,
instead of a full-list re-fetch on every action.

### Sort/category interaction

Changing `?sort=` or `?category=` is a full-page navigation via the existing links
(unchanged), which always omits `cursor`/`cursorId` — so it naturally starts a fresh first
page. Each `LoadMoreSentinel`'s href carries forward whatever `sort`/`category` produced
the page it's attached to, so scrolling can never silently drift to a different
filter/sort than what's currently on screen.

### Testing implications

`test/routes/queue.test.ts` (currently ~1444 lines, seeds a handful of rows per test,
asserts against full unbounded responses) needs:
- New coverage seeding more than `PAGE_SIZE` rows for at least one view, to exercise the
  page-1/page-2 boundary and confirm the sentinel is present/absent at the right point.
- Assertions that a load-more request (`cursor`/`cursorId` params) returns exactly the next
  page with no overlap or gap against page 1.
- A test confirming the `id` secondary sort actually disambiguates two videos sharing an
  identical `publishedAt`/`watchedAt`/`createdAt` across a page boundary.
- Updated assertions wherever an existing test currently checks that a toggle/ignore/
  unignore response contains the *entire* list — those now assert either a single-card
  fragment or an empty body + `HX-Reswap: delete` header.

## Open Questions

None outstanding. `docs/features/009-endless-scroll.md`'s scoping conversation resolved the
mechanism-level questions (cursor- vs. offset-based pagination, view scope, Queue live-
update scope, index bundling, back-navigation tradeoff, single-card vs. full-list action
re-render). Writing this spec resolved the remaining implementation-level ambiguities the
feature file didn't need to cover: the exact cursor param encoding, the `NULL`-handling
invariant for `publishedAt`, the `id` secondary-sort-key correctness requirement, and the
`HX-Reswap: delete` mechanism for the toggle/ignore/unignore handlers' now-conditional
re-render behavior.

**Red-team retrospective:** One independent pass (subagent, no memory of the drafting
conversation, given the draft spec and the actual source files to verify claims against)
found one substantive implementability gap and several smaller corrections, all fixed
directly above: (1) the `/toggle` handler's re-render branch as originally drafted claimed
it needed no fresh query, but `toggleQueueStatus`'s return value and the request's own
params don't carry the row data `queueCard` needs — fixed by adding a new `queueRowById`
single-row query, called on exactly the one branch that re-renders; (2) the original
branching logic assumed Queue's `watched→unwatched` toggle transition was structurally
impossible, which a concurrent-tab scenario disproves — fixed by rewriting the branch logic
to key off `toggleQueueStatus`'s resulting status rather than an assumed prior state, which
also incidentally simplified the logic; (3) the Scope section's justification for deferring
sentinel styling cited `docs/app_idea.md`'s *Path to v1.0* Styling step as "still-upcoming,"
which is stale — that step (and its spec018 follow-up) already shipped — corrected to cite
only the still-valid spec009 precedent; (4) the new composite indexes' benefit was
overstated for Queue specifically — `EXPLAIN QUERY PLAN` confirms Queue's `inArray` status
filter still forces a temp-B-tree sort even with the index present, unlike the other three
views' single-status `eq()` filters, which get a pure index-ordered scan — corrected with an
explicit caveat; (5) the `LoadMoreSentinel`'s own `hx-target`/`hx-swap` were unspecified,
defaulting to htmx's self/innerHTML behavior rather than the needed outerHTML replacement —
made explicit; (6) `rows.at(-1)` would silently reintroduce the exact
`noUncheckedIndexedAccess` gotcha `CLAUDE.md` already documents biting a prior spec — noted
to use an explicit length check instead; (7) the `publishedAt`-never-null invariant lacked
a stated failure mode if ever violated — added. The pass also confirmed as accurate: every
file:line citation against the actual source, the compound cursor `WHERE`-clause logic
(traced through a concrete shared-timestamp example with no skip/duplicate), that
`index()` is a valid, installed Drizzle export usable in this schema's existing
`(t) => [...]` pattern, that `HX-Reswap: delete` and `hx-trigger="revealed"` are both real,
correctly-described htmx APIs, and that no other call site anywhere in `src/`/`test/`
depends on the four list functions' or `QueueList`'s current signatures. No second full
pass was run — the findings were concrete corrections with clear fixes, not new design
questions requiring further review.

**Decomposition-review retrospective (from `/spec-tasks`):** breaking this spec into
`docs/specs/tasks/019-endless-scroll.md` surfaced one real content gap rather than a pure
task-ordering issue: the original Design left "how the sentinel's next-page href gets
built" underspecified — the list functions returned a separate `hasMore` boolean with no
stated owner for computing the actual cursor values from the last row, which would have let
an implementer duplicate that per-view logic across four route handlers and/or the view
layer. Fixed by having each list function return `{ rows, nextCursor }` directly
(`nextCursor` replaces `hasMore` — "is there a next page" is just "is `nextCursor`
defined") with the last-row/cursor computation done once, in the one place that already
knows its own sort column, and treated as an opaque value by every downstream consumer.
"Query changes," "Route/handler changes," and the `QueueList` restructuring section above
reflect the corrected shape.
