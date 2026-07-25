import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { videos, youtubeChannels } from "../db/schema";
import { listIgnoreRules, matchesAnyRule } from "./ignore-rules";
import { type ChannelFeed, fetchChannelFeed } from "./rss";

type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

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
  const previousNewest = db
    .select()
    .from(videos)
    .where(eq(videos.channelId, channelId))
    .orderBy(desc(videos.publishedAt))
    .limit(1)
    .get();

  const rules = listIgnoreRules();

  for (const entry of feed.entries) {
    const ignored = matchesAnyRule(
      { title: entry.title, description: entry.description },
      rules,
    );
    db.insert(videos)
      .values({
        channelId,
        youtubeVideoId: entry.videoId,
        title: entry.title,
        description: entry.description,
        publishedAt: entry.publishedAt,
        ...(ignored
          ? { status: "ignored" as const, ignoreMethod: "auto" as const }
          : {}),
      })
      .onConflictDoUpdate({
        target: videos.youtubeVideoId,
        set: {
          title: entry.title,
          description: entry.description,
          publishedAt: entry.publishedAt,
        },
        // status/ignoreMethod deliberately excluded from the update set: ingestion
        // never touches watch/ignore state on a video it's seen before.
      })
      .run();
  }

  const oldestInFeed =
    feed.entries.length > 0
      ? feed.entries.reduce((a, b) => (a.publishedAt < b.publishedAt ? a : b))
      : null;
  // Only meaningful once there's a prior baseline to compare against; a brand-new
  // channel's first ingest has nothing to have "missed" yet. `publishedAt` is
  // nullable in the videos table schema (even though every RSS-ingested row populates
  // it), so an explicit null check guards against relying on `Date > null`'s JS
  // coercion if a non-RSS insert path (e.g. a test fixture) ever leaves it unset.
  const gapDetected =
    previousNewest !== undefined &&
    previousNewest.publishedAt !== null &&
    oldestInFeed !== null &&
    oldestInFeed.publishedAt > previousNewest.publishedAt;

  const now = new Date();
  db.update(youtubeChannels)
    .set({
      lastFetchedAt: now,
      nextFetchDueAt: nextDueAt(now),
      // Never auto-clears an existing true flag -- only a future manual-dismiss
      // action (out of scope here) does that.
      ...(gapDetected ? { possibleMissedVideos: true } : {}),
    })
    .where(eq(youtubeChannels.id, channelId))
    .run();
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
    db.update(youtubeChannels)
      .set({ nextFetchDueAt: nextDueAt(now) })
      .where(eq(youtubeChannels.id, channelId))
      .run();
  } catch (err) {
    console.error(
      `failed to reschedule channel ${channelId} after ingestion error`,
      err,
    );
  }
}

export async function ingestChannel(
  channel: YoutubeChannelRow,
): Promise<{ ok: boolean }> {
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
