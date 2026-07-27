import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos } from "../db/schema";

export type NavCounts = {
  queueCount: number;
  continueWatchingCount: number;
  watchedCount: number;
};

export function getNavCounts(userId: number): NavCounts {
  const queueCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(
        subscriptions,
        eq(subscriptions.youtubeChannelId, videos.channelId),
      )
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          inArray(videos.status, ["unwatched", "watching"]),
        ),
      )
      .get()?.count ?? 0;

  const continueWatchingCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(
        subscriptions,
        eq(subscriptions.youtubeChannelId, videos.channelId),
      )
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          eq(videos.status, "watching"),
        ),
      )
      .get()?.count ?? 0;

  const watchedCount =
    db
      .select({ count: count() })
      .from(videos)
      .innerJoin(
        subscriptions,
        eq(subscriptions.youtubeChannelId, videos.channelId),
      )
      .where(
        and(eq(subscriptions.userId, userId), eq(videos.status, "watched")),
      )
      .get()?.count ?? 0;

  return { queueCount, continueWatchingCount, watchedCount };
}
