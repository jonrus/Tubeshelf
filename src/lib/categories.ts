import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { categories, subscriptions, videos } from "../db/schema";

export type CategoryWithCount = typeof categories.$inferSelect & {
  unwatchedCount: number;
};

function categoryUnwatchedCount(userId: number, categoryId: number): number {
  const row = db
    .select({ count: count() })
    .from(videos)
    .innerJoin(
      subscriptions,
      eq(subscriptions.youtubeChannelId, videos.channelId),
    )
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.categoryId, categoryId),
        isNull(subscriptions.unsubscribedAt),
        inArray(videos.status, ["unwatched", "watching"]),
      ),
    )
    .get();
  return row?.count ?? 0;
}

export function listCategoriesWithCounts(userId: number): CategoryWithCount[] {
  return db
    .select()
    .from(categories)
    .orderBy(desc(categories.isSystem), asc(categories.name))
    .all()
    .map((category) => ({
      ...category,
      unwatchedCount: categoryUnwatchedCount(userId, category.id),
    }));
}
