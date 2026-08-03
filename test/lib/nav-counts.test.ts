import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// getNavCounts operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, videos, youtubeChannels } =
  await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { getNavCounts } = await import("../../src/lib/nav-counts");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const defaultUserRow = db
  .select()
  .from(users)
  .where(eq(users.username, "admin"))
  .get();
if (!defaultUserRow) throw new Error("seed did not create the default user");
const defaultUser = defaultUserRow;

const systemCategoryRow = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!systemCategoryRow) {
  throw new Error("seed did not create the system Uncategorized category");
}
const systemCategory = systemCategoryRow;

let channelCounter = 0;
function makeChannel(name: string) {
  channelCounter += 1;
  const youtubeChannelId = `UCnavCountsTest${String(channelCounter).padStart(6, "0")}`;
  return db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId,
      name,
      rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`,
    })
    .returning()
    .get();
}

function makeSubscription(
  channelId: number,
  opts: { unsubscribed?: boolean; categoryId?: number } = {},
) {
  return db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channelId,
      categoryId: opts.categoryId ?? systemCategory.id,
      unsubscribedAt: opts.unsubscribed ? new Date() : null,
    })
    .returning()
    .get();
}

let videoCounter = 0;
function makeVideo(
  channelId: number,
  opts: { status?: "unwatched" | "watching" | "watched" | "ignored" } = {},
) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId,
      youtubeVideoId: `vid-nav-counts-test-${videoCounter}`,
      title: `Nav Counts Test Video ${videoCounter}`,
      status: opts.status ?? "unwatched",
      watchedAt: opts.status === "watched" ? new Date() : null,
    })
    .returning()
    .get();
}

test("queueCount counts unwatched and watching videos on active subscriptions, not ignored/watched", () => {
  const channel = makeChannel("Nav Counts Channel A");
  makeSubscription(channel.id);
  makeVideo(channel.id, { status: "unwatched" });
  makeVideo(channel.id, { status: "watching" });
  makeVideo(channel.id, { status: "watched" });
  makeVideo(channel.id, { status: "ignored" });

  const before = getNavCounts(defaultUser.id);

  const channel2 = makeChannel("Nav Counts Channel A2");
  makeSubscription(channel2.id);
  makeVideo(channel2.id, { status: "unwatched" });
  makeVideo(channel2.id, { status: "watching" });
  makeVideo(channel2.id, { status: "watched" });
  makeVideo(channel2.id, { status: "ignored" });

  const after = getNavCounts(defaultUser.id);

  expect(after.queueCount - before.queueCount).toBe(2);
});

test("continueWatchingCount only counts watching, not unwatched", () => {
  const channel = makeChannel("Nav Counts Channel B");
  makeSubscription(channel.id);
  makeVideo(channel.id, { status: "unwatched" });

  const before = getNavCounts(defaultUser.id);

  makeVideo(channel.id, { status: "watching" });

  const after = getNavCounts(defaultUser.id);

  expect(after.continueWatchingCount - before.continueWatchingCount).toBe(1);
  expect(after.queueCount - before.queueCount).toBe(1);
});

test("watchedCount counts watched videos even after the subscription is unsubscribed, while queueCount/continueWatchingCount do not", () => {
  const channel = makeChannel("Nav Counts Channel C");
  const subscription = makeSubscription(channel.id);
  makeVideo(channel.id, { status: "watched" });
  makeVideo(channel.id, { status: "unwatched" });
  makeVideo(channel.id, { status: "watching" });

  const before = getNavCounts(defaultUser.id);

  db.update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscriptions.id, subscription.id))
    .run();

  const after = getNavCounts(defaultUser.id);

  expect(after.watchedCount).toBe(before.watchedCount);
  expect(after.queueCount).toBe(before.queueCount - 2);
  expect(after.continueWatchingCount).toBe(before.continueWatchingCount - 1);
});
