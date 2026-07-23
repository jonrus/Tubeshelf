---
status: draft
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
  `src/lib/ingest.ts`'s core logic rather than duplicating it.
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
  // channel's first ingest has nothing to have "missed" yet.
  const gapDetected = previousNewest !== undefined && oldestInFeed !== null
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
export async function ingestChannel(channel: YoutubeChannelRow): Promise<{ ok: boolean }> {
  const feed = await fetchChannelFeed(channel.rssUrl);
  if (!feed) {
    // Reschedule on the same cadence even on failure -- otherwise a channel with a
    // persistently broken feed stays permanently "due" and monopolizes every
    // scheduler tick's batch slots forever. No backoff/alerting for MVP (see Scope).
    const now = new Date();
    db.update(youtubeChannels).set({ nextFetchDueAt: nextDueAt(now) })
      .where(eq(youtubeChannels.id, channel.id)).run();
    return { ok: false };
  }
  applyFeedToChannel(channel.id, feed);
  return { ok: true };
}
```

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
    await ingestChannel(channel);
  }
}

export function startScheduler(): Timer {
  return setInterval(() => { tick().catch((err) => console.error("ingestion tick failed", err)); }, TICK_INTERVAL_MS);
}
```

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
   (`channelId`, `rssUrl`, `categoryId`) carrying the now-validated values forward, a
   "Confirm Subscribe" button (`hx-post="/subscriptions"`), and a "Cancel" action that
   swaps back to the blank subscribe form.

**`POST /subscriptions`** (confirm) — body: `{ channelId, rssUrl, categoryId }`.
1. Re-validate `categoryId` (defense in depth, same reasoning as spec002's original
   route — form data is client-controlled regardless of what the preview step showed).
2. Look up `youtube_channels` by `channelId`.
   - Not found: `fetchChannelFeed(rssUrl)` (one fetch — the preview step's fetch, if
     any, isn't reused/trusted across requests). `null` -> inline error into the
     confirm panel. Otherwise insert the row (same unique-constraint race recovery as
     spec002's `upsertYoutubeChannel`), then `applyFeedToChannel(newRow.id, feed)`
     using the feed already in hand — no second fetch for a brand-new channel.
   - Found: reuse the row, then `ingestChannel(row)` (fetches fresh — refreshes videos
     for a reactivated or already-known channel rather than showing a possibly-stale
     queue right after subscribing).
3. `upsertSubscription` as spec002.
4. Response: the blank subscribe form back into the confirm panel's slot, plus the
   updated `#subscription-list` as an out-of-band swap (`hx-swap-oob="true"`) so one
   response updates both regions HTMX targets separately.

This means: brand-new channel = 1 fetch at preview + 1 at confirm (2 total, feed reused
for both title and entries at confirm). Already-known channel = 0 fetches at preview +
1 at confirm (entries only, name already trusted). Confirming without ever having
called preview (e.g. a hand-crafted request) still works — preview is a UX nicety, not
a security boundary, same posture as spec002's un-authed MVP routes generally.

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
  still advances `nextFetchDueAt` (doesn't get stuck permanently due).
- `test/lib/scheduler.test.ts`: `dueChannels` — only returns channels with >=1 active
  subscription; excludes channels with a future `nextFetchDueAt`; includes null
  `nextFetchDueAt`; respects the batch limit and oldest-overdue-first ordering.
- `test/routes/channels.test.ts`: extend for the preview/confirm split — preview
  renders a confirmation with the real fetched/stored name and writes nothing to any
  table; confirm creates the subscription *and* populates `videos` for that channel in
  one round trip; confirming against an already-known channel does not attempt a
  channel-title fetch (only the ingest fetch) — assert via the existing `fetch` mock's
  call count.

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
