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

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const defaultUser = db
  .select()
  .from(users)
  .where(eq(users.username, "default"))
  .get();
if (!defaultUser) throw new Error("seed did not create the default user");

const category = db
  .insert(categories)
  .values({ name: "Queue Test Category" })
  .returning()
  .get();

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
  opts: { unsubscribed?: boolean } = {},
) {
  return db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channelId,
      categoryId: category.id,
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
    })
    .returning()
    .get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

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
