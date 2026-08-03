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

function makeSubscription(channelId: number, categoryId: number) {
  return db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channelId,
      categoryId,
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
