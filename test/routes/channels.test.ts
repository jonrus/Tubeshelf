import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rssUrlFor } from "../../src/lib/channel-input";

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

// Pads a label out to a valid 22-character channel ID suffix rather than
// hand-counting characters in string literals for every test.
function channelId(label: string): string {
  return `UC${(label + "A".repeat(22)).slice(0, 22)}`;
}

function feedXml(
  title: string,
  entries: { id: string; title: string; published: string }[],
): string {
  const entryXml = entries
    .map(
      (e) => `  <entry>
    <id>yt:video:${e.id}</id>
    <title>${e.title}</title>
    <published>${e.published}</published>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>${title}</title>
${entryXml}
</feed>`;
}

// mockImplementation (rather than mockResolvedValue) so each call gets a
// fresh Response — the two-step flow can fetch more than once per test, and
// a shared Response instance's body can only be read once.
function mockFetch(xml: string, status = 200) {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () => new Response(xml, { status })) as unknown as typeof fetch,
  );
}

function postPreview(channelInput: string, categoryId = "") {
  return channelsRoute.request("/subscriptions/preview", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channelInput, categoryId }),
  });
}

function postConfirm(fields: Record<string, string>) {
  return channelsRoute.request("/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function deleteSubscription(id: number) {
  return channelsRoute.request(`/subscriptions/${id}`, { method: "DELETE" });
}

function dismissMissedVideos(id: number) {
  return channelsRoute.request(`/subscriptions/${id}/dismiss-missed-videos`, {
    method: "POST",
  });
}

// Extracts the categoryId hidden field's value out of a preview response's
// HTML, so tests round-trip through the real rendered value instead of
// hardcoding a guess at what preview would have produced.
function extractCategoryId(previewHtml: string): string {
  const match = previewHtml.match(/name="categoryId" value="([^"]*)"/);
  if (!match || match[1] === undefined)
    throw new Error("preview response has no categoryId hidden field");
  return match[1];
}

// The subscription list HTML accumulates every subscription created across
// this whole test file (no per-test isolation of the shared in-memory DB), so
// asserting the badge's presence/absence must scope to a single channel's
// <li> rather than the full document.
function extractSubscriptionRow(html: string, channelName: string): string {
  const escaped = channelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<li[^>]*>${escaped}[\\s\\S]*?</li>`));
  if (!match) throw new Error(`no subscription row found for "${channelName}"`);
  return match[0];
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

test("subscribe -> unsubscribe -> resubscribe cycle", async () => {
  const id = channelId("cycleChannel");
  const rssUrl = rssUrlFor(id);
  const channelUrl = `https://www.youtube.com/channel/${id}`;

  fetchSpy = mockFetch(feedXml("Cycle Channel", []));

  const previewRes = await postPreview(channelUrl);
  expect(previewRes.status).toBe(200);
  const previewHtml = await previewRes.text();
  expect(previewHtml).toContain("Cycle Channel");
  expect(previewHtml).toContain("Confirm Subscribe");

  const confirmRes = await postConfirm({
    channelId: id,
    categoryId: extractCategoryId(previewHtml),
  });
  expect(confirmRes.status).toBe(200);
  const confirmHtml = await confirmRes.text();
  expect(confirmHtml).toContain("Uncategorized");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  if (!channel) throw new Error("confirm did not create youtube_channels row");
  expect(channel.rssUrl).toBe(rssUrl);

  const activeSub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  if (!activeSub) throw new Error("confirm did not create subscriptions row");
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
  // than the /channel/<id> URL used above) plus a real category. The channel
  // already exists at this point, so preview uses the stored name (no fetch)
  // and confirm's fetch is the ingest refresh, not a title lookup.
  const resubscribePreviewRes = await postPreview(id, String(realCategory.id));
  expect(resubscribePreviewRes.status).toBe(200);
  const resubscribePreviewHtml = await resubscribePreviewRes.text();
  expect(resubscribePreviewHtml).toContain("Cycle Channel");

  const resubscribeConfirmRes = await postConfirm({
    channelId: id,
    categoryId: String(realCategory.id),
  });
  expect(resubscribeConfirmRes.status).toBe(200);
  const resubscribeConfirmHtml = await resubscribeConfirmRes.text();
  expect(resubscribeConfirmHtml).toContain("Tech");

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
  const id = channelId("blankCategory");
  fetchSpy = mockFetch(feedXml("Blank Category Channel", []));

  const previewRes = await postPreview(id, "");
  expect(previewRes.status).toBe(200);
  const previewHtml = await previewRes.text();

  const confirmRes = await postConfirm({
    channelId: id,
    categoryId: extractCategoryId(previewHtml),
  });
  expect(confirmRes.status).toBe(200);

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  if (!channel) throw new Error("confirm did not create youtube_channels row");
  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub?.categoryId).toBe(systemCategory.id);
});

