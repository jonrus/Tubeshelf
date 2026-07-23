---
status: in-progress
created: 2026-07-23
---

# Scheduled Video Ingestion

## Context

Spec002 delivered subscribe/unsubscribe against a global `youtube_channels` +
per-user `subscriptions` schema, but explicitly deferred "the scheduled/staggered RSS
ingestion job that actually populates `videos`" and the `possibleMissedVideos`
gap-detection logic to this spec. This is MVP item 2 in `docs/app_idea.md`, plus the
gap-detection check described in *Ingestion Notes*.

Without this spec, `videos` stays empty forever — subscribing to a channel does nothing
beyond recording the subscription. This is the spec that makes the app actually track
videos.

## Scope

**In:**
- `src/lib/rss.ts`: extend RSS parsing from "channel title only" (spec002) to full feed
  parsing — title + video entries (id, title, description, published date).
- `src/lib/ingest.ts`: core ingestion logic for one channel — fetch, upsert videos
  (keyed on YouTube video ID, preserving existing watch status on conflict), gap
  detection (`possibleMissedVideos`), and fetch-scheduling bookkeeping. Shared by both
  the scheduled job and the eager subscribe-time ingest below.
- `src/lib/scheduler.ts`: in-process interval scheduler. Runs inside the same Bun
  process as the web server, ticks periodically, and ingests due channels in small
  batches — staggered/jittered per `docs/app_idea.md`'s "hourly cadence... not all
  channels polled simultaneously," and resilient to a backlog after downtime.
  Only channels with at least one active subscription are polled.
  New `youtube_channels.last_fetched_at` / `next_fetch_due_at` columns drive this.
- Subscribe flow becomes two-step (preview → confirm) so a fetch only happens, and
  nothing is written to `youtube_channels`/`subscriptions`/`videos`, once the user has
  seen and confirmed the real channel name. On confirm, the now-subscribed channel is
  eagerly ingested immediately (not left to wait for its next scheduled slot), reusing
  `src/lib/ingest.ts`'s core logic rather than duplicating it. Only `channelId` (plus
  `categoryId`) is carried forward as a hidden field between the two requests — `rssUrl`
  is re-derived server-side from `channelId` at confirm time rather than trusted from
  the client (see Design). `rssUrlFor` moves from a private helper in
  `src/lib/channel-input.ts` to an exported one so both routes can share it.
  `src/lib/subscribe.ts`'s `upsertYoutubeChannel` return type changes so its caller can
  reuse the fetch it already did instead of fetching a second time (see Design).
- Gap-detection flag (`possibleMissedVideos`) is computed and persisted on every
  ingest, per *Ingestion Notes*' "oldest feed entry newer than newest stored video"
  check. It is set but never auto-cleared by ingestion (matches
  `docs/app_idea.md`: "manually dismissed... not a self-healing state").

**Out (deferred):**
- Any UI to view ingested videos, dismiss `possibleMissedVideos`, or otherwise surface
  ingestion results — this spec is background plumbing only. The queue page (MVP item
  3, watch flow) is its own future spec.
- IgnoreRule matching at ingestion time (MVP item 6) — videos are always inserted as
  `unwatched`. IgnoreRule CRUD, ingestion-time matching, and the reconciliation-on-rule-change
  pass are a separate future spec.
- Retry/backoff tuning for a channel whose feed is persistently broken — a failed fetch
  simply reschedules on the normal cadence like a success (see Design). No alerting.
- Auth/CSRF on the new preview/confirm routes — same as spec002, deferred to the auth
  spec; single implicit user for now.

## Design

### Schema (`src/db/schema.ts`)

Add two nullable timestamp columns to `youtube_channels` (plain `ALTER TABLE ADD
COLUMN`, no FK retargeting like spec002's `videos.channelId` migration — this is a
simple additive change):

```ts
export const youtubeChannels = sqliteTable("youtube_channels", {
  // ...existing columns...
  lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }), // last *successful* fetch; null = never
  nextFetchDueAt: integer("next_fetch_due_at", { mode: "timestamp" }), // null = due immediately
});
```

