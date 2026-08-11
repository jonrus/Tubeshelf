import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// listCategoriesWithCounts operates against the module-level `db` singleton
// in src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must
// be set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, videos, youtubeChannels } =
  await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { listCategoriesWithCounts } = await import("../../src/lib/categories");

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
  const youtubeChannelId = `UCcategoriesLibTest${String(channelCounter).padStart(6, "0")}`;
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
  categoryId: number,
  opts?: { userId?: number; unsubscribedAt?: Date },
) {
  return db
    .insert(subscriptions)
    .values({
      userId: opts?.userId ?? defaultUser.id,
      youtubeChannelId: channelId,
      categoryId,
      unsubscribedAt: opts?.unsubscribedAt,
    })
    .returning()
    .get();
}

let videoCounter = 0;
function makeVideo(
  channelId: number,
  status: "unwatched" | "watching" | "watched" | "ignored",
) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId,
      youtubeVideoId: `vid-categories-lib-test-${videoCounter}`,
      title: `Categories Lib Test Video ${videoCounter}`,
      status,
      watchedAt: status === "watched" ? new Date() : null,
      ignoreMethod: status === "ignored" ? "manual" : null,
    })
    .returning()
    .get();
}

test("listCategoriesWithCounts includes a category's unwatched+watching count and orders the system category first", () => {
  const category = db
    .insert(categories)
    .values({ name: "Lib Count Category" })
    .returning()
    .get();
  const channel = makeChannel("Lib Count Category Channel");
  makeSubscription(channel.id, category.id);
  makeVideo(channel.id, "unwatched");
  makeVideo(channel.id, "watching");
  makeVideo(channel.id, "watched");
  makeVideo(channel.id, "ignored");

  const result = listCategoriesWithCounts(defaultUser.id);

  const found = result.find((c) => c.id === category.id);
  expect(found).toBeTruthy();
  expect(found?.unwatchedCount).toBe(2);
  expect(found?.name).toBe(category.name);
  expect(found?.isSystem).toBe(false);
  expect(found?.createdAt).toBeInstanceOf(Date);

  expect(result[0]?.id).toBe(systemCategory.id);
});

test("listCategoriesWithCounts' channelCount is 0 for a category with no subscriptions", () => {
  const category = db
    .insert(categories)
    .values({ name: "Lib Channel Count Empty Category" })
    .returning()
    .get();

  const result = listCategoriesWithCounts(defaultUser.id);

  const found = result.find((c) => c.id === category.id);
  expect(found?.channelCount).toBe(0);
});

test("listCategoriesWithCounts' channelCount is 1 for a category with one subscription", () => {
  const category = db
    .insert(categories)
    .values({ name: "Lib Channel Count Single Category" })
    .returning()
    .get();
  const channel = makeChannel("Lib Channel Count Single Channel");
  makeSubscription(channel.id, category.id);

  const result = listCategoriesWithCounts(defaultUser.id);

  const found = result.find((c) => c.id === category.id);
  expect(found?.channelCount).toBe(1);
});

test("listCategoriesWithCounts' channelCount counts subscriptions across users and includes unsubscribed rows", () => {
  const category = db
    .insert(categories)
    .values({ name: "Lib Channel Count Multi Category" })
    .returning()
    .get();
  const otherUser = db
    .insert(users)
    .values({ username: "categories-lib-test-other-user" })
    .returning()
    .get();

  const activeChannel = makeChannel("Lib Channel Count Active Channel");
  makeSubscription(activeChannel.id, category.id);

  const otherUserChannel = makeChannel("Lib Channel Count Other User Channel");
  makeSubscription(otherUserChannel.id, category.id, {
    userId: otherUser.id,
  });

  const unsubscribedChannel = makeChannel(
    "Lib Channel Count Unsubscribed Channel",
  );
  makeSubscription(unsubscribedChannel.id, category.id, {
    unsubscribedAt: new Date(),
  });

  const result = listCategoriesWithCounts(defaultUser.id);

  const found = result.find((c) => c.id === category.id);
  expect(found?.channelCount).toBe(3);
});
