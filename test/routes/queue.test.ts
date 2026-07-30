import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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

const defaultUserRow = db
  .select()
  .from(users)
  .where(eq(users.username, "default"))
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
  const res = await queueRoute.request("/");
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

  const res = await queueRoute.request("/queue");
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

  const res = await queueRoute.request("/queue?sort=oldest");
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

  const res = await queueRoute.request("/continue-watching");
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

  const res = await queueRoute.request("/watched");
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

test("GET /queue?category=<id> only returns that category's videos", async () => {
  const channel = makeChannel("Category Filter Queue Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const inCategory = makeVideo(channel.id, { status: "unwatched" });

  const otherChannel = makeChannel("Category Filter Queue Other Channel");
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const inOtherCategory = makeVideo(otherChannel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/queue?category=${category.id}`);
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

  const res = await queueRoute.request(`/queue?category=${systemCategory.id}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(uncategorizedVideo.title);
  expect(html).not.toContain(categorizedVideo.title);
});

test("GET /queue?category=<invalid or nonexistent> falls back to unfiltered, same as no category param", async () => {
  const channel = makeChannel("Category Filter Fallback Channel");
  makeSubscription(channel.id, { categoryId: otherCategory.id });
  const video = makeVideo(channel.id, { status: "unwatched" });

  const noParamRes = await queueRoute.request("/queue");
  const noParamHtml = await noParamRes.text();
  expect(noParamHtml).toContain(video.title);

  const invalidRes = await queueRoute.request("/queue?category=not-a-number");
  const invalidHtml = await invalidRes.text();
  expect(invalidHtml).toContain(video.title);

  const nonexistentRes = await queueRoute.request("/queue?category=999999");
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

  const res = await queueRoute.request(`/watched?category=${category.id}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(historyVideo.title);
  expect(html).not.toContain(otherVideo.title);
});

test("GET /queue, /continue-watching, /watched, /ignored each render a sidebar link per existing category", async () => {
  for (const path of ["/queue", "/continue-watching", "/watched", "/ignored"]) {
    const res = await queueRoute.request(path);
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
    const res = await queueRoute.request(path);
    const html = await res.text();
    const activeLinks = [
      ...html.matchAll(/<a href="[^"]*" data-active="true"[^>]*>([^(<]*)/g),
    ].map((m) => m[1]?.trim());
    expect(activeLinks).toEqual([activeLabel]);
  }
});

test("GET /watched?category=<id> highlights that category's sidebar sub-item, but not /categories's own link", async () => {
  const res = await queueRoute.request(`/watched?category=${category.id}`);
  const html = await res.text();
  expect(html).toContain(
    `href="/watched?category=${category.id}" data-active="true"`,
  );
  expect(html).toContain('href="/categories" data-active="false"');
});

test("A sidebar category link on /ignored?category=<id> stays view-aware, pointing at /ignored (not /queue)", async () => {
  const res = await queueRoute.request(`/ignored?category=${category.id}`);
  const html = await res.text();
  const linkMatch = html.match(
    new RegExp(`href="(/ignored\\?category=${otherCategory.id})"`),
  );
  expect(linkMatch).not.toBeNull();
  expect(html).not.toContain(`href="/queue?category=${otherCategory.id}"`);
});

test("GET /queue's category links preserve sort, and sort links preserve category", async () => {
  const sortedRes = await queueRoute.request("/queue?sort=oldest");
  const sortedHtml = await sortedRes.text();
  expect(sortedHtml).toContain(
    `href="/queue?sort=oldest&amp;category=${category.id}"`,
  );

  const filteredRes = await queueRoute.request(
    `/queue?category=${category.id}`,
  );
  const filteredHtml = await filteredRes.text();
  expect(filteredHtml).toContain(
    `href="/queue?sort=oldest&amp;category=${category.id}"`,
  );
});

test("GET /watching/:id 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/watching/999999");
  expect(res.status).toBe(404);
});

test("GET /watching/:id shows Mark Watched and the auto-timer element for a non-watched video", async () => {
  const channel = makeChannel("Watching Page Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/watching/${video.id}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Mark Watched &amp; Return to Queue");
  expect(html).toContain('hx-trigger="load delay:10s"');
  expect(html).toContain(`/videos/${video.id}/watching`);
});

test("GET /watching/:id shows Mark Unwatched and hides the auto-timer for a watched video", async () => {
  const channel = makeChannel("Watching Page Watched Channel");
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });

  const res = await queueRoute.request(`/watching/${video.id}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Mark Unwatched &amp; Return to Queue");
  expect(html).not.toContain('hx-trigger="load delay:10s"');
});

test("GET /watching/:id resolves the return target from from/sort, with fallback for missing/unrecognized from", async () => {
  const channel = makeChannel("Return Target Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });

  const continueRes = await queueRoute.request(
    `/watching/${video.id}?from=continue-watching`,
  );
  const continueHtml = await continueRes.text();
  expect(continueHtml).toContain("Return to Continue Watching");
  expect(continueHtml).toContain('href="/continue-watching"');

  const watchedRes = await queueRoute.request(
    `/watching/${video.id}?from=watched`,
  );
  const watchedHtml = await watchedRes.text();
  expect(watchedHtml).toContain("Return to Watched");
  expect(watchedHtml).toContain('href="/watched"');

  const queueSortRes = await queueRoute.request(
    `/watching/${video.id}?from=queue&sort=oldest`,
  );
  const queueSortHtml = await queueSortRes.text();
  expect(queueSortHtml).toContain("Return to Queue");
  expect(queueSortHtml).toContain('href="/queue?sort=oldest"');
  expect(queueSortHtml).toContain(
    `action="/videos/${video.id}/watched-toggle?from=queue&amp;sort=oldest"`,
  );

  const queueCategoryRes = await queueRoute.request(
    `/watching/${video.id}?from=queue&sort=oldest&category=${category.id}`,
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
  );
  const continueCategoryHtml = await continueCategoryRes.text();
  expect(continueCategoryHtml).toContain("Return to Continue Watching");
  expect(continueCategoryHtml).toContain(
    `href="/continue-watching?category=${category.id}"`,
  );

  const watchedCategoryRes = await queueRoute.request(
    `/watching/${video.id}?from=watched&category=${category.id}`,
  );
  const watchedCategoryHtml = await watchedCategoryRes.text();
  expect(watchedCategoryHtml).toContain("Return to Watched");
  expect(watchedCategoryHtml).toContain(
    `href="/watched?category=${category.id}"`,
  );

  const bogusRes = await queueRoute.request(`/watching/${video.id}?from=bogus`);
  const bogusHtml = await bogusRes.text();
  expect(bogusHtml).toContain("Return to Queue");
  expect(bogusHtml).toContain('href="/queue"');

  const noQueryRes = await queueRoute.request(`/watching/${video.id}`);
  const noQueryHtml = await noQueryRes.text();
  expect(noQueryHtml).toContain("Return to Queue");
  expect(noQueryHtml).toContain('href="/queue"');
});

test("POST /videos/:id/watching always sets watching, regardless of prior status", async () => {
  const channel = makeChannel("Set Watching Channel");

  const unwatchedVideo = makeVideo(channel.id, { status: "unwatched" });
  const unwatchedRes = await queueRoute.request(
    `/videos/${unwatchedVideo.id}/watching`,
    { method: "POST" },
  );
  expect(unwatchedRes.status).toBe(200);
  expect(videoRow(unwatchedVideo.id).status).toBe("watching");

  const watchedVideo = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });
  const watchedRes = await queueRoute.request(
    `/videos/${watchedVideo.id}/watching`,
    { method: "POST" },
  );
  expect(watchedRes.status).toBe(200);
  expect(videoRow(watchedVideo.id).status).toBe("watching");
});

test("POST /videos/:id/watching 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/watching", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/watched-toggle transitions watching to watched (regression case), not unwatched", async () => {
  const channel = makeChannel("Watched Toggle Regression Channel");
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/watched-toggle?from=queue&sort=newest`,
    { method: "POST" },
  );
  expect(res.status).toBe(303);
  expect(videoRow(video.id).status).toBe("watched");
  expect(videoRow(video.id).watchedAt).not.toBeNull();
});

test("POST /videos/:id/watched-toggle transitions watched to unwatched", async () => {
  const channel = makeChannel("Watched Toggle Unwatch Channel");
  const video = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });

  const res = await queueRoute.request(`/videos/${video.id}/watched-toggle`, {
    method: "POST",
  });
  expect(res.status).toBe(303);
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("POST /videos/:id/watched-toggle redirects to resolveReturnTarget's url for all from values plus the fallback", async () => {
  const channel = makeChannel("Watched Toggle Redirect Channel");

  const queueVideo = makeVideo(channel.id, { status: "unwatched" });
  const queueRes = await queueRoute.request(
    `/videos/${queueVideo.id}/watched-toggle?from=queue&sort=oldest`,
    { method: "POST" },
  );
  expect(queueRes.status).toBe(303);
  expect(queueRes.headers.get("location")).toBe("/queue?sort=oldest");

  const queueCategoryVideo = makeVideo(channel.id, { status: "unwatched" });
  const queueCategoryRes = await queueRoute.request(
    `/videos/${queueCategoryVideo.id}/watched-toggle?from=queue&sort=oldest&category=${category.id}`,
    { method: "POST" },
  );
  expect(queueCategoryRes.status).toBe(303);
  expect(queueCategoryRes.headers.get("location")).toBe(
    `/queue?sort=oldest&category=${category.id}`,
  );

  const continueVideo = makeVideo(channel.id, { status: "unwatched" });
  const continueRes = await queueRoute.request(
    `/videos/${continueVideo.id}/watched-toggle?from=continue-watching`,
    { method: "POST" },
  );
  expect(continueRes.status).toBe(303);
  expect(continueRes.headers.get("location")).toBe("/continue-watching");

  const watchedVideoForRedirect = makeVideo(channel.id, {
    status: "unwatched",
  });
  const watchedRedirectRes = await queueRoute.request(
    `/videos/${watchedVideoForRedirect.id}/watched-toggle?from=watched`,
    { method: "POST" },
  );
  expect(watchedRedirectRes.status).toBe(303);
  expect(watchedRedirectRes.headers.get("location")).toBe("/watched");

  const fallbackVideo = makeVideo(channel.id, { status: "unwatched" });
  const fallbackRes = await queueRoute.request(
    `/videos/${fallbackVideo.id}/watched-toggle`,
    { method: "POST" },
  );
  expect(fallbackRes.status).toBe(303);
  expect(fallbackRes.headers.get("location")).toBe("/queue");
});

test("POST /videos/:id/watched-toggle 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/watched-toggle", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/toggle changes status and the returned partial reflects the row's removal from view=queue", async () => {
  const channel = makeChannel("Toggle Queue View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, {
    status: "unwatched",
    publishedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const stays = makeVideo(channel.id, {
    status: "watching",
    publishedAt: new Date("2026-07-02T00:00:00Z"),
  });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=queue&sort=newest`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(toggled.title);
  expect(html).toContain(stays.title);
  expect(videoRow(toggled.id).status).toBe("watched");
});

test("POST /videos/:id/toggle re-renders continue-watching for view=continue-watching", async () => {
  const channel = makeChannel("Toggle Continue Watching View Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/toggle?view=continue-watching`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  // toggleQueueStatus clears a `watching` row to `unwatched` -- if the fallback
  // incorrectly re-rendered `queue` instead, the now-unwatched video would still
  // show up there (queue includes unwatched), so this also proves it's really
  // re-rendering continue-watching (watching-only), not a silent fallback.
  expect(html).not.toContain(video.title);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("POST /videos/:id/toggle falls back to queue when the view param is missing", async () => {
  const channel = makeChannel("Toggle Missing View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, { status: "unwatched" });
  const sibling = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(`/videos/${toggled.id}/toggle`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(sibling.title);
  expect(videoRow(toggled.id).status).toBe("watched");
});

test("POST /videos/:id/toggle falls back to queue for an unrecognized view (e.g. view=watched)", async () => {
  const channel = makeChannel("Toggle Unrecognized View Channel");
  makeSubscription(channel.id);
  const toggled = makeVideo(channel.id, { status: "unwatched" });
  const sibling = makeVideo(channel.id, { status: "unwatched" });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=watched`,
    {
      method: "POST",
    },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(sibling.title);
  expect(videoRow(toggled.id).status).toBe("watched");
});

test("POST /videos/:id/toggle 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/toggle", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("POST /videos/:id/toggle?view=queue&category=<id> keeps the re-rendered partial scoped to that category", async () => {
  const channel = makeChannel("Category Filter Toggle Queue Channel");
  makeSubscription(channel.id, { categoryId: category.id });
  const toggled = makeVideo(channel.id, { status: "unwatched" });
  const staysSameCategory = makeVideo(channel.id, { status: "watching" });

  const otherChannel = makeChannel(
    "Category Filter Toggle Queue Other Channel",
  );
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const otherCategoryVideo = makeVideo(otherChannel.id, {
    status: "unwatched",
  });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=queue&category=${category.id}`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(toggled.title);
  expect(html).toContain(staysSameCategory.title);
  expect(html).not.toContain(otherCategoryVideo.title);
});

test("GET /watching/:id round-trips an adversarial category value as a single encoded param, not an injected second querystring key", async () => {
  const channel = makeChannel("Adversarial Category Channel");
  const video = makeVideo(channel.id, { status: "unwatched" });
  const adversarial = "3&evil=true";

  const res = await queueRoute.request(
    `/watching/${video.id}?from=continue-watching&category=${encodeURIComponent(adversarial)}`,
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

  const queueRes = await queueRoute.request(`/queue?category=${category.id}`);
  const queueHtml = await queueRes.text();
  const rowHrefMatch = queueHtml.match(
    new RegExp(`href="(/watching/${video.id}\\?[^"]*)"`),
  );
  const rawRowHref = rowHrefMatch?.[1];
  if (rawRowHref === undefined) {
    throw new Error("expected a rendered row link for the video");
  }
  const rowHref = rawRowHref.replace(/&amp;/g, "&");

  const watchingRes = await queueRoute.request(rowHref);
  const watchingHtml = await watchingRes.text();
  expect(watchingHtml).toContain(`href="/queue?category=${category.id}"`);

  const actionMatch = watchingHtml.match(/action="([^"]*watched-toggle[^"]*)"/);
  const rawAction = actionMatch?.[1];
  if (rawAction === undefined) {
    throw new Error("expected a rendered watched-toggle form action");
  }
  const action = rawAction.replace(/&amp;/g, "&");

  const toggleRes = await queueRoute.request(action, { method: "POST" });
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

  const watchingRes = await queueRoute.request(rowHref);
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

  const toggleRes = await queueRoute.request(action, { method: "POST" });
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

  const watchingRes = await queueRoute.request(rowHref);
  const watchingHtml = await watchingRes.text();
  expect(watchingHtml).toContain(`href="/watched?category=${category.id}"`);

  const actionMatch = watchingHtml.match(/action="([^"]*watched-toggle[^"]*)"/);
  const rawAction = actionMatch?.[1];
  if (rawAction === undefined) {
    throw new Error("expected a rendered watched-toggle form action");
  }
  const action = rawAction.replace(/&amp;/g, "&");

  const toggleRes = await queueRoute.request(action, { method: "POST" });
  expect(toggleRes.status).toBe(303);
  expect(toggleRes.headers.get("location")).toBe(
    `/watched?category=${category.id}`,
  );
});

test("POST /videos/:id/toggle?view=continue-watching&category=<id> keeps the re-rendered partial scoped to that category", async () => {
  const channel = makeChannel(
    "Category Filter Toggle Continue Watching Channel",
  );
  makeSubscription(channel.id, { categoryId: category.id });
  const toggled = makeVideo(channel.id, { status: "watching" });

  const otherChannel = makeChannel(
    "Category Filter Toggle Continue Watching Other Channel",
  );
  makeSubscription(otherChannel.id, { categoryId: otherCategory.id });
  const otherCategoryVideo = makeVideo(otherChannel.id, {
    status: "watching",
  });

  const res = await queueRoute.request(
    `/videos/${toggled.id}/toggle?view=continue-watching&category=${category.id}`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(toggled.title);
  expect(html).not.toContain(otherCategoryVideo.title);
});

test("POST /videos/:id/ignore?view=queue sets ignored/manual and removes the row from the re-rendered queue", async () => {
  const channel = makeChannel("Ignore Queue View Channel");
  makeSubscription(channel.id);
  const ignored = makeVideo(channel.id, { status: "unwatched" });
  const stays = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${ignored.id}/ignore?view=queue&sort=newest`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(ignored.title);
  expect(html).toContain(stays.title);
  expect(videoRow(ignored.id).status).toBe("ignored");
  expect(videoRow(ignored.id).ignoreMethod).toBe("manual");
});

test("POST /videos/:id/ignore?view=continue-watching sets ignored/manual and removes the row from the re-rendered continue-watching list", async () => {
  const channel = makeChannel("Ignore Continue Watching View Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const res = await queueRoute.request(
    `/videos/${video.id}/ignore?view=continue-watching`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(video.title);
  expect(videoRow(video.id).status).toBe("ignored");
  expect(videoRow(video.id).ignoreMethod).toBe("manual");
});

test("POST /videos/:id/ignore 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/ignore", {
    method: "POST",
  });
  expect(res.status).toBe(404);
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

  const res = await queueRoute.request("/ignored");
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
  );
  const uncategorizedHtml = await uncategorizedRes.text();
  expect(uncategorizedHtml).toContain(uncategorizedVideo.title);
  expect(uncategorizedHtml).not.toContain(categorizedVideo.title);

  const categorizedRes = await queueRoute.request(
    `/ignored?category=${category.id}`,
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

  const noParamRes = await queueRoute.request("/ignored");
  const noParamHtml = await noParamRes.text();
  expect(noParamHtml).toContain(video.title);

  const invalidRes = await queueRoute.request("/ignored?category=not-a-number");
  const invalidHtml = await invalidRes.text();
  expect(invalidHtml).toContain(video.title);

  const nonexistentRes = await queueRoute.request("/ignored?category=999999");
  const nonexistentHtml = await nonexistentRes.text();
  expect(nonexistentHtml).toContain(video.title);
});

test("GET /ignored's category links preserve the current filter, same pattern as the other views", async () => {
  const res = await queueRoute.request(`/ignored?category=${category.id}`);
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
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(video.title);
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
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(video.title);
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
  });
  expect(res.status).toBe(200);
  expect(videoRow(video.id).status).toBe("unwatched");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("POST /videos/:id/unignore 404s for a nonexistent video", async () => {
  const res = await queueRoute.request("/videos/999999/unignore", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("End-to-end: a queue row's rendered Ignore button round-trips through /videos/:id/ignore and removes the row from a fresh /queue", async () => {
  const channel = makeChannel("Row Ignore Button Round Trip Queue Channel");
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "unwatched" });

  const queueRes = await queueRoute.request("/queue");
  const queueHtml = await queueRes.text();
  const buttonMatch = queueHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/ignore\\?[^"]*)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const ignoreRes = await queueRoute.request(hxPost, { method: "POST" });
  expect(ignoreRes.status).toBe(200);

  const freshQueueRes = await queueRoute.request("/queue");
  const freshQueueHtml = await freshQueueRes.text();
  expect(freshQueueHtml).not.toContain(video.title);
});

test("End-to-end: a continue-watching row's rendered Ignore button round-trips through /videos/:id/ignore and removes the row from a fresh /continue-watching", async () => {
  const channel = makeChannel(
    "Row Ignore Button Round Trip Continue Watching Channel",
  );
  makeSubscription(channel.id);
  const video = makeVideo(channel.id, { status: "watching" });

  const continueRes = await queueRoute.request("/continue-watching");
  const continueHtml = await continueRes.text();
  const buttonMatch = continueHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/ignore\\?[^"]*)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const ignoreRes = await queueRoute.request(hxPost, { method: "POST" });
  expect(ignoreRes.status).toBe(200);

  const freshContinueRes = await queueRoute.request("/continue-watching");
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

  const ignoredRes = await queueRoute.request("/ignored");
  const ignoredHtml = await ignoredRes.text();
  const buttonMatch = ignoredHtml.match(
    new RegExp(`hx-post="(/videos/${video.id}/unignore(?:\\?[^"]*)?)"`),
  );
  const rawHxPost = buttonMatch?.[1];
  if (rawHxPost === undefined) {
    throw new Error("expected a rendered Un-ignore button for the video");
  }
  const hxPost = rawHxPost.replace(/&amp;/g, "&");

  const unignoreRes = await queueRoute.request(hxPost, { method: "POST" });
  expect(unignoreRes.status).toBe(200);

  const freshIgnoredRes = await queueRoute.request("/ignored");
  const freshIgnoredHtml = await freshIgnoredRes.text();
  expect(freshIgnoredHtml).not.toContain(video.title);

  const freshQueueRes = await queueRoute.request("/queue");
  const freshQueueHtml = await freshQueueRes.text();
  expect(freshQueueHtml).toContain(video.title);
  expect(videoRow(video.id).status).toBe("unwatched");
});

test("GET /queue renders the nav with Queue/Continue Watching/Watched counts from getNavCounts", async () => {
  const counts = getNavCounts(defaultUser.id);

  const res = await queueRoute.request("/queue");
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

  const queueHtml = await (await queueRoute.request("/queue")).text();
  expect(queueHtml).toContain(
    `data-youtube-url="${youtubeWatchUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const continueHtml = await (
    await queueRoute.request("/continue-watching")
  ).text();
  expect(continueHtml).toContain(
    `data-youtube-url="${youtubeWatchUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const watchedHtml = await (await queueRoute.request("/watched")).text();
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

  const queueHtml = await (await queueRoute.request("/queue")).text();
  expect(queueHtml).toContain(
    `src="${youtubeThumbnailUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const continueHtml = await (
    await queueRoute.request("/continue-watching")
  ).text();
  expect(continueHtml).toContain(
    `src="${youtubeThumbnailUrl(watchingVideo.youtubeVideoId)}"`,
  );

  const watchedHtml = await (await queueRoute.request("/watched")).text();
  expect(watchedHtml).toContain(
    `src="${youtubeThumbnailUrl(watchedVideo.youtubeVideoId)}"`,
  );

  const ignoredHtml = await (await queueRoute.request("/ignored")).text();
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
    await queueRoute.request(`/queue?category=${emptyCategory.id}`)
  ).text();
  expect(queueEmptyHtml).toContain(
    "Nothing in your queue — your subscriptions are all caught up.",
  );

  const continueEmptyHtml = await (
    await queueRoute.request(`/continue-watching?category=${emptyCategory.id}`)
  ).text();
  expect(continueEmptyHtml).toContain(
    "Nothing in progress — start watching something from your queue.",
  );

  const watchedEmptyHtml = await (
    await queueRoute.request(`/watched?category=${emptyCategory.id}`)
  ).text();
  expect(watchedEmptyHtml).toContain("Nothing watched yet.");

  const ignoredEmptyHtml = await (
    await queueRoute.request(`/ignored?category=${emptyCategory.id}`)
  ).text();
  expect(ignoredEmptyHtml).toContain("Nothing ignored.");

  const channel = makeChannel("Empty State Nonempty Channel");
  makeSubscription(channel.id, { categoryId: emptyCategory.id });
  const video = makeVideo(channel.id, { status: "unwatched" });

  const queueNonemptyHtml = await (
    await queueRoute.request(`/queue?category=${emptyCategory.id}`)
  ).text();
  expect(queueNonemptyHtml).toContain(video.title);
  expect(queueNonemptyHtml).not.toContain(
    "Nothing in your queue — your subscriptions are all caught up.",
  );
});
