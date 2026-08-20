import { asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { categories, subscriptions, videos } from "../db/schema";
import { countUserVideos } from "./nav-counts";

export type CategoryWithCount = typeof categories.$inferSelect & {
  unwatchedCount: number;
  channelCount: number;
};

export function getSystemCategory(): typeof categories.$inferSelect {
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.isSystem, true))
    .get();
  if (!category) throw new Error("seed did not create the system category");
  return category;
}

function categoryUnwatchedCount(userId: number, categoryId: number): number {
  return countUserVideos(
    userId,
    eq(subscriptions.categoryId, categoryId),
    isNull(subscriptions.unsubscribedAt),
    inArray(videos.status, ["unwatched", "watching"]),
  );
}

function categoryChannelCount(categoryId: number): number {
  const row = db
    .select({ count: count() })
    .from(subscriptions)
    .where(eq(subscriptions.categoryId, categoryId))
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
      channelCount: categoryChannelCount(category.id),
    }));
}
