---
status: promoted
created: 2026-08-10
promoted_to: docs/specs/019-endless-scroll.md
---

# Endless Scroll for Video List Views

## Problem / Motivation

Watched, Ignored, Queue, and Continue Watching all currently run a single unbounded query
(no `LIMIT`/`OFFSET` anywhere) and render every matching row on every visit. In practice
this is already hundreds of rows per view (536 in Watched, several hundred in Ignored on
the reporter's own instance) with no natural upper bound, especially for Watched. This
wastes both page-load work on the client and DB/query cost on the server for views that are
mostly scrolled past, not read in full. This exact gap was already identified and
deliberately deferred in spec 004 as a future "endless scroll queue"-shaped spec covering
all views at once — this feature file is that spec.

## Firm Scope

- Cursor-based pagination applied uniformly to all four views that share
  `src/routes/queue.tsx` + `src/views/queue-list.tsx`: Queue, Continue Watching, Watched,
  and Ignored.
- Page size: up to 20 videos per batch.
- Loading pattern: htmx `hx-trigger="revealed"` on a sentinel element near the end of the
  currently-loaded list, `hx-get` back to the same route with a cursor param, response is
  the next batch of cards plus a fresh sentinel — or no sentinel if that batch was the last
  page (end of list). No client-side JS beyond htmx.
- Cursor is a compound `(sortColumn, id)` tuple, matching each view's existing sort (the
  `id` tiebreaker is required because `publishedAt`/`watchedAt`/`createdAt` are nullable
  and/or not unique alone):
  - Queue / Continue Watching: `(publishedAt, id)`
  - Watched: `(watchedAt, id)`
  - Ignored: `(createdAt, id)`
- The cursor composes with Queue's existing sort toggle (`?sort=oldest|newest`) and the
  existing category filter (spec 006) — both must be carried through the load-more URL, and
  changing either resets pagination back to page 1 (new query, new cursor).
- Initial page load for all four views is also limited to the first page (~20 rows), not
  the full unbounded result — this changes first-paint behavior, not just subsequent
  scrolling.
- Add DB indexes supporting each view's `(status, sortColumn, id)` filter+sort combination —
  none of `status`/`publishedAt`/`watchedAt`/`createdAt` have indexes today beyond primary
  keys and the `youtubeVideoId` unique constraint, so cursor pagination without one would
  just move the full-table-scan cost from render-time to every subsequent page fetch.
- The `POST /videos/:id/toggle`, `/ignore`, and `/unignore` handlers switch from
  re-fetching and re-rendering the entire list to swapping only the single affected card in
  place. Requires giving each rendered card a stable DOM id (currently only a React `key`,
  no id). Without this change, any toggle/ignore/unignore action while scrolled deep would
  collapse the view back to a fresh page 1, discarding every batch loaded beyond it.

## Explicitly Out of Scope

- Any live-push mechanism for Queue (polling, SSE, WebSockets) to surface newly-ingested
  videos without a reload. Confirmed during scoping: Queue does not live-update today at
  all — the scheduler's 1-minute tick just drains due channels (each channel itself is only
  actually re-polled roughly hourly, jittered), and new rows simply sit in the DB until the
  next full page load. This feature deliberately preserves that behavior: reload picks up
  new arrivals at the top, scroll loads older ones below. Cursor-based pagination is
  naturally immune to any inconsistency from concurrent inserts (a new row above the cursor
  never intrudes into an already-fetched range), so no new real-time mechanism is needed to
  make pagination itself correct.
- A "new videos available" banner/indicator for a user who is scrolled down when new videos
  land. Considered and declined — out of scope for this feature, could be a future one.
- History/back-navigation state preservation (e.g. via `hx-push-url` restoring all
  previously-loaded batches on back-navigation). Accepted limitation: a user who scrolls
  several batches deep, navigates away, and returns via the browser back button will land
  back on a fresh page 1, not their prior scroll position.

## Related Specs / Code

- `docs/specs/004-watch-flow-queue-views.md` (Out of scope section, and Open Questions) —
  originally deferred this exact scope as a future "endless scroll queue"-shaped spec
  covering queue/Continue Watching/Watched at once; this feature also folds in Ignored
  since it shares the same route file/component.