test("subscribing with no category selected round-trips through preview to a successful confirm", async () => {
  const id = channelId("blankRoundTrip");
  fetchSpy = mockFetch(feedXml("Blank Round Trip Channel", []));

  const previewRes = await postPreview(id, "");
  expect(previewRes.status).toBe(200);
  const previewHtml = await previewRes.text();
  const extractedCategoryId = extractCategoryId(previewHtml);

  const confirmRes = await postConfirm({
    channelId: id,
    categoryId: extractedCategoryId,
  });
  expect(confirmRes.status).toBe(200);
  const confirmHtml = await confirmRes.text();
  expect(confirmHtml).not.toContain("Invalid category.");
  expect(confirmHtml).toContain("Uncategorized");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  if (!channel) throw new Error("confirm did not create youtube_channels row");
  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub?.categoryId).toBe(systemCategory.id);
});

test("an explicit system-category id is rejected inline at preview", async () => {
  const id = channelId("sysCatReject");
  fetchSpy = mockFetch(feedXml("System Reject Channel", []));

  const res = await postPreview(id, String(systemCategory.id));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Invalid category.");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  expect(channel).toBeUndefined();
});

test("preview renders the real fetched name and writes nothing to any table", async () => {
  const id = channelId("previewOnly");
  fetchSpy = mockFetch(feedXml("Preview Only Channel", []));

  const res = await postPreview(id);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Preview Only Channel");
  expect(html).toContain("Confirm Subscribe");
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  expect(channel).toBeUndefined();
});

test("confirm creates the subscription and populates videos in one round trip", async () => {
  const id = channelId("confirmVideos");
  const entries = [
    {
      id: "confirmVideos-vid1",
      title: "Video One",
      published: "2026-07-01T00:00:00+00:00",
    },
    {
      id: "confirmVideos-vid2",
      title: "Video Two",
      published: "2026-07-02T00:00:00+00:00",
    },
  ];
  fetchSpy = mockFetch(feedXml("Confirm Videos Channel", entries));

  const previewRes = await postPreview(id);
  expect(previewRes.status).toBe(200);
  const previewHtml = await previewRes.text();
  expect(previewHtml).toContain("Confirm Videos Channel");

  const confirmRes = await postConfirm({ channelId: id, categoryId: "" });
  expect(confirmRes.status).toBe(200);

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, id))
    .get();
  if (!channel) throw new Error("confirm did not create youtube_channels row");

  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub).toBeTruthy();
  expect(sub?.unsubscribedAt).toBeNull();

  const channelVideos = db
    .select()
    .from(videos)
    .where(eq(videos.channelId, channel.id))
    .all();
  expect(channelVideos.map((v) => v.youtubeVideoId).sort()).toEqual([
    "confirmVideos-vid1",
    "confirmVideos-vid2",
  ]);
});

test("confirming an already-known channel only fetches to ingest, not to learn its name", async () => {
  const id = channelId("alreadyKnown");
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: id,
      name: "Already Known Channel",
      rssUrl: rssUrlFor(id),
    })
    .returning()
    .get();

  fetchSpy = mockFetch(
    feedXml("Already Known Channel", [
      {
        id: "alreadyKnown-vid1",
        title: "Known Video",
        published: "2026-07-15T00:00:00+00:00",
      },
    ]),
  );

  const res = await postConfirm({ channelId: id, categoryId: "" });
  expect(res.status).toBe(200);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(rssUrlFor(id));

  const channelVideos = db
    .select()
    .from(videos)
    .where(eq(videos.channelId, channel.id))
    .all();
  expect(channelVideos.map((v) => v.youtubeVideoId)).toEqual([
    "alreadyKnown-vid1",
  ]);

  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub?.unsubscribedAt).toBeNull();
});

test("confirm rejects a malformed channelId that skipped preview", async () => {
  const res = await postConfirm({
    channelId: "not-a-real-channel-id",
    categoryId: "",
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Invalid channel.");

  const channel = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, "not-a-real-channel-id"))
    .get();
  expect(channel).toBeUndefined();
});

test("confirm derives the fetch URL from channelId alone, ignoring any other field", async () => {
  const id = channelId("ssrfGuard");
  fetchSpy = mockFetch(feedXml("SSRF Guard Channel", []));

  const res = await postConfirm({
    channelId: id,
    categoryId: "",
    rssUrl: "https://evil.example.com/feed.xml",
  });
  expect(res.status).toBe(200);

  expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
  for (const call of fetchSpy.mock.calls) {
    expect(call[0]).toBe(rssUrlFor(id));
  }
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

test("a subscription to a channel with a detected gap and no dismissal shows the badge", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCgapNoDismAAAAAAAAAAAAA",
      name: "Gap No Dismiss Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCgapNoDismAAAAAAAAAAAAA",
      possibleMissedVideosDetectedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .get();

  db.insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
      missedVideosDismissedAt: null,
    })
    .run();

  const res = await channelsRoute.request("/channels");
  expect(res.status).toBe(200);
  const html = await res.text();
  const row = extractSubscriptionRow(html, "Gap No Dismiss Channel");
  expect(row).toContain("Possible missed videos");
});

