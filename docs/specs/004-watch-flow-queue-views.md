---
status: draft
created: 2026-07-24
---

# Watch Flow & Queue Views

## Context

Spec003 made ingestion real — `videos` rows now exist for subscribed channels — but
nothing in the app renders them. This spec is MVP item 3 in `docs/app_idea.md`: the
three-state watch status (`unwatched | watching | watched`), the click-to-watch UX
through a dedicated Watching page, and the queue views (default queue, Continue
Watching) that make ingested videos actually visible and actionable.

Two adjacent pieces of MVP item 3/6 are deliberately out of scope here and pushed to a
future spec (see Scope): the `ignored` status (manual ignore action, Ignored view,
IgnoreRule keyword matching — MVP item 6) and category-based filtering/grouping of the
queue (the product doc's stated key differentiator, but a separable UX layer once the
flat queue and status transitions are proven out). Both were confirmed explicitly during
scoping rather than assumed.

Video watch status remains a single column on `Video`, not per-user — spec002's Context
already established this is intentionally deferred to a real multi-user spec, and
nothing here changes that.

A **Watched** view was added to this spec's scope after the initial draft — it isn't
defined anywhere in `docs/app_idea.md` (only the default queue, Continue Watching, and
Ignored views are). It's confirmed as a true watch history: unlike the other two views
(scoped to actively-subscribed channels), Watched must keep showing a video even after
its channel is unsubscribed, since spec002 already guarantees video rows and their
watch state survive unsubscribe — a history view that silently dropped entries the
moment you unsubscribed wouldn't actually be a history.

## Scope

**In:**
- Three-state watch status transitions per `docs/app_idea.md`'s Watch Flow section:
  click-to-watch (opens YouTube in a new tab, navigates the app to a Watching page),
  the 10-second client-side auto-Watching timeout (not persisted server-side if
  interrupted), and the Watching page's three actions (Mark Watching / Mark
  Watched-or-Unwatched & Return to Queue / Return to Queue).
- Manual status toggle on the queue page itself (flips Watched↔Unwatched; clears
  Watching→Unwatched).
- `GET /queue` — default queue view: Unwatched ∪ Watching, newest-to-oldest by default
  with a toggle to invert.
- `GET /continue-watching` — Watching-only view.
- Filtering both of the above to videos belonging to channels the current user is
  **actively** subscribed to (an unsubscribed channel's videos must not reappear in the
  queue, even though spec002 guarantees they're never deleted).
- `GET /watched` — true watch-history view: all `watched` videos regardless of current
  subscription status, sorted most-recently-watched-first. Requires a new nullable
  `videos.watchedAt` timestamp column (see Design) since nothing currently records
  *when* a video was watched.
- "Smart" return-to-origin navigation from the Watching page: both "Return to Queue"
  and "Mark Watched/Unwatched & Return to…" navigate back to whichever of the three
  views (queue, Continue Watching, Watched) the video was actually opened from, not a
  hardcoded `/queue`, and the queue view's current sort order round-trips too.
- A minimal top nav in `layout.tsx` (Categories / Channels / Queue / Continue Watching /
  Watched) so the new pages are reachable through the UI, not just by typing a URL.

**Out (deferred):**
- `ignored` status, manual ignore action, the Ignored view, and IgnoreRule
  keyword/auto-ignore matching — all of MVP item 6, deferred to its own future spec
  (confirmed during scoping: builds manual ignore and IgnoreRule together as one
  feature, since they share the same reconciliation logic).
- Category-based filtering/grouping of the queue — confirmed during scoping as a
  separate follow-up once the flat queue is proven out.
- Auth/CSRF on the new routes — same posture as spec002/003, single implicit user,
  deferred to the auth spec.
- Per-user watch status — out of scope per spec002's Context, unchanged here.
- Pagination/infinite-scroll on any of the three views — the Watched view especially
  has no natural upper bound the way the queue does, but this is deferred to its own
  future "endless scroll queue"-shaped spec covering all views at once, rather than
  bolted onto just one of them here.
- An inline un-watch/toggle action on the Watched view's rows — it's click-through only
  (title still links to `/watching/:id`, which already has an unmark-watched action).
  Confirmed during scoping: keeps this view's row markup simpler (no
  toggle-and-re-render-list plumbing) since it's browse/history, not an actionable
  queue.

## Design

### Schema addition: `videos.watchedAt`

