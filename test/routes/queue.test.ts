import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loginAsAdminUser } from "../helpers/auth";

// queueRoute operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, videos, youtubeChannels } =
  await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { queueRoute } = await import("../../src/routes/queue");
const { getNavCounts } = await import("../../src/lib/nav-counts");
const { youtubeThumbnailUrl, youtubeWatchUrl } = await import(
  "../../src/lib/youtube"
);

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const { cookie, origin } = await loginAsAdminUser();
const authHeaders = { Cookie: cookie, Origin: origin };

const defaultUserRow = db
  .select()
  .from(users)
  .where(eq(users.username, "admin"))
  .get();
if (!defaultUserRow) throw new Error("seed did not create the default user");
const defaultUser = defaultUserRow;

const category = db
  .insert(categories)
  .values({ name: "Queue Test Category" })
  .returning()
  .get();

const otherCategory = db
  .insert(categories)
  .values({ name: "Other Queue Test Category" })
  .returning()
  .get();

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
  const youtubeChannelId = `UCqueueTest${String(channelCounter).padStart(9, "0")}`;
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
      categoryId: opts.categoryId ?? category.id,
      unsubscribedAt: opts.unsubscribed ? new Date() : null,
    })
    .returning()
    .get();
}

let videoCounter = 0;
function makeVideo(
  channelId: number,
  opts: {
    status?: "unwatched" | "watching" | "watched" | "ignored";
    publishedAt?: Date | null;
    watchedAt?: Date | null;
    ignoreMethod?: "manual" | "auto" | null;
  } = {},
) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId,
      youtubeVideoId: `vid-queue-test-${videoCounter}`,
      title: `Queue Test Video ${videoCounter}`,
      status: opts.status ?? "unwatched",
      publishedAt: opts.publishedAt,
      watchedAt: opts.watchedAt ?? null,
      ignoreMethod: opts.ignoreMethod ?? null,
    })
    .returning()
    .get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

test("GET / redirects to /queue", async () => {
  const res = await queueRoute.request("/", { headers: authHeaders });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/queue");
});

test("GET /queue returns unwatched/watching videos for active subscriptions, newest-first by default", async () => {
  const channel = makeChannel("Queue Channel A");
  makeSubscription(channel.id);
  const older = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const newer = makeVideo(channel.id, {
    status: "watching",
    publishedAt: new Date("2026-07-10T00:00:00Z"),
  });
  const watched = makeVideo(channel.id, {
    status: "watched",
    publishedAt: new Date("2026-07-15T00:00:00Z"),
    watchedAt: new Date("2026-07-16T00:00:00Z"),
  });

  const otherChannel = makeChannel("Queue Unsubscribed Channel");
  makeSubscription(otherChannel.id, { unsubscribed: true });
  const otherVideo = makeVideo(otherChannel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-07-20T00:00:00Z"),
  });

  const res = await queueRoute.request("/queue", { headers: authHeaders });
  expect(res.status).toBe(200);
  const html = await res.text();

  expect(html).toContain(newer.title);
  expect(html).toContain(older.title);
  expect(html).not.toContain(watched.title);
  expect(html).not.toContain(otherVideo.title);
  expect(html.indexOf(newer.title)).toBeLessThan(html.indexOf(older.title));
  expect(html).toContain(`/watching/${newer.id}?from=queue&amp;sort=newest`);
  expect(html).toContain('href="/queue?sort=oldest"');
});

test("GET /queue?sort=oldest inverts the order", async () => {
  const channel = makeChannel("Queue Sort Channel");
  makeSubscription(channel.id);
  const older = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-06-01T00:00:00Z"),
  });
  const newer = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-06-10T00:00:00Z"),
  });

  const res = await queueRoute.request("/queue?sort=oldest", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html.indexOf(older.title)).toBeLessThan(html.indexOf(newer.title));
  expect(html).toContain(`/watching/${older.id}?from=queue&amp;sort=oldest`);
  expect(html).toContain('href="/queue"');
});

test("GET /continue-watching returns only watching videos for active subscriptions", async () => {
  const channel = makeChannel("Continue Watching Channel");
  makeSubscription(channel.id);
  const watching = makeVideo(channel.id, {
    status: "watching",
    publishedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const unwatched = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-07-02T00:00:00Z"),
  });

  const otherChannel = makeChannel("Continue Watching Unsub Channel");
  makeSubscription(otherChannel.id, { unsubscribed: true });
  const otherWatching = makeVideo(otherChannel.id, {
    status: "watching",
    publishedAt: new Date("2026-07-03T00:00:00Z"),
  });

  const res = await queueRoute.request("/continue-watching", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(watching.title);
  expect(html).not.toContain(unwatched.title);
  expect(html).not.toContain(otherWatching.title);
  expect(html).toContain(`/watching/${watching.id}?from=continue-watching`);
});

test("GET /watched lists only watched videos, most-recently-watched-first, including a since-unsubscribed channel", async () => {
  const channel = makeChannel("Watched Channel");
  makeSubscription(channel.id);
  const earlierWatched = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const laterWatched = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-10T00:00:00Z"),
  });
  const unwatched = makeVideo(channel.id, { status: "unwatched" });

  const unsubChannel = makeChannel("Watched Then Unsubscribed Channel");
  const unsubSub = makeSubscription(unsubChannel.id);
  const historyVideo = makeVideo(unsubChannel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-05T00:00:00Z"),
  });
  db.update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscriptions.id, unsubSub.id))
    .run();

  const res = await queueRoute.request("/watched", { headers: authHeaders });
  expect(res.status).toBe(200);
  const html = await res.text();

  expect(html).toContain(laterWatched.title);
  expect(html).toContain(earlierWatched.title);
  expect(html).toContain(historyVideo.title);
  expect(html).not.toContain(unwatched.title);
  expect(html.indexOf(laterWatched.title)).toBeLessThan(
    html.indexOf(earlierWatched.title),
  );
  expect(html).toContain(`/watching/${laterWatched.id}?from=watched`);
});