`lastFetchedAt` is observability-only (never queried by the scheduler); `nextFetchDueAt`
is what the scheduler's due-check actually filters on.

### RSS feed parsing (`src/lib/rss.ts`)

Spec002's `fetchChannelTitle` is replaced by a single `fetchChannelFeed` that parses
both the channel title and every `<entry>` in one fetch + one `XMLParser().parse()`
call — callers that only need the title (the preview step below) just read `.title`
off the result and discard `.entries`:

```ts
export type FeedEntry = {
  videoId: string;
  title: string;
  description: string | null;
  publishedAt: Date;
};

export type ChannelFeed = { title: string; entries: FeedEntry[] };

export async function fetchChannelFeed(rssUrl: string): Promise<ChannelFeed | null> {
  // same fetch-with-timeout/error-collapsing shape as spec002's fetchChannelTitle
  // (5s AbortSignal.timeout, all failure modes -> null: network error, timeout,
  // non-OK response, unparseable/missing title).
  // Each <entry> maps roughly to:
  //   id: "yt:video:<videoId>"          -> strip the "yt:video:" prefix
  //   title                              -> entry title
  //   media:group / media:description    -> description (nullable)
  //   published                          -> publishedAt
  // A malformed individual entry is skipped (logged), not fatal to the whole fetch —
  // one bad entry shouldn't drop every other video in the same feed.
}
```

