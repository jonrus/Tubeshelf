import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos } from "../db/schema";
import { logger } from "./logger";
import { fetchVideoDurations } from "./youtube-api";

const BATCH_SIZE = 50;

// Recheck windows for videos the API didn't resolve a duration for -- see the spec's
// "Stamping rule". Returned-but-null (live/upcoming) resolves soon; omitted
// (deleted/private) rarely comes back.
const UNRESOLVED_RECHECK_MS = 60 * 60 * 1000;
const OMITTED_RECHECK_MS = 24 * 60 * 60 * 1000;

const rawKey = process.env.YOUTUBE_API_KEY?.trim();
const apiKey = rawKey ? rawKey : undefined;
if (apiKey === undefined) {
  logger.info("Duration enrichment disabled: YOUTUBE_API_KEY not set");
}

// Latches on a definitively-bad key -- see the spec's Error handling section for why
// this requires a positive allowlist match rather than any 401/403.
let latched = false;

type VideoRow = typeof videos.$inferSelect;

// Mirrors scheduler.ts's dueChannels() active-subscription pattern -- a background job
// with no "current user" context, unlike the user-scoped Queue/Continue Watching route
// queries. See the spec's Eligibility query section for the multi-user caveat.
function eligibleVideos(now: Date, limit = BATCH_SIZE): VideoRow[] {
  const activelySubscribedChannelIds = db
    .select({ id: subscriptions.youtubeChannelId })
    .from(subscriptions)
    .where(isNull(subscriptions.unsubscribedAt));

  return db
    .select()
    .from(videos)
    .where(
      and(
        isNull(videos.durationSeconds),
        or(
          isNull(videos.durationRecheckAt),
          lte(videos.durationRecheckAt, now),
        ),
        inArray(videos.status, ["unwatched", "watching"]),
        inArray(videos.channelId, activelySubscribedChannelIds),
      ),
    )
    .orderBy(desc(videos.publishedAt))
    .limit(limit)
    .all();
}

export async function runDurationEnrichmentSweep(
  now = new Date(),
): Promise<void> {
  if (apiKey === undefined || latched) return;

  try {
    const batch = eligibleVideos(now);
    if (batch.length === 0) return;

    const { durations, returnedIds, failure } = await fetchVideoDurations(
      batch.map((video) => video.youtubeVideoId),
      apiKey,
    );

    if (failure?.class === "bad-key") {
      logger.warn("Duration enrichment disabled: bad API key", {
        reason: failure.reason,
      });
      latched = true;
      return;
    }
    if (failure?.class === "transient") {
      logger.warn("Duration enrichment sweep failed, will retry next tick", {
        reason: failure.reason,
        count: batch.length,
      });
      return;
    }

    db.transaction((tx) => {
      for (const video of batch) {
        const durationSeconds = durations.get(video.youtubeVideoId);
        if (durationSeconds !== undefined) {
          tx.update(videos)
            .set({ durationSeconds })
            .where(eq(videos.id, video.id))
            .run();
          continue;
        }
        const windowMs = returnedIds.has(video.youtubeVideoId)
          ? UNRESOLVED_RECHECK_MS
          : OMITTED_RECHECK_MS;
        tx.update(videos)
          .set({ durationRecheckAt: new Date(now.getTime() + windowMs) })
          .where(eq(videos.id, video.id))
          .run();
      }
    });
  } catch (err) {
    logger.error("Duration enrichment sweep failed unexpectedly", { err });
  }
}