test("GET /watched paginates: first page returns exactly PAGE_SIZE cards plus a load-more sentinel, and the sentinel's cursor fetches the remaining rows with no overlap or gap", async () => {
  const paginationCategory = db
    .insert(categories)
    .values({ name: "Pagination Test Category" })
    .returning()
    .get();
  const channel = makeChannel("Pagination Watched Channel");
  makeSubscription(channel.id, { categoryId: paginationCategory.id });

  const pageSize = 20;
  const total = pageSize + 1;
  const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
  const seeded = Array.from({ length: total }, (_, i) =>
    makeVideo(channel.id, {
      status: "watched",
      watchedAt: new Date(baseTime + i * 60_000),
    }),
  );
  // Newest-first order: highest index (most recently watched) comes first.
  const newestFirst = [...seeded].reverse();
  const firstPageExpected = newestFirst.slice(0, pageSize);
  const secondPageExpected = newestFirst.slice(pageSize);

  const firstRes = await queueRoute.request(
    `/watched?category=${paginationCategory.id}`,
    { headers: authHeaders },
  );
  expect(firstRes.status).toBe(200);
  const firstHtml = await firstRes.text();
  expect(firstHtml).toContain("<html");

  for (const v of firstPageExpected) expect(firstHtml).toContain(v.title);
  for (const v of secondPageExpected) expect(firstHtml).not.toContain(v.title);

  const sentinelMatch = firstHtml.match(
    /hx-get="(\/watched\?[^"]*cursor=[^"]*)"/,
  );
  const rawSentinelHref = sentinelMatch?.[1];
  if (rawSentinelHref === undefined) {
    throw new Error("expected a load-more sentinel in the first page");
  }
  const sentinelHref = rawSentinelHref.replace(/&amp;/g, "&");

  const secondRes = await queueRoute.request(sentinelHref, {
    headers: authHeaders,
  });
  expect(secondRes.status).toBe(200);
  const secondHtml = await secondRes.text();
  expect(secondHtml).not.toContain("<html");

  for (const v of secondPageExpected) expect(secondHtml).toContain(v.title);
  for (const v of firstPageExpected) expect(secondHtml).not.toContain(v.title);
  expect(secondHtml).not.toContain('hx-trigger="revealed"');
});

test("GET /watched paginates correctly when two videos share an identical watchedAt at the page boundary (id secondary sort, no duplicate or skip)", async () => {
  const tiebreakCategory = db
    .insert(categories)
    .values({ name: "Tiebreak Test Category" })
    .returning()
    .get();
  const channel = makeChannel("Tiebreak Watched Channel");
  makeSubscription(channel.id, { categoryId: tiebreakCategory.id });

  const tieAt = new Date("2026-02-01T00:00:00Z");
  const distinctVideos = Array.from({ length: 19 }, (_, i) =>
    makeVideo(channel.id, {
      status: "watched",
      watchedAt: new Date(tieAt.getTime() + (i + 1) * 60_000),
    }),
  );
  const tieA = makeVideo(channel.id, { status: "watched", watchedAt: tieAt });
  const tieB = makeVideo(channel.id, { status: "watched", watchedAt: tieAt });
  // tieA and tieB share watchedAt; tieB was inserted second so it has the
  // higher id and sorts first under desc(watchedAt), desc(id).

  const firstRes = await queueRoute.request(
    `/watched?category=${tiebreakCategory.id}`,
    { headers: authHeaders },
  );
  const firstHtml = await firstRes.text();
  for (const v of distinctVideos) expect(firstHtml).toContain(v.title);
  expect(firstHtml).toContain(tieB.title);
  expect(firstHtml).not.toContain(tieA.title);

  const sentinelMatch = firstHtml.match(
    /hx-get="(\/watched\?[^"]*cursor=[^"]*)"/,
  );
  const rawSentinelHref = sentinelMatch?.[1];
  if (rawSentinelHref === undefined) {
    throw new Error("expected a load-more sentinel in the first page");
  }
  const sentinelHref = rawSentinelHref.replace(/&amp;/g, "&");

  const secondRes = await queueRoute.request(sentinelHref, {
    headers: authHeaders,
  });
  const secondHtml = await secondRes.text();
  expect(secondHtml).toContain(tieA.title);
  expect(secondHtml).not.toContain(tieB.title);
  for (const v of distinctVideos) expect(secondHtml).not.toContain(v.title);
});