Existing callers of `fetchChannelTitle` (spec002's `upsertYoutubeChannel`) switch to
`fetchChannelFeed(...)?.title`.

### Core ingestion (`src/lib/ingest.ts`)

```ts
const BASE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour, per app_idea.md "hourly cadence"
const JITTER_MS = 5 * 60 * 1000; // +/- 5 min, re-rolled every cycle

function nextDueAt(now: Date): Date {
  const jitter = Math.floor((Math.random() * 2 - 1) * JITTER_MS);
  return new Date(now.getTime() + BASE_INTERVAL_MS + jitter);
}

// Applies an already-fetched feed to a channel: upserts videos, runs gap detection,
// and advances the fetch schedule. Shared by ingestChannel() below and by the
// subscribe-confirm route's "brand new channel" path, which already has the feed
// in hand from the fetch it needed anyway to learn the channel's name.
export function applyFeedToChannel(channelId: number, feed: ChannelFeed): void {
  const previousNewest = db.select().from(videos)
    .where(eq(videos.channelId, channelId))
    .orderBy(desc(videos.publishedAt)).limit(1).get();

  for (const entry of feed.entries) {
    db.insert(videos).values({
      channelId,
      youtubeVideoId: entry.videoId,
      title: entry.title,
      description: entry.description,
      publishedAt: entry.publishedAt,
    }).onConflictDoUpdate({
      target: videos.youtubeVideoId,
      set: { title: entry.title, description: entry.description, publishedAt: entry.publishedAt },
      // status/ignoreMethod deliberately excluded from the update set: ingestion
      // never touches watch/ignore state on a video it's seen before.
    }).run();
  }

  const oldestInFeed = feed.entries.length > 0
    ? feed.entries.reduce((a, b) => (a.publishedAt < b.publishedAt ? a : b))
    : null;
  // Only meaningful once there's a prior baseline to compare against; a brand-new
  // channel's first ingest has nothing to have "missed" yet. `publishedAt` is
  // nullable in the videos table schema (even though every RSS-ingested row populates
  // it), so an explicit null check guards against relying on `Date > null`'s JS
  // coercion if a non-RSS insert path (e.g. a test fixture) ever leaves it unset.
  const gapDetected = previousNewest !== undefined
    && previousNewest.publishedAt !== null
    && oldestInFeed !== null
    && oldestInFeed.publishedAt > previousNewest.publishedAt;

  const now = new Date();
  db.update(youtubeChannels).set({
    lastFetchedAt: now,
    nextFetchDueAt: nextDueAt(now),
    // Never auto-clears an existing true flag -- only a future manual-dismiss
    // action (out of scope here) does that.
    ...(gapDetected ? { possibleMissedVideos: true } : {}),
  }).where(eq(youtubeChannels.id, channelId)).run();
}

// Fetches fresh and applies. Used by the scheduler, and by the subscribe-confirm
// route's "channel already existed" path (no feed already in hand there).
// Never throws -- both the fetch and the apply step are covered by one try/catch, so
// a DB-layer error (not just a fetch failure) still reschedules rather than leaving
// nextFetchDueAt stuck in the past. That matters more than it looks: dueChannels()
// orders oldest-overdue-first, so a channel that never gets rescheduled becomes
// permanently first-in-line, and tick()'s loop has no per-channel error isolation --
// an uncaught throw here would abort the rest of that tick's batch, every tick,
// forever, starving every other channel behind the one that's broken.
// Swallows its own failure -- used for the reschedule-on-failure paths below, which
// must never throw themselves. If even a single-row UPDATE fails here (DB genuinely
// unavailable, not just busy-and-retried), there's nothing further this cycle can do;
// log it and leave the channel's nextFetchDueAt as-is rather than propagate and
// re-trigger the exact starvation this whole error-handling structure exists to
// prevent. It'll be retried (and most likely reschedule successfully) on a later tick.
function safeReschedule(channelId: number, now: Date): void {
  try {
    db.update(youtubeChannels).set({ nextFetchDueAt: nextDueAt(now) })
      .where(eq(youtubeChannels.id, channelId)).run();
  } catch (err) {
    console.error(`failed to reschedule channel ${channelId} after ingestion error`, err);
  }
}

export async function ingestChannel(channel: YoutubeChannelRow): Promise<{ ok: boolean }> {
  // Captured once, before the fetch, rather than freshly per-branch -- one consistent
  // timestamp for the whole call. The only cost is nextFetchDueAt being computed from
  // "start of this attempt" rather than "when we knew the outcome," i.e. up to
  // FETCH_TIMEOUT_MS of drift -- negligible against a 1-hour cadence with a 5-minute
  // jitter window.
  const now = new Date();
  try {
    const feed = await fetchChannelFeed(channel.rssUrl);
    if (!feed) {
      // Reschedule on the same cadence even on failure -- otherwise a channel with a
      // persistently broken feed stays permanently "due" and monopolizes every
      // scheduler tick's batch slots forever. No backoff/alerting for MVP (see Scope).
      safeReschedule(channel.id, now);
      return { ok: false };
    }
    applyFeedToChannel(channel.id, feed);
    return { ok: true };
  } catch (err) {
    console.error(`ingestion failed for channel ${channel.id}`, err);
    safeReschedule(channel.id, now);
    return { ok: false };
  }
}
```

A partial video-upsert batch left behind by a mid-loop failure in `applyFeedToChannel`
(some entries inserted before the error, some not) is harmless and self-heals on the
next attempt -- `onConflictDoUpdate` makes re-applying an already-upserted entry a
no-op, so no wrapping transaction is needed, consistent with this spec's existing
no-backoff/no-retry-sophistication posture for fetch failures.

### Scheduler (`src/lib/scheduler.ts`)

```ts
const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const BATCH_SIZE = 5; // cap per tick so a post-downtime backlog drains gradually

// Pure-ish query, separated from the setInterval wiring so it's directly testable
// without waiting on real timers.
export function dueChannels(now: Date, limit = BATCH_SIZE): YoutubeChannelRow[] {
  const activelySubscribed = db.select({ id: subscriptions.youtubeChannelId })
    .from(subscriptions).where(isNull(subscriptions.unsubscribedAt));
  return db.select().from(youtubeChannels)
    .where(and(
      inArray(youtubeChannels.id, activelySubscribed),
      or(isNull(youtubeChannels.nextFetchDueAt), lte(youtubeChannels.nextFetchDueAt, now)),
    ))
    .orderBy(asc(youtubeChannels.nextFetchDueAt)) // oldest-overdue-first
    .limit(limit).all();
}

export async function tick(): Promise<void> {
  for (const channel of dueChannels(new Date())) {
    await ingestChannel(channel); // never throws -- see ingestChannel's try/catch
  }
}

// Wraps tick() with the re-entrancy guard, factored out from startScheduler's
// setInterval wiring specifically so it's directly callable from a test (invoke it
// twice back-to-back with a slow/pending tick() and assert the second call is a
// no-op) without needing real 60s timers.
let ticking = false;
export async function runGuardedTick(): Promise<void> {
  if (ticking) return; // previous tick still in flight -- skip rather than overlap
  ticking = true;
  try {
    await tick();
  } catch (err) {
    console.error("ingestion tick failed", err);
  } finally {
    ticking = false;
  }
}

export function startScheduler(): Timer {
  return setInterval(() => { void runGuardedTick(); }, TICK_INTERVAL_MS);
}
```

The guard matters because `tick()` awaits each due channel's fetch sequentially (worst
case `BATCH_SIZE * FETCH_TIMEOUT_MS` = 25s, under the 60s tick interval today, but not
guaranteed forever). Without it, a slow patch of network could let two ticks overlap and
pick the same due channel twice — each ingest is individually idempotent
(upsert-keyed), so it wouldn't corrupt data, just waste a redundant fetch — but skipping
is free and avoids the overlap growing unbounded under sustained slowness.