```ts
export const videos = sqliteTable("videos", {
  // ...existing columns...
  watchedAt: integer("watched_at", { mode: "timestamp" }), // null unless status === "watched"
});
```

Plain additive `ALTER TABLE ADD COLUMN`, same shape as spec003's
`lastFetchedAt`/`nextFetchDueAt` addition — no FK retarget, no table recreation.
`watchedAt` is kept in lockstep with `status` rather than derived: set to `now()` the
moment a video *becomes* `watched`, and cleared back to `null` the moment it stops being
`watched` (un-marked, or re-entered via a rewatch). It's never meaningful for a video
that isn't currently `watched`, so there's no "last time this was watched" retained
across a watched→unwatched→watched cycle — the Watched view only ever lists currently-
`watched` videos anyway, so this doesn't lose any information the view could show.

### Watch status transitions (`src/lib/watch-status.ts`)

Two functions cover every transition described in `docs/app_idea.md`'s Watch Flow
section — no separate "clear to unwatched" function, since that's just one branch of
the same toggle used by both the queue page and the Watching page's second button:

```ts
export function setWatching(videoId: number): { status: "watching" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  db.update(videos).set({
    status: "watching",
    // Only touches watchedAt on the watched -> watching branch (the rewatch flow via
    // the Watching page's "Mark Watching" button) -- the other two source states
    // (unwatched, watching) already have it null, so leaving the key out of `set`
    // avoids a redundant write on the far more common non-rewatch path.
    ...(current.status === "watched" ? { watchedAt: null } : {}),
  }).where(eq(videos.id, videoId)).run();

  return { status: "watching" };
}

export function toggleWatchStatus(videoId: number): { status: "watched" | "unwatched" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  // unwatched -> watched
  // watched   -> unwatched
  // watching  -> unwatched   (the *only* path back from Watching, per app_idea.md)
  const nextStatus = current.status === "unwatched" ? "watched" : "unwatched";

  db.update(videos).set({
    status: nextStatus,
    watchedAt: nextStatus === "watched" ? new Date() : null,
  }).where(eq(videos.id, videoId)).run();

  return { status: nextStatus };
}
```

Both live in one module since they're the only two writes to `videos.status` this spec
introduces, and both are simple enough not to warrant a route-level split of logic vs.
query.

### Queue queries (`src/routes/queue.tsx`)

Following `channels.tsx`'s existing convention (query helpers live next to the route,
not in a separate lib file), scoped to the current user's **active** subscriptions —
this is the piece that isn't explicit in `docs/app_idea.md` but is necessary: without
it, an unsubscribed channel's preserved video history would leak back into the queue.

```ts
function queueVideos(userId: number, sort: "newest" | "oldest") {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      publishedAt: videos.publishedAt,
      status: videos.status,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(and(
      eq(subscriptions.userId, userId),
      isNull(subscriptions.unsubscribedAt),
      inArray(videos.status, ["unwatched", "watching"]),
    ))
    .orderBy(sort === "oldest" ? asc(videos.publishedAt) : desc(videos.publishedAt))
    .all();
}

function continueWatchingVideos(userId: number) {
  // Same query, status filter narrowed to ["watching"] only, fixed newest-first order
  // (app_idea.md's sort-invert toggle is only specified for the default queue view;
  // Continue Watching is expected to be a short list where it matters less — flag if
  // that turns out wrong once it's visible in a browser).
}

function watchedVideos(userId: number) {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      watchedAt: videos.watchedAt,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(and(
      eq(subscriptions.userId, userId),
      eq(videos.status, "watched"),
      // Deliberately NO isNull(subscriptions.unsubscribedAt) filter here, unlike
      // queueVideos/continueWatchingVideos above -- this is true history, so a
      // channel's watched videos must keep showing even after unsubscribing. The
      // join still resolves a category, since spec002's unsubscribe only soft-deletes
      // the subscriptions row (sets unsubscribedAt) rather than removing it -- MVP's
      // single-user unique(userId, youtubeChannelId) constraint guarantees exactly one
      // such row per channel this user has ever subscribed to, active or not.
    ))
    .orderBy(desc(videos.watchedAt))
    .all();
}
```

Since both queue views only ever show `unwatched`/`watching` videos, a queue row's
toggle button only ever needs two labels: **"Mark Watched"** (unwatched rows) or
**"Clear to Unwatched"** (watching rows) — `watched` never appears in either list, so
that third transition is never rendered here (it only shows up on the Watching page).