test("GET /queue?category=<id> only returns that category's videos", async () => {
  const channel = makeChannel("Category Filter Queue Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const inCategory = makeVideo(channel.id, { status: "unwatched" });

  const otherChannel = makeChannel("Category Filter Queue Other Channel");
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const inOtherCategory = makeVideo(otherChannel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/queue?category=${category.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(inCategory.title);
  expect(html).not.toContain(inOtherCategory.title);
});

test("GET /queue?category=<uncategorized id> returns exactly the Uncategorized-channel videos", async () => {
  const uncategorizedChannel = makeChannel(
    "Category Filter Uncategorized Channel",
  );
  makeSubscription(uncategorizedChannel.id, { categoryId: systemCategory.id });
  const uncategorizedVideo = makeVideo(uncategorizedChannel.id, {
    status: "unwatched",
  });

  const categorizedChannel = makeChannel("Category Filter Categorized Channel");
  makeSubscription(categorizedChannel.id, { categoryId: category.id });
  const categorizedVideo = makeVideo(categorizedChannel.id, {
    status: "unwatched",
  });

  const res = await queueRoute.request(`/queue?category=${systemCategory.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(uncategorizedVideo.title);
  expect(html).not.toContain(categorizedVideo.title);
});

test("GET /queue?category=<invalid or nonexistent> falls back to unfiltered, same as no category param", async () => {
  const channel = makeChannel("Category Filter Fallback Channel");
  makeSubscription(channel.id, { categoryId: otherCategory.id });
  const video = makeVideo(channel.id, { status: "unwatched" });

  const noParamRes = await queueRoute.request("/queue", {
    headers: authHeaders,
  });
  const noParamHtml = await noParamRes.text();
  expect(noParamHtml).toContain(video.title);

  const invalidRes = await queueRoute.request("/queue?category=not-a-number", {
    headers: authHeaders,
  });
  const invalidHtml = await invalidRes.text();
  expect(invalidHtml).toContain(video.title);

  const nonexistentRes = await queueRoute.request("/queue?category=999999", {
    headers: authHeaders,
  });
  const nonexistentHtml = await nonexistentRes.text();
  expect(nonexistentHtml).toContain(video.title);
});

test("GET /queue?category=<id>&sort=oldest composes filtering with sort", async () => {
  const channel = makeChannel("Category Filter Sort Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const older = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-05-01T00:00:00Z"),
  });
  const newer = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-05-10T00:00:00Z"),
  });

  const otherChannel = makeChannel("Category Filter Sort Other Channel");
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const otherVideo = makeVideo(otherChannel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-05-05T00:00:00Z"),
  });

  const res = await queueRoute.request(
    `/queue?category=${category.id}&sort=oldest`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(otherVideo.title);
  expect(html.indexOf(older.title)).toBeLessThan(html.indexOf(newer.title));
});

test("GET /continue-watching?category=<id> only returns that category's videos", async () => {
  const channel = makeChannel("Category Filter Continue Watching Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const inCategory = makeVideo(channel.id, { status: "watching" });

  const otherChannel = makeChannel(
    "Category Filter Continue Watching Other Channel",
  );
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const inOtherCategory = makeVideo(otherChannel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/continue-watching?category=${category.id}`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(inCategory.title);
  expect(html).not.toContain(inOtherCategory.title);
});

test("GET /watched?category=<id> only returns that category's videos, including a since-unsubscribed channel's history", async () => {
  const channel = makeChannel("Category Filter Watched Channel");
  const sub = makeSubscription(channel.id, { categoryId: category.id });
  const historyVideo = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });
  db.update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscriptions.id, sub.id))
    .run();

  const otherChannel = makeChannel("Category Filter Watched Other Channel");
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const otherVideo = makeVideo(otherChannel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-02T00:00:00Z"),
  });

  const res = await queueRoute.request(`/watched?category=${category.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(historyVideo.title);
  expect(html).not.toContain(otherVideo.title);
});

test("GET /queue, /continue-watching, /watched, /ignored each render a sidebar link per existing category", async () => {
  for (const path of ["/queue", "/continue-watching", "/watched", "/ignored"]) {
    const res = await queueRoute.request(path, { headers: authHeaders });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`>${category.name} (`);
    expect(html).toContain(`>${otherCategory.name} (`);
    expect(html).toContain(">Uncategorized (");
  }
});

test("GET /queue, /continue-watching, /watched, /ignored each highlight exactly the matching top-level sidebar link", async () => {
  const routes: Record<string, string> = {
    "/queue": "Queue",
    "/continue-watching": "Continue Watching",
    "/watched": "Watched",
    "/ignored": "Ignored",
  };
  for (const [path, activeLabel] of Object.entries(routes)) {
    const res = await queueRoute.request(path, { headers: authHeaders });
    const html = await res.text();
    const activeLinks = [
      ...html.matchAll(/<a href="[^"]*" data-active="true"[^>]*>([^(<]*)/g),
    ].map((m) => m[1]?.trim());
    expect(activeLinks).toEqual([activeLabel]);
  }
});

test("GET /watched?category=<id> highlights that category's sidebar sub-item, but not /categories's own link", async () => {
  const res = await queueRoute.request(`/watched?category=${category.id}`, {
    headers: authHeaders,
  });
  const html = await res.text();
  expect(html).toContain(
    `href="/watched?category=${category.id}" data-active="true"`,
  );
  expect(html).toContain('href="/categories" data-active="false"');
});

test("A sidebar category link on /ignored?category=<id> stays view-aware, pointing at /ignored (not /queue)", async () => {
  const res = await queueRoute.request(`/ignored?category=${category.id}`, {
    headers: authHeaders,
  });
  const html = await res.text();
  const linkMatch = html.match(
    new RegExp(`href="(/ignored\\?category=${otherCategory.id})"`),
  );
  expect(linkMatch).not.toBeNull();
  expect(html).not.toContain(`href="/queue?category=${otherCategory.id}"`);
});

test("GET /queue's category links preserve sort, and sort links preserve category", async () => {
  const sortedRes = await queueRoute.request("/queue?sort=oldest", {
    headers: authHeaders,
  });
  const sortedHtml = await sortedRes.text();
  expect(sortedHtml).toContain(
    `href="/queue?sort=oldest&amp;category=${category.id}"`,
  );

  const filteredRes = await queueRoute.request(
    `/queue?category=${category.id}`,
    { headers: authHeaders },
  );
  const filteredHtml = await filteredRes.text();
  expect(filteredHtml).toContain(
    `href="/queue?sort=oldest&amp;category=${category.id}"`,
  );
});

test("GET /watching/:id 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/watching/999999", {
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("GET /watching/:id 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Watching Page No Subscription Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/watching/${video.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("GET /watching/:id shows Mark Watched and the auto-timer element for a non-watched video", async () => {
  const channel = makeChannel("Watching Page Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/watching/${video.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Mark Watched &amp; Return to Queue");
  expect(html).toContain('hx-trigger="load delay:10s"');
  expect(html).toContain(`/videos/${video.id}/watching`);
});

test("GET /watching/:id shows Mark Unwatched and hides the auto-timer for a watched video", async () => {
  const channel = makeChannel("Watching Page Watched Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });

  const res = await queueRoute.request(`/watching/${video.id}`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Mark Unwatched &amp; Return to Queue");
  expect(html).not.toContain('hx-trigger="load delay:10s"');
});

test("GET /watching/:id resolves the return target from from/sort, with fallback for missing/unrecognized from", async () => {
  const channel = makeChannel("Return Target Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "unwatched" });

  const continueRes = await queueRoute.request(
    `/watching/${video.id}?from=continue-watching`,
    { headers: authHeaders },
  );
  const continueHtml = await continueRes.text();
  expect(continueHtml).toContain("Return to Continue Watching");
  expect(continueHtml).toContain('href="/continue-watching"');

  const watchedRes = await queueRoute.request(
    `/watching/${video.id}?from=watched`,
    { headers: authHeaders },
  );
  const watchedHtml = await watchedRes.text();
  expect(watchedHtml).toContain("Return to Watched");
  expect(watchedHtml).toContain('href="/watched"');

  const queueSortRes = await queueRoute.request(
    `/watching/${video.id}?from=queue&sort=oldest`,
    { headers: authHeaders },
  );
  const queueSortHtml = await queueSortRes.text();
  expect(queueSortHtml).toContain("Return to Queue");
  expect(queueSortHtml).toContain('href="/queue?sort=oldest"');
  expect(queueSortHtml).toContain(
    `action="/videos/${video.id}/watched-toggle?from=queue&amp;sort=oldest"`,
  );

  const queueCategoryRes = await queueRoute.request(
    `/watching/${video.id}?from=queue&sort=oldest&category=${category.id}`,
    { headers: authHeaders },
  );
  const queueCategoryHtml = await queueCategoryRes.text();
  expect(queueCategoryHtml).toContain("Return to Queue");
  expect(queueCategoryHtml).toContain(
    `href="/queue?sort=oldest&amp;category=${category.id}"`,
  );
  expect(queueCategoryHtml).toContain(
    `action="/videos/${video.id}/watched-toggle?from=queue&amp;sort=oldest&amp;category=${category.id}"`,
  );

  const continueCategoryRes = await queueRoute.request(
    `/watching/${video.id}?from=continue-watching&category=${category.id}`,
    { headers: authHeaders },
  );
  const continueCategoryHtml = await continueCategoryRes.text();
  expect(continueCategoryHtml).toContain("Return to Continue Watching");
  expect(continueCategoryHtml).toContain(
    `href="/continue-watching?category=${category.id}"`,
  );

  const watchedCategoryRes = await queueRoute.request(
    `/watching/${video.id}?from=watched&category=${category.id}`,
    { headers: authHeaders },
  );
  const watchedCategoryHtml = await watchedCategoryRes.text();
  expect(watchedCategoryHtml).toContain("Return to Watched");
  expect(watchedCategoryHtml).toContain(
    `href="/watched?category=${category.id}"`,
  );

  const bogusRes = await queueRoute.request(
    `/watching/${video.id}?from=bogus`,
    { headers: authHeaders },
  );
  const bogusHtml = await bogusRes.text();
  expect(bogusHtml).toContain("Return to Queue");
  expect(bogusHtml).toContain('href="/queue"');

  const noQueryRes = await queueRoute.request(`/watching/${video.id}`, {
    headers: authHeaders,
  });
  const noQueryHtml = await noQueryRes.text();
  expect(noQueryHtml).toContain("Return to Queue");
  expect(noQueryHtml).toContain('href="/queue"');
});

test("POST /videos/:id/watching always sets watching, regardless of prior status", async () => {
  const channel = makeChannel("Set Watching Channel");
  makeSubscription(channel.id);

  const unwatchedVideo = makeVideo(channel.id, { status: "unwatched" });
  const unwatchedRes = await queueRoute.request(
    `/videos/${unwatchedVideo.id}/watching`,
    { method: "POST", headers: authHeaders },
  );
  expect(unwatchedRes.status).toBe(200);
  expect(videoRow(unwatchedVideo.id).status).toBe("watching");

  const watchedVideo = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });
  const watchedRes = await queueRoute.request(
    `/videos/${watchedVideo.id}/watching`,
    { method: "POST", headers: authHeaders },
  );
  expect(watchedRes.status).toBe(200);
  expect(videoRow(watchedVideo.id).status).toBe("watching");
});

test("POST /videos/:id/watching 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/watching", {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/watching 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Watching No Subscription Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/videos/${video.id}/watching`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("POST /videos/:id/watched-toggle transitions watching to watched (regression case), not unwatched", async () => {
  const channel = makeChannel("Watched Toggle Regression Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/watched-toggle?from=queue&sort=newest`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(303);
  expect(videoRow(video.id).status).toBe("watched");
  expect(videoRow(video.id).watchedAt).not.toBeNull();
});

test("POST /videos/:id/watched-toggle transitions watched to unwatched", async () => {
  const channel = makeChannel("Watched Toggle Unwatch Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });

  const res = await queueRoute.request(`/videos/${video.id}/watched-toggle`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(303);
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("POST /videos/:id/watched-toggle redirects to resolveReturnTarget's url for all from values plus the fallback", async () => {
  const channel = makeChannel("Watched Toggle Redirect Channel");
  makeSubscription(channel.id);

  const queueVideo = makeVideo(channel.id, { status: "unwatched" });
  const queueRes = await queueRoute.request(
    `/videos/${queueVideo.id}/watched-toggle?from=queue&sort=oldest`,
    { method: "POST", headers: authHeaders },
  );
  expect(queueRes.status).toBe(303);
  expect(queueRes.headers.get("location")).toBe("/queue?sort=oldest");

  const queueCategoryVideo = makeVideo(channel.id, { status: "unwatched" });
  const queueCategoryRes = await queueRoute.request(
    `/videos/${queueCategoryVideo.id}/watched-toggle?from=queue&sort=oldest&category=${category.id}`,
    { method: "POST", headers: authHeaders },
  );
  expect(queueCategoryRes.status).toBe(303);
  expect(queueCategoryRes.headers.get("location")).toBe(
    `/queue?sort=oldest&category=${category.id}`,
  );

  const continueVideo = makeVideo(channel.id, { status: "unwatched" });
  const continueRes = await queueRoute.request(
    `/videos/${continueVideo.id}/watched-toggle?from=continue-watching`,
    { method: "POST", headers: authHeaders },
  );
  expect(continueRes.status).toBe(303);
  expect(continueRes.headers.get("location")).toBe("/continue-watching");

  const watchedVideoForRedirect = makeVideo(channel.id, {
    status: "unwatched",
  });
  const watchedRedirectRes = await queueRoute.request(
    `/videos/${watchedVideoForRedirect.id}/watched-toggle?from=watched`,
    { method: "POST", headers: authHeaders },
  );
  expect(watchedRedirectRes.status).toBe(303);
  expect(watchedRedirectRes.headers.get("location")).toBe("/watched");

  const fallbackVideo = makeVideo(channel.id, { status: "unwatched" });
  const fallbackRes = await queueRoute.request(
    `/videos/${fallbackVideo.id}/watched-toggle`,
    { method: "POST", headers: authHeaders },
  );
  expect(fallbackRes.status).toBe(303);
  expect(fallbackRes.headers.get("location")).toBe("/queue");
});

test("POST /videos/:id/watched-toggle 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/watched-toggle", {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/watched-toggle 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Watched Toggle No Subscription Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/videos/${video.id}/watched-toggle`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle transitions unwatched to watched and responds with HX-Reswap: delete and an empty body", async () => {
  const channel = makeChannel("Toggle Queue View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-07-01T00:00:00Z"),
  });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=queue&sort=newest`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(toggled.id).status).toBe("watched");
});

test("POST /videos/:id/toggle transitions watching to unwatched and responds with HX-Reswap: delete for view=continue-watching", async () => {
  const channel = makeChannel("Toggle Continue Watching View Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/toggle?view=continue-watching`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle falls back to queue when the view param is missing, rendering a single-card fragment for the still-unwatched row", async () => {
  const channel = makeChannel("Toggle Missing View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(`/videos/${toggled.id}/toggle`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBeNull();
  const html = await res.text();
  expect(html).toContain(toggled.title);
  expect(html).toContain(`id="video-${toggled.id}"`);
  expect(videoRow(toggled.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle falls back to queue for an unrecognized view (e.g. view=watched), rendering a single-card fragment", async () => {
  const channel = makeChannel("Toggle Unrecognized View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=watched`,
    {
      method: "POST",
      headers: authHeaders,
    },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBeNull();
  const html = await res.text();
  expect(html).toContain(toggled.title);
  expect(videoRow(toggled.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/toggle", {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/toggle 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Toggle No Subscription Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/videos/${video.id}/toggle`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle?view=queue&category=<id> renders the single-card fragment with category preserved in its action links", async () => {
  const channel = makeChannel("Category Filter Toggle Queue Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const toggled = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=queue&category=${category.id}`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(toggled.title);
  expect(html).toContain(
    `hx-post="/videos/${toggled.id}/toggle?view=queue&amp;sort=newest&amp;category=${category.id}"`,
  );
  expect(html).toContain(
    `hx-post="/videos/${toggled.id}/ignore?view=queue&amp;sort=newest&amp;category=${category.id}"`,
  );
  expect(videoRow(toggled.id).status).toBe("unwatched");
});

test("GET /watching/:id round-trips an adversarial category value as a single encoded param, not an injected second querystring key", async () => {
  const channel = makeChannel("Adversarial Category Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "unwatched" });
  const adversarial = "3&evil=true";

  const res = await queueRoute.request(
    `/watching/${video.id}?from=continue-watching&category=${encodeURIComponent(adversarial)}`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const html = await res.text();

  const hrefMatch = html.match(/href="(\/continue-watching\?[^"]*)"/);
  const rawHref = hrefMatch?.[1];
  if (rawHref === undefined) {
    throw new Error("expected a rendered Return to Continue Watching link");
  }
  const href = rawHref.replace(/&amp;/g, "&");
  const queryString = href.split("?")[1];
  if (queryString === undefined) {
    throw new Error("expected a querystring on the return link");
  }
  const params = new URLSearchParams(queryString);
  expect(params.get("category")).toBe(adversarial);
  expect(params.has("evil")).toBe(false);
  expect([...params.keys()]).toEqual(["category"]);
});

test("End-to-end: a queue row's link round-trips through /watching/:id back to the same category-filtered /queue", async () => {
  const channel = makeChannel("Row Link Round Trip Queue Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const video = makeVideo(channel.id, { status: "unwatched" });

  const queueRes = await queueRoute.request(`/queue?category=${category.id}`, {
    headers: authHeaders,
  });
  const queueHtml = await queueRes.text();
  const rowHrefMatch = queueHtml.match(
    new RegExp(`href="(/watching/${video.id}\\?[^"]*)"`),
  );
  const rawRowHref = rowHrefMatch?.[1];
  if (rawRowHref === undefined) {
    throw new Error("expected a rendered row link for the video");
  }
  const rowHref = rawRowHref.replace(/&amp;/g, "&");

  const watchingRes = await queueRoute.request(rowHref, {
    headers: authHeaders,
  });
  const watchingHtml = await watchingRes.text();
  expect(watchingHtml).toContain(`href="/queue?category=${category.id}"`);

  const actionMatch = watchingHtml.match(/action="([^"]*watched-toggle[^"]*)"/);
  const rawAction = actionMatch?.[1];
  if (rawAction === undefined) {
    throw new Error("expected a rendered watched-toggle form action");
  }
  const action = rawAction.replace(/&amp;/g, "&");

  const toggleRes = await queueRoute.request(action, {
    method: "POST",
    headers: authHeaders,
  });
  expect(toggleRes.status).toBe(303);
  expect(toggleRes.headers.get("location")).toBe(
    `/queue?category=${category.id}`,
  );
});

test("End-to-end: a continue-watching row's link round-trips through /watching/:id back to the same category-filtered /continue-watching", async () => {
  const channel = makeChannel("Row Link Round Trip Continue Watching Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const video = makeVideo(channel.id, { status: "watching" });

  const continueRes = await queueRoute.request(
    `/continue-watching?category=${category.id}`,
    { headers: authHeaders },
  );
  const continueHtml = await continueRes.text();
  const rowHrefMatch = continueHtml.match(
    new RegExp(`href="(/watching/${video.id}\\?[^"]*)"`),
  );
  const rawRowHref = rowHrefMatch?.[1];
  if (rawRowHref === undefined) {
    throw new Error("expected a rendered row link for the video");
  }
  const rowHref = rawRowHref.replace(/&amp;/g, "&");

  const watchingRes = await queueRoute.request(rowHref, {
    headers: authHeaders,
  });
  const watchingHtml = await watchingRes.text();
  expect(watchingHtml).toContain(
    `href="/continue-watching?category=${category.id}"`,
  );

  const actionMatch = watchingHtml.match(/action="([^"]*watched-toggle[^"]*)"/);
  const rawAction = actionMatch?.[1];
  if (rawAction === undefined) {
    throw new Error("expected a rendered watched-toggle form action");
  }
  const action = rawAction.replace(/&amp;/g, "&");

  const toggleRes = await queueRoute.request(action, {
    method: "POST",
    headers: authHeaders,
  });
  expect(toggleRes.status).toBe(303);
  expect(toggleRes.headers.get("location")).toBe(
    `/continue-watching?category=${category.id}`,
  );
});

test("End-to-end: a watched row's link round-trips through /watching/:id back to the same category-filtered /watched", async () => {
  const channel = makeChannel("Row Link Round Trip Watched Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });

  const watchedRes = await queueRoute.request(
    `/watched?category=${category.id}`,
    { headers: authHeaders },
  );
  const watchedHtml = await watchedRes.text();
  const rowHrefMatch = watchedHtml.match(
    new RegExp(`href="(/watching/${video.id}\\?[^"]*)"`),
  );
  const rawRowHref = rowHrefMatch?.[1];
  if (rawRowHref === undefined) {
    throw new Error("expected a rendered row link for the video");
  }
  const rowHref = rawRowHref.replace(/&amp;/g, "&");

  const watchingRes = await queueRoute.request(rowHref, {
    headers: authHeaders,
  });
  const watchingHtml = await watchingRes.text();
  expect(watchingHtml).toContain(`href="/watched?category=${category.id}"`);

  const actionMatch = watchingHtml.match(/action="([^"]*watched-toggle[^"]*)"/);
  const rawAction = actionMatch?.[1];
  if (rawAction === undefined) {
    throw new Error("expected a rendered watched-toggle form action");
  }
  const action = rawAction.replace(/&amp;/g, "&");

  const toggleRes = await queueRoute.request(action, {
    method: "POST",
    headers: authHeaders,
  });
  expect(toggleRes.status).toBe(303);
  expect(toggleRes.headers.get("location")).toBe(
    `/watched?category=${category.id}`,
  );
});

test("POST /videos/:id/toggle?view=continue-watching&category=<id> responds with HX-Reswap: delete and an empty body", async () => {
  const channel = makeChannel(
    "Category Filter Toggle Continue Watching Channel",
  );
  makeSubscription(channel.id, { categoryId: category.id });
  const toggled = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=continue-watching&category=${category.id}`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(toggled.id).status).toBe("unwatched");
});

test("POST /videos/:id/ignore?view=queue sets ignored/manual and responds with HX-Reswap: delete and an empty body", async () => {
  const channel = makeChannel("Ignore Queue View Channel");
  makeSubscription(channel.id);
  const ignored = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(
    `/videos/${ignored.id}/ignore?view=queue&sort=newest`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(ignored.id).status).toBe("ignored");
  expect(videoRow(ignored.id).ignoreMethod).toBe("manual");
});

test("POST /videos/:id/ignore?view=continue-watching sets ignored/manual and responds with HX-Reswap: delete and an empty body", async () => {
  const channel = makeChannel("Ignore Continue Watching View Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/ignore?view=continue-watching`,
    { method: "POST", headers: authHeaders },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(video.id).status).toBe("ignored");
  expect(videoRow(video.id).ignoreMethod).toBe("manual");
});

test("POST /videos/:id/ignore 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/ignore", {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/ignore 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Ignore No Subscription Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/videos/${video.id}/ignore`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("GET /ignored lists only ignored videos for active subscriptions, excluding a since-unsubscribed channel's", async () => {
  const channel = makeChannel("Ignored View Channel");
  makeSubscription(channel.id);
  const manualIgnored = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "manual",
  });
  const autoIgnored = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });
  const unwatched = makeVideo(channel.id, { status: "unwatched" });

  const unsubChannel = makeChannel("Ignored Then Unsubscribed Channel");
  const unsubSub = makeSubscription(unsubChannel.id);
  const historyIgnored = makeVideo(unsubChannel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });
  db.update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscriptions.id, unsubSub.id))
    .run();

  const res = await queueRoute.request("/ignored", { headers: authHeaders });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(manualIgnored.title);
  expect(html).toContain(">manual<");
  expect(html).toContain(autoIgnored.title);
  expect(html).toContain(">auto<");
  expect(html).not.toContain(unwatched.title);
  expect(html).not.toContain(historyIgnored.title);
});

test("GET /ignored?category=<id> only returns that category's videos, including the Uncategorized category", async () => {
  const uncategorizedChannel = makeChannel("Ignored Uncategorized Channel");
  makeSubscription(uncategorizedChannel.id, {
    categoryId: systemCategory.id,
  });
  const uncategorizedVideo = makeVideo(uncategorizedChannel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });

  const categorizedChannel = makeChannel("Ignored Categorized Channel");
  makeSubscription(categorizedChannel.id, { categoryId: category.id });
  const categorizedVideo = makeVideo(categorizedChannel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });

  const uncategorizedRes = await queueRoute.request(
    `/ignored?category=${systemCategory.id}`,
    { headers: authHeaders },
  );
  const uncategorizedHtml = await uncategorizedRes.text();
  expect(uncategorizedHtml).toContain(uncategorizedVideo.title);
  expect(uncategorizedHtml).not.toContain(categorizedVideo.title);

  const categorizedRes = await queueRoute.request(
    `/ignored?category=${category.id}`,
    { headers: authHeaders },
  );
  const categorizedHtml = await categorizedRes.text();
  expect(categorizedHtml).toContain(categorizedVideo.title);
  expect(categorizedHtml).not.toContain(uncategorizedVideo.title);
});

test("GET /ignored?category=<invalid or nonexistent> falls back to unfiltered, same as no category param", async () => {
  const channel = makeChannel("Ignored Category Fallback Channel");
  makeSubscription(channel.id, { categoryId: otherCategory.id });
  const video = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });

  const noParamRes = await queueRoute.request("/ignored", {
    headers: authHeaders,
  });
  const noParamHtml = await noParamRes.text();
  expect(noParamHtml).toContain(video.title);

  const invalidRes = await queueRoute.request(
    "/ignored?category=not-a-number",
    { headers: authHeaders },
  );
  const invalidHtml = await invalidRes.text();
  expect(invalidHtml).toContain(video.title);

  const nonexistentRes = await queueRoute.request("/ignored?category=999999", {
    headers: authHeaders,
  });
  const nonexistentHtml = await nonexistentRes.text();
  expect(nonexistentHtml).toContain(video.title);
});

test("GET /ignored's category links preserve the current filter, same pattern as the other views", async () => {
  const res = await queueRoute.request(`/ignored?category=${category.id}`, {
    headers: authHeaders,
  });
  const html = await res.text();
  expect(html).toContain(`href="/ignored?category=${category.id}"`);
  expect(html).toContain('href="/ignored"');
});

test("POST /videos/:id/unignore reverts a manually-ignored video to unwatched with ignoreMethod null", async () => {
  const channel = makeChannel("Unignore Manual Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "manual",
  });

  const res = await queueRoute.request(`/videos/${video.id}/unignore`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).ignoreMethod).toBeNull();
});

test("POST /videos/:id/unignore reverts an auto-ignored video to unwatched with ignoreMethod null", async () => {
  const channel = makeChannel("Unignore Auto Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "auto",
  });

  const res = await queueRoute.request(`/videos/${video.id}/unignore`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(await res.text()).toBe("");
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).ignoreMethod).toBeNull();
});

test("POST /videos/:id/unignore against a watched video does not throw and clears watchedAt", async () => {
  const channel = makeChannel("Unignore Watched Regression Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });

  const res = await queueRoute.request(`/videos/${video.id}/unignore`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("HX-Reswap")).toBe("delete");
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("POST /videos/:id/unignore 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/unignore", {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/unignore 404s for a video whose channel the current user isn't subscribed to", async () => {
  const channel = makeChannel("Unignore No Subscription Channel");
  const video = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "manual",
  });

  const res = await queueRoute.request(`/videos/${video.id}/unignore`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(res.status).toBe(404);
  expect(videoRow(video.id).status).toBe("ignored");
});

test("End-to-end: a queue row's rendered Ignore button round-trips through /videos/:id/ignore and removes the row from a fresh /queue", async () => {
  const channel = makeChannel("Row Ignore Button Round Trip Queue Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "unwatched" });

  const queueRes = await queueRoute.request("/queue", { headers: authHeaders });
  const queueHtml = await queueRes.text();
  const buttonMatch = queueHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/ignore\\?[^"]*)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const ignoreRes = await queueRoute.request(hxPost, {
    method: "POST",
    headers: authHeaders,
  });
  expect(ignoreRes.status).toBe(200);

  const freshQueueRes = await queueRoute.request("/queue", {
    headers: authHeaders,
  });
  const freshQueueHtml = await freshQueueRes.text();
  expect(freshQueueHtml).not.toContain(video.title);
});

test("End-to-end: a continue-watching row's rendered Ignore button round-trips through /videos/:id/ignore and removes the row from a fresh /continue-watching", async () => {
  const channel = makeChannel(
    "Row Ignore Button Round Trip Continue Watching Channel",
  );
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const continueRes = await queueRoute.request("/continue-watching", {
    headers: authHeaders,
  });
  const continueHtml = await continueRes.text();
  const buttonMatch = continueHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/ignore\\?[^"]*)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const ignoreRes = await queueRoute.request(hxPost, {
    method: "POST",
    headers: authHeaders,
  });
  expect(ignoreRes.status).toBe(200);

  const freshContinueRes = await queueRoute.request("/continue-watching", {
    headers: authHeaders,
  });
  const freshContinueHtml = await freshContinueRes.text();
  expect(freshContinueHtml).not.toContain(video.title);
});

test("End-to-end: an ignored row's rendered Un-ignore button round-trips through /videos/:id/unignore, removes the row from a fresh /ignored, and the video reappears as unwatched on a fresh /queue", async () => {
  const channel = makeChannel("Row Unignore Button Round Trip Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "manual",
  });

  const ignoredRes = await queueRoute.request("/ignored", {
    headers: authHeaders,
  });
  const ignoredHtml = await ignoredRes.text();
  const buttonMatch = ignoredHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/unignore(?:\\?[^"]*)?)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Un-ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const unignoreRes = await queueRoute.request(hxPost, {
    method: "POST",
    headers: authHeaders,
  });
  expect(unignoreRes.status).toBe(200);

  const freshIgnoredRes = await queueRoute.request("/ignored", {
    headers: authHeaders,
  });
  const freshIgnoredHtml = await freshIgnoredRes.text();
  expect(freshIgnoredHtml).not.toContain(video.title);

  const freshQueueRes = await queueRoute.request("/queue", {
    headers: authHeaders,
  });
  const freshQueueHtml = await freshQueueRes.text();
  expect(freshQueueHtml).toContain(video.title);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("GET /queue renders the nav with Queue/Continue Watching/Watched counts from getNavCounts", async () => {
  const counts = getNavCounts(defaultUser.id);

  const res = await queueRoute.request("/queue", { headers: authHeaders });
  const html = await res.text();

  expect(html).toContain(`Queue (${counts.queueCount})`);
  expect(html).toContain(`Continue Watching (${counts.continueWatchingCount})`);
  expect(html).toContain(`Watched (${counts.watchedCount})`);
});

test("Queue/Continue Watching/Watched cards carry data-youtube-url matching youtubeWatchUrl", async () => {
  const channel = makeChannel("Data Youtube Url Channel");
  makeSubscription(channel.id);
  const watchingVideo = makeVideo(channel.id, { status: "watching" });
  const watchedVideo = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });

  const queueHtml = await (
    await queueRoute.request("/queue", { headers: authHeaders })
  ).text();
  expect(queueHtml).toContain(
    `data-youtube-url="${youtubeWatchUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const continueHtml = await (
    await queueRoute.request("/continue-watching", { headers: authHeaders })
  ).text();
  expect(continueHtml).toContain(
    `data-youtube-url="${youtubeWatchUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const watchedHtml = await (
    await queueRoute.request("/watched", { headers: authHeaders })
  ).text();
  expect(watchedHtml).toContain(
    `data-youtube-url="${youtubeWatchUrl(watchedVideo.youtubeVideoId)}"`,
  );
});

test("Queue/Continue Watching/Watched/Ignored cards render a thumbnail img matching youtubeThumbnailUrl", async () => {
  const channel = makeChannel("Thumbnail Src Channel");
  makeSubscription(channel.id);
  const watchingVideo = makeVideo(channel.id, { status: "watching" });
  const watchedVideo = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date("2026-07-02T00:00:00Z"),
  });
  const ignoredVideo = makeVideo(channel.id, {
    status: "ignored",
    ignoreMethod: "manual",
  });

  const queueHtml = await (
    await queueRoute.request("/queue", { headers: authHeaders })
  ).text();
  expect(queueHtml).toContain(
    `src="${youtubeThumbnailUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const continueHtml = await (
    await queueRoute.request("/continue-watching", { headers: authHeaders })
  ).text();
  expect(continueHtml).toContain(
    `src="${youtubeThumbnailUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const watchedHtml = await (
    await queueRoute.request("/watched", { headers: authHeaders })
  ).text();
  expect(watchedHtml).toContain(
    `src="${youtubeThumbnailUrl(watchedVideo.youtubeVideoId)}"`,
  );

  const ignoredHtml = await (
    await queueRoute.request("/ignored", { headers: authHeaders })
  ).text();
  expect(ignoredHtml).toContain(
    `src="${youtubeThumbnailUrl(ignoredVideo.youtubeVideoId)}"`,
  );
});

test("Each video-list view renders its empty-state message when zero rows match the filter, and not when a row exists", async () => {
  const emptyCategory = db
    .insert(categories)
    .values({ name: "Empty State Test Category" })
    .returning()
    .get();

  const queueEmptyHtml = await (
    await queueRoute.request(`/queue?category=${emptyCategory.id}`, {
      headers: authHeaders,
    })
  ).text();
  expect(queueEmptyHtml).toContain(
    "Nothing in your queue — your subscriptions are all caught up.",
  );

  const continueEmptyHtml = await (
    await queueRoute.request(
      `/continue-watching?category=${emptyCategory.id}`,
      { headers: authHeaders },
    )
  ).text();
  expect(continueEmptyHtml).toContain(
    "Nothing in progress — start watching something from your queue.",
  );

  const watchedEmptyHtml = await (
    await queueRoute.request(`/watched?category=${emptyCategory.id}`, {
      headers: authHeaders,
    })
  ).text();
  expect(watchedEmptyHtml).toContain("Nothing watched yet.");

  const ignoredEmptyHtml = await (
    await queueRoute.request(`/ignored?category=${emptyCategory.id}`, {
      headers: authHeaders,
    })
  ).text();
  expect(ignoredEmptyHtml).toContain("Nothing ignored.");

  const channel = makeChannel("Empty State Nonempty Channel");
  makeSubscription(channel.id, { categoryId: emptyCategory.id });
  const video = makeVideo(channel.id, { status: "unwatched" });

  const queueNonemptyHtml = await (
    await queueRoute.request(`/queue?category=${emptyCategory.id}`, {
      headers: authHeaders,
    })
  ).text();
  expect(queueNonemptyHtml).toContain(video.title);
  expect(queueNonemptyHtml).not.toContain(
    "Nothing in your queue — your subscriptions are all caught up.",
  );
});