`src/index.ts` calls `startScheduler()` once, after `seed()`, alongside `Bun.serve`.
The interval lives for the process's lifetime — no explicit shutdown handling needed
(container restart is the reset mechanism, consistent with this project's "disposable
dev container" posture elsewhere).

A channel that drops to zero active subscriptions (last subscriber unsubscribes)
simply stops being selected by `dueChannels` — its `nextFetchDueAt` goes stale, which
is harmless until it's resubscribed (which re-ingests it eagerly; see below).

### Subscribe flow becomes preview -> confirm (`src/routes/channels.tsx`)

Spec002's single `POST /subscriptions` splits into two routes. Nothing is written to
any table until confirm.

**`POST /subscriptions/preview`** — body: `{ channelInput, categoryId }`.
1. `parseChannelInput` + category resolution/validation exactly as spec002's route did
   — invalid input or category renders an inline error back into the form, no fetch
   happens.
2. Look up `youtube_channels` by the parsed `channelId`.
   - Found: use its stored `name` — no fetch.
   - Not found: `fetchChannelFeed(rssUrl)`, use `.title`; `null` -> inline error
     ("couldn't fetch that channel's feed"), stop.
3. Render a confirmation partial: the resolved channel name, plus hidden fields
   (`channelId`, `categoryId` — **not** `rssUrl`; see confirm step below for why)
   carrying the now-validated values forward, a "Confirm Subscribe" button
   (`hx-post="/subscriptions"`), and a "Cancel" action that swaps back to the blank
   subscribe form.

**`POST /subscriptions`** (confirm) — body: `{ channelId, categoryId }`.
1. Re-validate `categoryId` (defense in depth, same reasoning as spec002's original
   route — form data is client-controlled regardless of what the preview step showed).
2. Re-validate `channelId` against `CHANNEL_ID_PATTERN` (exported from
   `channel-input.ts` alongside `rssUrlFor`) and derive `rssUrl` from it via
   `rssUrlFor(channelId)` — **never** accept `rssUrl` as a hidden field. The preview
   step already round-tripped `channelId` through `parseChannelInput`, so it's
   trustworthy to re-derive from, whereas an `rssUrl` hidden field would be an
   independent, unvalidated value the client could point anywhere — the server would
   then fetch it on the client's behalf (SSRF shape), which matters here since
   `docs/app_idea.md` allows this app to be exposed past the LAN via a tunnel.
   A malformed `channelId` at this point (hand-crafted request, never went through
   preview) is an inline error, same as spec002's original single-step validation.
3. `upsertYoutubeChannel(channelId, rssUrl)` — **signature change from spec002**: now
   returns `Promise<{ channel: YoutubeChannelRow; feed: ChannelFeed | null } | null>`
   instead of `Promise<YoutubeChannelRow | null>`. `feed` is populated only on the
   branch where the function did its own fetch (a brand-new row it just inserted); it's
   `null` when it found an existing row immediately, or when it fetched but then lost
   the insert race to a concurrent request (its own fetched feed is simply discarded in
   that case — rare path, not worth threading through). Internally unchanged otherwise:
   same not-found → fetch → insert-with-unique-constraint-race-recovery logic spec002
   already had and already has tests for; this only changes what it hands back to the
   caller. `null` overall return -> inline error into the confirm panel (fetch failed
   for a genuinely new channel).
   - If `feed` came back: `applyFeedToChannel(channel.id, feed)` — reuses the fetch
     `upsertYoutubeChannel` already did, no second fetch for a brand-new channel.
   - If `feed` is `null` (channel already existed): `ingestChannel(channel)` — fetches
     fresh, to refresh videos for a reactivated or already-known channel rather than
     showing a possibly-stale queue right after subscribing. Unlike the brand-new-channel
     case above, a failure here (`ingestChannel` returns `{ ok: false }`, per its
     try/catch — see Core ingestion) does **not** block the subscription from being
     created — the channel's identity is already established, so there's no reason to
     fail the whole confirm over a refresh attempt that can just wait for the channel's
     next scheduled slot.
4. `upsertSubscription` as spec002.
5. Response: the blank subscribe form back into the confirm panel's slot, plus the
   updated `#subscription-list` as an out-of-band swap (`hx-swap-oob="true"`) so one
   response updates both regions HTMX targets separately.

This means: brand-new channel = 1 fetch at preview + 1 at confirm (2 total, feed reused
for both title and entries at confirm via `upsertYoutubeChannel`'s returned `feed`).
Already-known channel = 0 fetches at preview + 1 at confirm (entries only, name already
trusted). Confirming without ever having called preview (e.g. a hand-crafted request)
still works — preview is a UX nicety, not a security boundary, same posture as
spec002's un-authed MVP routes generally.

### Testing (`test/lib/`, `test/routes/`)

- `test/lib/rss.test.ts`: extend for `fetchChannelFeed` — parses title + entries from a
  synthetic Atom+`media`/`yt` namespaced fixture; a malformed single entry is skipped,
  not fatal; existing failure-mode coverage (network error, timeout, non-OK, missing
  title) carries over.
- `test/lib/ingest.test.ts`: `applyFeedToChannel` — new videos inserted as `unwatched`;
  re-ingesting updates title/description/publishedAt on an existing video without
  touching its `status`/`ignoreMethod`; gap detection sets `possibleMissedVideos` when
  the feed's oldest entry postdates the previously-newest stored video, does *not* fire
  on a channel's first-ever ingest (nothing to compare against), and does not clear an
  already-true flag on a subsequent gap-free ingest. `ingestChannel` — a failed fetch
  still advances `nextFetchDueAt` (doesn't get stuck permanently due); a DB-layer error
  thrown from inside `applyFeedToChannel` (mock it to throw) is caught, still advances
  `nextFetchDueAt`, and `ingestChannel` resolves to `{ ok: false }` rather than
  rejecting — this is the case that otherwise starves the scheduler (see Design).
  `safeReschedule` — a failing update (mock the DB call to throw) is caught and logged
  rather than propagating, so `ingestChannel` still resolves to `{ ok: false }` even
  when its own recovery write fails.
- `test/lib/subscribe.test.ts`: extend for `upsertYoutubeChannel`'s new return shape —
  a brand-new channel returns `{ channel, feed }` with `feed` populated from the fetch
  it just made; an already-existing channel returns `{ channel, feed: null }` with no
  fetch attempted; the existing race-recovery test (pre-insert a conflicting row, call
  the function, assert it recovers) still passes with `feed: null` on that path.
- `test/lib/scheduler.test.ts`: `dueChannels` — only returns channels with >=1 active
  subscription; excludes channels with a future `nextFetchDueAt`; includes null
  `nextFetchDueAt`; respects the batch limit and oldest-overdue-first ordering.
  `runGuardedTick`'s re-entrancy guard — calling it a second time while a mocked `tick()`
  is still pending is a no-op (doesn't invoke `tick()` again); once the pending call
  resolves, a subsequent `runGuardedTick()` call runs normally. Directly testable now
  that the guard is its own exported function, no real timers needed. Note: the guard's
  `ticking` flag is shared module state that only resets once the pending call settles
  (the `finally`) — a test exercising this must let its mocked `tick()` actually
  resolve/reject before the test ends, or `ticking` leaks `true` into later test cases
  in the same file.
- `test/routes/channels.test.ts`: extend for the preview/confirm split — preview
  renders a confirmation with the real fetched/stored name and writes nothing to any
  table; confirm creates the subscription *and* populates `videos` for that channel in
  one round trip; confirming against an already-known channel does not attempt a
  channel-title fetch (only the ingest fetch) — assert via the existing `fetch` mock's
  call count; a confirm request carrying a mismatched/malformed `channelId` (simulating
  a hand-crafted request that skipped preview) is rejected inline rather than inserted;
  a confirm request cannot influence which URL the server fetches by any means other
  than `channelId` — assert the mocked `fetch`'s call argument always equals
  `rssUrlFor(channelId)` regardless of what else is in the request body.

### Verification (manual, end-to-end)

1. `bun run db:generate` — confirm `last_fetched_at`/`next_fetch_due_at` are added to
   `youtube_channels` via plain `ALTER TABLE` (no table recreation needed, unlike
   spec002's FK retarget). Two new nullable columns on an existing table is
   unambiguous, so this isn't expected to hit the interactive "rename vs. new table"
   prompt spec002 ran into — but if `drizzle-kit` does prompt anyway, per CLAUDE.md
   this needs a real TTY that a `devcontainer exec` session doesn't have; hand the
   exact command to the user to run in their own terminal rather than attempting a
   workaround, same as spec002.
2. Subscribe to a real channel: preview shows its real name; confirm updates the
   subscription list *and* `videos` has real rows for that channel (check via DB) —
   proves the eager confirm-time ingest works end to end.
3. Wait for (or manually invoke) a scheduler tick against a channel whose
   `nextFetchDueAt` has been forced into the past; confirm `lastFetchedAt` /
   `nextFetchDueAt` advance and no duplicate video rows appear on a re-ingest of the
   same channel.
4. Force a gap (e.g. delete a channel's stored videos except an old one, then let it
   re-ingest against the live feed) and confirm `possibleMissedVideos` flips to `true`
   and stays `true` across a subsequent clean ingest.
5. `bun test` and `bun run lint` clean.

## Open Questions

- The exact shape `fast-xml-parser` produces for `<entry>`/`media:group`/
  `media:description`/the `yt:videoId`-bearing `<id>` element isn't confirmed against a
  live feed yet — same category of risk spec001/002 flagged for other library-shape
  assumptions (Drizzle's `check()`/`unique()` builders). Verify at implementation time
  and adjust the parsing logic if the real shape differs from what's sketched above.
- Two more Drizzle patterns appear in this spec for the first time in the codebase and
  aren't confirmed against the installed `drizzle-orm` version either, same risk class
  as the point above: `.onConflictDoUpdate({ target, set })` for the video upsert in
  `applyFeedToChannel`, and comparing a `timestamp`-mode column against a plain JS
  `Date` inside `lte(...)`/`or(isNull(...), ...)` in `dueChannels`. Verify both compile
  and behave as expected at implementation time.
- `BASE_INTERVAL_MS`/`JITTER_MS`/`TICK_INTERVAL_MS`/`BATCH_SIZE` are reasonable
  starting constants, not empirically tuned — fine to adjust once real usage (a modest
  personal channel list) shows the cadence is too aggressive or too slow.
- No index on `youtube_channels.next_fetch_due_at` — at MVP's expected scale (one
  user's personal subscription list) a full table scan per tick is fine; revisit if
  channel counts ever grow enough for it to matter.
- Re-validating `categoryId` at both preview and confirm (rather than trusting the
  hidden field HTMX carries forward) mirrors spec002's existing defense-in-depth
  posture, but hasn't been checked against the actual UI for whether it ever produces
  a confusing double-validation UX — confirm once the two-step flow is visible in a
  browser.
