import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos } from "../db/schema";
import { logger } from "./logger";
import { fetchVideoDurations } from "./youtube-api";

const BATCH_SIZE = 50;

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
function eligibleVideos(limit = BATCH_SIZE): VideoRow[] {
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
        inArray(videos.status, ["unwatched", "watching"]),
        inArray(videos.channelId, activelySubscribedChannelIds),
      ),
    )
    .orderBy(desc(videos.publishedAt))
    .limit(limit)
    .all();
}

export async function runDurationEnrichmentSweep(): Promise<void> {
  if (apiKey === undefined || latched) return;

  try {
    const batch = eligibleVideos();
    if (batch.length === 0) return;

    const { durations, failure } = await fetchVideoDurations(
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

    for (const video of batch) {
      const durationSeconds = durations.get(video.youtubeVideoId);
      if (durationSeconds === undefined) continue;
      db.update(videos)
        .set({ durationSeconds })
        .where(eq(videos.id, video.id))
        .run();
    }
  } catch (err) {
    logger.error("Duration enrichment sweep failed unexpectedly", { err });
  }
}
