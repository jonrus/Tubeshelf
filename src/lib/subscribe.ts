import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, youtubeChannels } from "../db/schema";
import { fetchChannelTitle } from "./rss";

type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;

export type UpsertSubscriptionResult =
  | { outcome: "already-subscribed" }
  | { outcome: "reactivated"; subscription: SubscriptionRow }
  | { outcome: "created"; subscription: SubscriptionRow };

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed");
}

export async function upsertYoutubeChannel(
  channelId: string,
  rssUrl: string,
): Promise<YoutubeChannelRow | null> {
  const existing = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, channelId))
    .get();
  if (existing) return existing;

  const title = await fetchChannelTitle(rssUrl);
  if (title === null) return null;

  try {
    return db
      .insert(youtubeChannels)
      .values({ youtubeChannelId: channelId, name: title, rssUrl })
      .returning()
      .get();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const row = db
      .select()
      .from(youtubeChannels)
      .where(eq(youtubeChannels.youtubeChannelId, channelId))
      .get();
    if (!row) throw err;
    return row;
  }
}

function reactivateOrReject(
  existing: SubscriptionRow,
  categoryId: number,
): UpsertSubscriptionResult {
  if (existing.unsubscribedAt === null) {
    return { outcome: "already-subscribed" };
  }
  const subscription = db
    .update(subscriptions)
    .set({ unsubscribedAt: null, categoryId })
    .where(eq(subscriptions.id, existing.id))
    .returning()
    .get();
  return { outcome: "reactivated", subscription };
}

export function upsertSubscription(
  userId: number,
  youtubeChannelId: number,
  categoryId: number,
): UpsertSubscriptionResult {
  const matchesUserAndChannel = and(
    eq(subscriptions.userId, userId),
    eq(subscriptions.youtubeChannelId, youtubeChannelId),
  );

  const existing = db
    .select()
    .from(subscriptions)
    .where(matchesUserAndChannel)
    .get();
  if (existing) return reactivateOrReject(existing, categoryId);

  try {
    const subscription = db
      .insert(subscriptions)
      .values({ userId, youtubeChannelId, categoryId })
      .returning()
      .get();
    return { outcome: "created", subscription };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const row = db
      .select()
      .from(subscriptions)
      .where(matchesUserAndChannel)
      .get();
    if (!row) throw err;
    return reactivateOrReject(row, categoryId);
  }
}