- `docs/specs/006-category-queue-filtering.md` — category filter composes with sort via
  query params on Queue today; pagination must carry both through unchanged.
- `docs/specs/009-unwatched-counters-and-category-links.md` — nav-badge, category-row, and
  channel-row unwatched counts are fully independent `COUNT(*)` queries
  (`src/lib/nav-counts.ts`, `src/lib/categories.ts`, and the analogous channel count in
  `src/routes/channels.tsx`) and do **not** depend on the four list functions' full-array
  return value or length — confirmed safe to add `LIMIT`/cursor logic to those functions
  without affecting any counter/badge.
- `src/routes/queue.tsx` — `queueVideos`/`continueWatchingVideos`/`watchedVideos`/
  `ignoredVideos` (~lines 26-162), currently single unbounded Drizzle queries terminated
  with `.all()`, no `LIMIT`/`OFFSET`. Also the `POST /videos/:id/toggle` (~395-422),
  `/ignore` (~424-451), and `/unignore` (~453-467) handlers, which currently re-fetch the
  full list and swap the entire `#queue-list` div.
- `src/views/queue-list.tsx` — shared `<QueueList>` rendering component (~lines 107-255);
  cards are currently keyed by React `key` only, with no DOM `id` to target individually.
- `src/lib/scheduler.ts` (`TICK_INTERVAL_MS` = 1 minute, `BATCH_SIZE` = 5 channels/tick) and
  `src/lib/ingest.ts` (`BASE_INTERVAL_MS` = 1 hour ± jitter per channel) — background
  ingestion cadence, confirms Queue has no live-update mechanism today.
- `src/db/schema.ts` — `videos` table (~lines 91-127): `publishedAt`, `watchedAt` nullable;
  `createdAt`; no indexes beyond primary key and the `youtubeVideoId` unique constraint.
- `drizzle/` — migrations directory; new indexes will need a migration.
- `test/routes/queue.test.ts` — existing tests assert on rendered HTML content (title/href
  presence and ordering), no JSON API shape, and no row-count/limit assertions yet — will
  need new coverage for page-boundary behavior and the load-more request/response shape.

## Resolved Decisions

- **Scope includes Continue Watching, not just Queue/Watched/Ignored.** It shares the same
  route file and `<QueueList>` component as the other three, and was named alongside them
  in spec 004's original deferred note — no reason to special-case it out.
- **No "new videos available" affordance for Queue.** Queue doesn't live-update today (no
  polling/SSE/WS) — this feature deliberately preserves the current "reload to see new
  arrivals" behavior rather than adding new real-time UX, keeping scope to the pagination
  mechanism itself.
- **Cursor-based pagination, not `LIMIT`/`OFFSET`.** Offset-based pagination can
  duplicate or skip a row if a background tick inserts a new video into Queue while a user
  is mid-scroll, because rows shift position under an absolute offset. Cursor-based
  pagination anchors each request to a specific `(sortColumn, id)` position instead, so a
  new row landing above the cursor never intrudes into an already-fetched range — correct
  by construction, with no special-casing needed for Queue vs. the other three views.
- **DB indexes are bundled into this feature, not deferred.** None of
  `status`/`publishedAt`/`watchedAt`/`createdAt` have indexes today; adding cursor
  pagination without one would just move the full-table-scan cost from initial render to
  every subsequent page fetch, while touching these exact queries is the natural time to
  add it.
- **Back-navigation scroll/page-state loss is an accepted limitation.** A deep-scrolled
  view resetting to page 1 after navigating away and back is not solved in this feature;
  revisit later only if it proves genuinely annoying in practice.
- **Toggle/ignore/unignore actions swap only the single affected card**, via a new stable
  per-card DOM id, instead of re-fetching and re-rendering the entire list. A full-list
  re-swap would otherwise collapse a scrolled-down paginated view back to page 1 on every
  action — confirmed as a real regression risk by reading the current handlers, not a
  hypothetical.
