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
- Filtering both views to videos belonging to channels the current user is **actively**
  subscribed to (an unsubscribed channel's videos must not reappear in the queue, even
  though spec002 guarantees they're never deleted).
- A minimal top nav in `layout.tsx` (Categories / Channels / Queue / Continue Watching)
  so the new pages are reachable through the UI, not just by typing a URL.

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

## Design

### Watch status transitions (`src/lib/watch-status.ts`)

Two functions cover every transition described in `docs/app_idea.md`'s Watch Flow
section — no separate "clear to unwatched" function, since that's just one branch of
the same toggle used by both the queue page and the Watching page's second button:

```ts
export function setWatching(videoId: number): { status: "watching" } | null {
  // Unconditional: unwatched -> watching, watching -> watching (no-op), and
  // watched -> watching are all valid (re-watching an already-seen video is a normal
  // flow per the Watching page's label-flip behavior below). Returns null if the
  // video doesn't exist.
}

export function toggleWatchStatus(videoId: number): { status: "watched" | "unwatched" } | null {
  // unwatched -> watched
  // watched   -> unwatched
  // watching  -> unwatched   (the *only* path back from Watching, per app_idea.md)
  // Returns null if the video doesn't exist.
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
```

Since both queue views only ever show `unwatched`/`watching` videos, a queue row's
toggle button only ever needs two labels: **"Mark Watched"** (unwatched rows) or
**"Clear to Unwatched"** (watching rows) — `watched` never appears in either list, so
that third transition is never rendered here (it only shows up on the Watching page).

### Routes (`src/routes/queue.tsx`)

- `GET /queue?sort=newest|oldest` (default `newest`) — full page.
- `GET /continue-watching` — full page.
- `GET /watching/:id` — Watching page for one video (`videos.id`, matching the existing
  `:id`-is-internal-PK convention from `subscriptions.tsx`). 404 if the video doesn't
  exist. No subscription-active check here — a direct link to a video you've since
  unsubscribed from should still resolve; only the queue *listing* is subscription-scoped.
- `POST /videos/:id/watching` — calls `setWatching`. Used by both the explicit "Mark
  Watching" button and the auto-timeout element below. Response: re-renders a small
  `<span id="watch-status-badge">` partial reflecting the new status (`hx-swap="outerHTML"`),
  not a full page reload — the Watching page's button labels don't need to change on this
  transition (see below), so there's nothing else to update.
- `POST /videos/:id/watched-toggle` — calls `toggleWatchStatus`. Plain (non-HTMX) form
  POST, responds with a 303 redirect to `/queue`. Deliberately a real browser navigation
  rather than an HTMX partial swap: navigating away destroys any still-pending 10-second
  auto-Watching timer on the page being left, which is what makes "not persisted if
  interrupted" hold without any extra client-side cancellation code.
- `POST /videos/:id/toggle?view=queue|continue-watching&sort=newest|oldest` — calls
  `toggleWatchStatus`, used by the queue-page row toggle. HTMX partial: re-renders and
  returns the whole list partial for the given `view`/`sort` (not just the one row),
  because toggling can remove the row from its current view entirely (e.g. toggling an
  Unwatched row to Watched removes it from both queue views). `view`/`sort` travel as
  query params on each row's own `hx-post` URL rather than a shared page-level default,
  so each row's toggle always re-renders the exact list it's currently sitting in.

### Click-to-watch (`src/views/queue-list.tsx`)

A row's title links to `/watching/:id` and must also open the real YouTube URL in a new
tab. `title`/video IDs are untrusted external RSS content, so this is built as a plain
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
- Three actions:
  - **Mark Watching** — `hx-post="/videos/:id/watching"`, stays on page (same endpoint
    the auto-timer uses; redundant calls are harmless since `setWatching` is idempotent).
  - **Mark Watched & Return to Queue** / **Mark Unwatched & Return to Queue** — label
    computed server-side from the video's status at page-render time (`watched` →
    "Mark Unwatched…", anything else → "Mark Watched…"); plain form
    `action="/videos/:id/watched-toggle" method="post"`.
  - **Return to Queue** — plain `<a href="/queue">`, no request at all, no status change.

### Nav (`src/views/layout.tsx`)

Adds a minimal top nav (`Categories` / `Channels` / `Queue` / `Continue Watching`) so
these pages are discoverable in the browser instead of URL-only. No active-link
highlighting or other polish — first pass just needs the links to exist.

### Testing (`test/lib/`, `test/routes/`)

- `test/lib/watch-status.test.ts`: `setWatching` — unwatched/watching/watched all
  transition to `watching`; returns `null` for a nonexistent video ID.
  `toggleWatchStatus` — unwatched→watched, watched→unwatched, watching→unwatched;
  returns `null` for a nonexistent video ID.
- `test/routes/queue.test.ts`:
  - `GET /queue` — returns only `unwatched`/`watching` videos for the current user's
    active subscriptions; excludes videos from an unsubscribed channel (insert a video
    for a channel, unsubscribe, assert it's absent); excludes `watched` videos; default
    sort is newest-first; `?sort=oldest` inverts it.
  - `GET /continue-watching` — returns only `watching` videos, same active-subscription
    scoping.
  - `GET /watching/:id` — 404 for a nonexistent ID; renders the "Mark Unwatched…" label
    when the video's current status is `watched`, "Mark Watched…" otherwise; the
    auto-Watching `hx-trigger` element is present for `unwatched`/`watching` videos and
    absent for `watched` ones.
  - `POST /videos/:id/watching` — sets status to `watching` regardless of prior status.
  - `POST /videos/:id/watched-toggle` — toggles per `toggleWatchStatus` and responds
    with a 303 to `/queue`.
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
8. `bun test` and `bun run lint` clean.

## Open Questions

- Whether `hx-trigger="load delay:10s"` behaves as expected against the pinned
  `htmx.org@2.0.4` (element removed from the DOM before the delay elapses truly
  cancels the pending request, not just visually) isn't confirmed yet — verify in a
  real browser at implementation time.
- Continue Watching's fixed newest-first order (no invert toggle, per Design) is a
  judgment call, not stated either way in `docs/app_idea.md` — confirm it's not missed
  once the page is actually used.
- No fallback for a missing/404'ing thumbnail image (e.g. a very new or deleted video)
  — acceptable for MVP, revisit if it turns out to look broken often in practice.