### Routes (`src/routes/queue.tsx`)

- `GET /queue?sort=newest|oldest` (default `newest`) — full page.
- `GET /continue-watching` — full page.
- `GET /watched` — full page. No sort param (see Scope) — always most-recently-watched-first.
- `GET /watching/:id?from=queue|continue-watching|watched&sort=newest|oldest` — Watching
  page for one video (`videos.id`, matching the existing `:id`-is-internal-PK convention
  from `subscriptions.tsx`). 404 if the video doesn't exist. No subscription-active check
  here — a direct link to a video you've since unsubscribed from should still resolve;
  only the queue *listings* are subscription-scoped. `from`/`sort` feed the return-to-origin
  navigation below; `sort` is only meaningful when `from=queue`.
- `POST /videos/:id/watching` — calls `setWatching`. Used by both the explicit "Mark
  Watching" button and the auto-timeout element below. Response: re-renders a small
  `<span id="watch-status-badge">` partial reflecting the new status (`hx-swap="outerHTML"`),
  not a full page reload — the Watching page's button labels don't need to change on this
  transition (see below), so there's nothing else to update.
- `POST /videos/:id/watched-toggle?from=...&sort=...` — calls `toggleWatchStatus`. Plain
  (non-HTMX) form POST (the `from`/`sort` context travels as query params on the form's
  `action` URL, no hidden fields needed), responds with a 303 redirect computed by
  `resolveReturnTarget` below — **not** a hardcoded `/queue`. Deliberately a real browser
  navigation rather than an HTMX partial swap: navigating away destroys any still-pending
  10-second auto-Watching timer on the page being left, which is what makes "not
  persisted if interrupted" hold without any extra client-side cancellation code.
- `POST /videos/:id/toggle?view=queue|continue-watching&sort=newest|oldest` — calls
  `toggleWatchStatus`, used by the queue/continue-watching row toggle (the Watched view
  has no inline toggle — see Scope). HTMX partial: re-renders and returns the whole list
  partial for the given `view`/`sort` (not just the one row), because toggling can remove
  the row from its current view entirely (e.g. toggling an Unwatched row to Watched
  removes it from both queue views). `view`/`sort` travel as query params on each row's
  own `hx-post` URL rather than a shared page-level default, so each row's toggle always
  re-renders the exact list it's currently sitting in.

### Return-to-origin navigation (`src/routes/queue.tsx`)

A small allow-list, not a raw pass-through of the `from` query param — `from` only ever
selects among three fixed internal paths, so there's no actual open-redirect exposure
either way, but validating and falling back to `queue` on anything unrecognized (missing
`from`, a hand-typed/bookmarked `/watching/:id` with no query string, a stale value)
keeps the fallback behavior a single, explicit, intentional branch rather than implicit
`undefined`-handling scattered across the two call sites:

```ts
const RETURN_VIEWS = {
  queue: { label: "Queue", path: (sort?: string) => `/queue${sort === "oldest" ? "?sort=oldest" : ""}` },
  "continue-watching": { label: "Continue Watching", path: () => "/continue-watching" },
  watched: { label: "Watched", path: () => "/watched" },
} as const;

function resolveReturnTarget(from: string | undefined, sort: string | undefined) {
  const key = from !== undefined && from in RETURN_VIEWS ? (from as keyof typeof RETURN_VIEWS) : "queue";
  const entry = RETURN_VIEWS[key];
  return { url: entry.path(sort), label: entry.label };
}
```

Used by:
- `GET /watching/:id` to render the "Return to Queue" link's `href` and the
  "Mark Watched…" button's label/`action`, both via `resolveReturnTarget(from, sort).url`
  / `.label`.
- `POST /videos/:id/watched-toggle` to compute the 303 redirect target.

Each view's row links carry the query params that make this work: `/queue` rows link to
`/watching/:id?from=queue&sort={currentSort}`, `/continue-watching` rows link to
`/watching/:id?from=continue-watching`, `/watched` rows link to
`/watching/:id?from=watched`.

### Click-to-watch (`src/views/queue-list.tsx`)

A row's title links to `/watching/:id?from=<view>[&sort=<sort>]` (per Return-to-origin
navigation above) and must also open the real YouTube URL in a new tab. `title`/video IDs are untrusted external RSS content, so this is built as a plain
anchor with the target URL in a `data-` attribute (JSX/Hono's attribute-value escaping
is sufficient here) plus one small unobtrusive listener in `layout.tsx`, **not** an
inline `onclick="window.open('...')"` with the video ID string-concatenated into a JS
string literal — that would let a crafted video ID break out of the JS string inside the
attribute, which HTML-attribute escaping alone doesn't guard against:

```html
<a href="/watching/42" class="watch-link" data-youtube-url="https://www.youtube.com/watch?v=abc123">
  Video Title
</a>
```

```js
document.addEventListener("click", (e) => {
  const link = e.target.closest(".watch-link");
  if (!link) return;
  window.open(link.dataset.youtubeUrl, "_blank");
  // no preventDefault -- the click's default action still follows href to /watching/:id
  // in the current tab, which is what "navigates the current app view" means.
});
```

This is a real full-page navigation (not `hx-boost`), same reasoning as the
watched-toggle redirect above.

### Watching page (`src/views/watching-page.tsx`)

- Thumbnail: `https://i.ytimg.com/vi/{youtubeVideoId}/hqdefault.jpg` — YouTube's
  thumbnail CDN follows a predictable, undocumented-but-stable URL pattern keyed only on
  the video ID already stored, so this needs no additional ingestion/data source and
  stays consistent with the "zero YouTube Data API" constraint (it's a static image
  fetch, not an API call).
- Auto-Watching timeout: an element rendered **only when current status !== "watched"**
  (per `docs/app_idea.md`: the timeout must not fire when revisiting an already-Watched
  video), using `hx-trigger="load delay:10s" hx-post="/videos/:id/watching" hx-swap="none"`.
  If the user navigates away before 10s (via either the redirect button or the plain
  "Return to Queue" link), the element and its pending HTMX request are destroyed with
  the page — nothing fires, nothing is recorded, matching the spec's "not persisted
  server-side if interrupted" requirement with no extra bookkeeping.
- Three actions, both navigating ones computed from `resolveReturnTarget(from, sort)`
  (see Return-to-origin navigation) so they go back to wherever the video was actually
  opened from:
  - **Mark Watching** — `hx-post="/videos/:id/watching"`, stays on page (same endpoint
    the auto-timer uses; redundant calls are harmless since `setWatching` is idempotent).
    Not a navigating action, so it doesn't involve `from`/`sort` at all.
  - **Mark Watched & Return to `{returnLabel}`** / **Mark Unwatched & Return to
    `{returnLabel}`** — prefix computed server-side from the video's status at
    page-render time (`watched` → "Mark Unwatched…", anything else → "Mark Watched…"),
    suffix from `resolveReturnTarget(...).label`; plain form
    `action="/videos/:id/watched-toggle?from=...&sort=..." method="post"`.
  - **Return to `{returnLabel}`** — plain `<a href={resolveReturnTarget(...).url}>`, no
    request at all, no status change.

Both labels default to "…Return to Queue" when `from` is missing or unrecognized (direct
URL entry, an old bookmark, etc.) — the same fallback `resolveReturnTarget` already
applies, so the Watching page doesn't need its own separate default-handling.

### Nav (`src/views/layout.tsx`)

Adds a minimal top nav (`Categories` / `Channels` / `Queue` / `Continue Watching` /
`Watched`) so these pages are discoverable in the browser instead of URL-only. No
active-link highlighting or other polish — first pass just needs the links to exist.

### Testing (`test/lib/`, `test/routes/`)

- `test/lib/watch-status.test.ts`: `setWatching` — unwatched/watching/watched all
  transition to `watching`; returns `null` for a nonexistent video ID; transitioning
  from `watched` clears `watchedAt` to `null`, transitioning from `unwatched`/`watching`
  leaves `watchedAt` untouched (already `null`). `toggleWatchStatus` — unwatched→watched
  (sets `watchedAt` to a non-null recent timestamp), watched→unwatched (clears
  `watchedAt`), watching→unwatched (`watchedAt` stays `null`); returns `null` for a
  nonexistent video ID.