test("dismissing a missed-videos notice removes the badge and re-renders the list", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCgapDismissAAAAAAAAAAAA",
      name: "Gap Dismiss Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCgapDismissAAAAAAAAAAAA",
      possibleMissedVideosDetectedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .get();

  const sub = db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
      missedVideosDismissedAt: null,
    })
    .returning()
    .get();

  const res = await dismissMissedVideos(sub.id);
  expect(res.status).toBe(200);
  const html = await res.text();
  const row = extractSubscriptionRow(html, "Gap Dismiss Channel");
  expect(row).not.toContain("Possible missed videos");

  const updated = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, sub.id))
    .get();
  expect(updated?.missedVideosDismissedAt).not.toBeNull();
});

test("a dismissal older than the channel's (re-)detection timestamp still shows the badge", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCgapRetrigAAAAAAAAAAAAA",
      name: "Gap Retrigger Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCgapRetrigAAAAAAAAAAAAA",
      possibleMissedVideosDetectedAt: new Date("2026-02-01T00:00:00Z"),
    })
    .returning()
    .get();

  db.insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
      missedVideosDismissedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .run();

  const res = await channelsRoute.request("/channels");
  expect(res.status).toBe(200);
  const html = await res.text();
  const row = extractSubscriptionRow(html, "Gap Retrigger Channel");
  expect(row).toContain("Possible missed videos");
});

test("dismissing another user's subscription 404s", async () => {
  const otherUser = db
    .insert(users)
    .values({ username: "dismiss-other" })
    .returning()
    .get();

  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCdismOtherAAAAAAAAAAAAA",
      name: "Dismiss Other Owner Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCdismOtherAAAAAAAAAAAAA",
      possibleMissedVideosDetectedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .get();

  const othersSub = db
    .insert(subscriptions)
    .values({
      userId: otherUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
      missedVideosDismissedAt: null,
    })
    .returning()
    .get();

  const res = await dismissMissedVideos(othersSub.id);
  expect(res.status).toBe(404);

  const untouched = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, othersSub.id))
    .get();
  expect(untouched?.missedVideosDismissedAt).toBeNull();
});

test("dismissing an already-unsubscribed subscription 404s", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCdismUnsubAAAAAAAAAAAAA",
      name: "Dismiss Unsubscribed Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCdismUnsubAAAAAAAAAAAAA",
      possibleMissedVideosDetectedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .get();

  const sub = db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
      unsubscribedAt: new Date(),
      missedVideosDismissedAt: null,
    })
    .returning()
    .get();

  const res = await dismissMissedVideos(sub.id);
  expect(res.status).toBe(404);

  const untouched = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, sub.id))
    .get();
  expect(untouched?.missedVideosDismissedAt).toBeNull();
});

test("a channel's row shows its unwatched video count", async () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCunwatchCntAAAAAAAAAAAA",
      name: "Unwatched Count Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCunwatchCntAAAAAAAAAAAA",
    })
    .returning()
    .get();

  db.insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channel.id,
      categoryId: systemCategory.id,
    })
    .run();

  db.insert(videos)
    .values([
      {
        channelId: channel.id,
        youtubeVideoId: "unwatch-cnt-vid1",
        title: "Unwatched Video",
        status: "unwatched",
      },
      {
        channelId: channel.id,
        youtubeVideoId: "unwatch-cnt-vid2",
        title: "Watching Video",
        status: "watching",
      },
      {
        channelId: channel.id,
        youtubeVideoId: "unwatch-cnt-vid3",
        title: "Watched Video",
        status: "watched",
        watchedAt: new Date(),
      },
    ])
    .run();

  const res = await channelsRoute.request("/channels");
  expect(res.status).toBe(200);
  const html = await res.text();
  const row = extractSubscriptionRow(html, "Unwatched Count Channel");
  expect(row).toContain("Unwatched Count Channel (2)");
});

test("a brand-new subscription to a channel with a pre-existing old gap does not show the badge", async () => {
  const id = channelId("preExistingGap");
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: id,
      name: "Pre-Existing Gap Channel",
      rssUrl: rssUrlFor(id),
      possibleMissedVideosDetectedAt: new Date("2020-01-01T00:00:00Z"),
    })
    .returning()
    .get();

  fetchSpy = mockFetch(feedXml("Pre-Existing Gap Channel", []));

  const res = await postConfirm({ channelId: id, categoryId: "" });
  expect(res.status).toBe(200);
  const html = await res.text();
  const row = extractSubscriptionRow(html, "Pre-Existing Gap Channel");
  expect(row).not.toContain("Possible missed videos");

  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .get();
  expect(sub?.missedVideosDismissedAt).not.toBeNull();
});
