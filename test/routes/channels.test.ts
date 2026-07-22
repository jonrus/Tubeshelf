import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

// channelsRoute operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time — so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, videos, youtubeChannels } =
  await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { channelsRoute } = await import("../../src/routes/channels");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const defaultUser = db
  .select()
  .from(users)
  .where(eq(users.username, "default"))
  .get();
if (!defaultUser) throw new Error("seed did not create the default user");

const systemCategory = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!systemCategory) throw new Error("seed did not create the system category");

const realCategory = db
  .insert(categories)
  .values({ name: "Tech" })
  .returning()
  .get();

function mockFetchOnce(xml: string, status = 200) {
  return spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status }),
  );
}

function postSubscription(channelInput: string, categoryId = "") {
  return channelsRoute.request("/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channelInput, categoryId }),
  });
}

function deleteSubscription(id: number) {
  return channelsRoute.request(`/subscriptions/${id}`, { method: "DELETE" });
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

test("subscribe -> unsubscribe -> resubscribe cycle", async () => {
  const channelId = "UCcycleCh1AAAAAAAAAAAAAA";
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const channelUrl = `https://www.youtube.com/channel/${channelId}`;

  fetchSpy = mockFetchOnce(
    `<?xml version="1.0" encoding="UTF-8"?><feed><title>Cycle Channel</title></feed>`,
  );

  const subscribeRes = await postSubscription(channelUrl);
  expect(subscribeRes.status).toBe(200);
  const subscribeHtml = await subscribeRes.text();
  expect(subscribeHtml).toContain("Cycle Channel");
  expect(subscribeHtml).toContain("Uncategorized");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, channelId))
    .get();
  if (!channel)
    throw new Error("subscribe did not create youtube_channels row");
  expect(channel.rssUrl).toBe(rssUrl);

  const activeSub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  if (!activeSub) throw new Error("subscribe did not create subscriptions row");
  const subscriptionId = activeSub.id;

  const unsubscribeRes = await deleteSubscription(subscriptionId);
  expect(unsubscribeRes.status).toBe(200);
  const unsubscribeHtml = await unsubscribeRes.text();
  expect(unsubscribeHtml).not.toContain("Cycle Channel");

  const inactiveSub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .get();
  expect(inactiveSub?.unsubscribedAt).not.toBeNull();

  // Re-subscribe using the raw channel ID this time (a different input form
  // than the /channel/<id> URL used above) plus a real category.
  const resubscribeRes = await postSubscription(
    channelId,
    String(realCategory.id),
  );
  expect(resubscribeRes.status).toBe(200);
  const resubscribeHtml = await resubscribeRes.text();
  expect(resubscribeHtml).toContain("Cycle Channel");
  expect(resubscribeHtml).toContain("Tech");

  const reactivatedSub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .get();
  expect(reactivatedSub?.unsubscribedAt).toBeNull();
  expect(reactivatedSub?.youtubeChannelId).toBe(channel.id);
  expect(reactivatedSub?.categoryId).toBe(realCategory.id);

  const allSubsForChannel = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .all();
  expect(allSubsForChannel).toHaveLength(1);
});

test("blank categoryId resolves to the system category", async () => {
  const channelId = "UCblankCatAAAAAAAAAAAAAA";
  fetchSpy = mockFetchOnce(
    `<?xml version="1.0" encoding="UTF-8"?><feed><title>Blank Category Channel</title></feed>`,
  );

  const res = await postSubscription(channelId, "");
  expect(res.status).toBe(200);

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, channelId))
    .get();
  if (!channel)
    throw new Error("subscribe did not create youtube_channels row");
  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub?.categoryId).toBe(systemCategory.id);
});

test("an explicit system-category id is rejected inline", async () => {
  const channelId = "UCsysRejecAAAAAAAAAAAAAA";
  fetchSpy = mockFetchOnce(
    `<?xml version="1.0" encoding="UTF-8"?><feed><title>System Reject Channel</title></feed>`,
  );

  const res = await postSubscription(channelId, String(systemCategory.id));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Invalid category.");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, channelId))
    .get();
  expect(channel).toBeUndefined();
});

test("unsubscribe is scoped to the current user and 404s on another user's row", async () => {
  const otherUser = db
    .insert(users)
    .values({ username: "other" })
    .returning()
    .get();

  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCownerScoAAAAAAAAAAAAAA",
      name: "Owner Scoped Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCownerScoAAAAAAAAAAAAAA",
    })
    .returning()
    .get();

  const othersSub = db
    .insert(subscriptions)
    .values({
      userId: otherUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
    })
    .returning()
    .get();

  const res = await deleteSubscription(othersSub.id);
  expect(res.status).toBe(404);

  const untouched = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, othersSub.id))
    .get();
  expect(untouched?.unsubscribedAt).toBeNull();
  expect(untouched?.userId).toBe(otherUser.id);
});

test("unsubscribe never touches videos rows", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCvideoUntAAAAAAAAAAAAAA",
      name: "Video Untouched Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCvideoUntAAAAAAAAAAAAAA",
    })
    .returning()
    .get();

  const sub = db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
    })
    .returning()
    .get();

  const video = db
    .insert(videos)
    .values({
      channelId: channel.id,
      youtubeVideoId: "vid-untouched-1",
      title: "Untouched Video",
    })
    .returning()
    .get();

  const res = await deleteSubscription(sub.id);
  expect(res.status).toBe(200);

  const videoAfter = db
    .select()
    .from(videos)
    .where(eq(videos.id, video.id))
    .get();
  expect(videoAfter).toEqual(video);
});