- `test/routes/queue.test.ts`:
  - `GET /queue` — returns only `unwatched`/`watching` videos for the current user's
    active subscriptions; excludes videos from an unsubscribed channel (insert a video
    for a channel, unsubscribe, assert it's absent); excludes `watched` videos; default
    sort is newest-first; `?sort=oldest` inverts it; each row's link to `/watching/:id`
    carries `from=queue` and the current `sort`.
  - `GET /continue-watching` — returns only `watching` videos, same active-subscription
    scoping; rows link with `from=continue-watching`.
  - `GET /watched` — returns only `watched` videos, sorted most-recently-watched-first;
    **unlike** the other two, still includes a video whose channel has since been
    unsubscribed (insert a watched video, unsubscribe from its channel, assert it's
    still present) — this is the test that actually proves the "true history" scoping
    difference from `queueVideos`/`continueWatchingVideos`; rows link with
    `from=watched`.
  - `GET /watching/:id` — 404 for a nonexistent ID; renders the "Mark Unwatched…" label
    when the video's current status is `watched`, "Mark Watched…" otherwise; the
    auto-Watching `hx-trigger` element is present for `unwatched`/`watching` videos and
    absent for `watched` ones; `?from=continue-watching` renders "Return to Continue
    Watching" with the correct `href`/form `action`, `?from=watched` renders "Return to
    Watched", `?from=queue&sort=oldest` round-trips into `/queue?sort=oldest`, and a
    missing/unrecognized `from` (e.g. `?from=bogus`, or no query string at all) falls
    back to "Return to Queue" / `/queue`.
  - `POST /videos/:id/watching` — sets status to `watching` regardless of prior status.
  - `POST /videos/:id/watched-toggle?from=...&sort=...` — toggles per
    `toggleWatchStatus` and responds with a 303 to `resolveReturnTarget(from, sort).url`
    (covering all three `from` values plus the missing/unrecognized fallback).
  - `POST /videos/:id/toggle` — toggles status and the returned partial reflects the
    row's removal from the view it was posted from (e.g. toggling an unwatched row in
    `?view=queue` no longer appears in the re-rendered list).

### Verification (manual, end-to-end)

1. With at least one subscribed channel that has ingested videos, open `/queue` — videos
   appear newest-first; toggling the sort shows oldest-first.
2. Click a video's title — a new tab opens the real YouTube watch page; the current tab
   navigates to `/watching/:id` showing its thumbnail and title.
3. Wait 10s without navigating away — confirm via DB query the video's status is now
   `watching`, and the page's status badge updates without a full reload.
4. Reload `/watching/:id` on a fresh (still-unwatched) video and immediately click
   "Return to Queue" before 10s elapses — confirm via DB query the status is still
   `unwatched` (the timer never fired).
5. Click "Mark Watched & Return to Queue" — lands back on `/queue`, video no longer
   listed (moved to `watched`); revisit the same video's `/watching/:id` directly — button
   now reads "Mark Unwatched & Return to Queue" and the auto-timer element is absent.
6. On `/queue`, use the manual toggle on an Unwatched row — it disappears from the list
   (now Watched); on a Watching row — it flips to Unwatched and stays visible.
7. Unsubscribe from a channel with ingested videos still in `unwatched`/`watching` —
   confirm its videos disappear from `/queue` and `/continue-watching` even though the
   `videos` rows still exist in the DB.
8. Open `/watched` — confirm it lists videos marked Watched in step 5, most-recently-watched
   first, with no inline toggle button (click-through only).
9. From `/watched`, click a video into `/watching/:id` — confirm "Return to Watched" (not
   "Return to Queue") is shown, and clicking it lands back on `/watched`.
10. Unsubscribe from the channel of a video that's already Watched — confirm it still
    appears on `/watched` (true history) even though it's now absent from `/queue` and
    `/continue-watching`.
11. From `/queue?sort=oldest`, click a video into `/watching/:id`, then "Return to
    Queue" — confirm it lands back on `/queue?sort=oldest`, not the default sort.
12. `bun test` and `bun run lint` clean.

## Open Questions

- Whether `hx-trigger="load delay:10s"` behaves as expected against the pinned
  `htmx.org@2.0.4` (element removed from the DOM before the delay elapses truly
  cancels the pending request, not just visually) isn't confirmed yet — verify in a
  real browser at implementation time.
- Continue Watching's and Watched's fixed order (no invert toggle, per Design) is a
  judgment call, not stated either way in `docs/app_idea.md` — confirm it's not missed
  once the pages are actually used.
- No fallback for a missing/404'ing thumbnail image (e.g. a very new or deleted video)
  — acceptable for MVP, revisit if it turns out to look broken often in practice.
- Confirmed during scoping: pagination across all three views (queue, Continue
  Watching, Watched) is explicitly deferred to a future "endless scroll queue"-shaped
  spec rather than being added piecemeal here, even though Watched in particular has no
  natural size cap.
