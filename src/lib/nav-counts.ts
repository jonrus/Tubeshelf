import { and, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos } from "../db/schema";

export type NavCounts = {
  queueCount: number;
  continueWatchingCount: number;
  watchedCount: number;
};

// Shared with categories.ts's categoryUnwatchedCount, which counts the same
// videos-joined-to-subscriptions shape scoped to one category as well as the user.
export function countUserVideos(
  userId: number,
  ...conditions: (SQL | undefined)[]
): number {
  return (
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(
        subscriptions,
        eq(subscriptions.youtubeChannelId, videos.channelId),
      )
      .where(and(eq(subscriptions.userId, userId), ...conditions))
      .get()?.count ?? 0
  );
}

export function getNavCounts(userId: number): NavCounts {
  const queueCount = countUserVideos(
    userId,
    isNull(subscriptions.unsubscribedAt),
    inArray(videos.status, ["unwatched", "watching"]),
  );

  const continueWatchingCount = countUserVideos(
    userId,
    isNull(subscriptions.unsubscribedAt),
    eq(videos.status, "watching"),
  );

  const watchedCount = countUserVideos(userId, eq(videos.status, "watched"));

  return { queueCount, continueWatchingCount, watchedCount };
}
