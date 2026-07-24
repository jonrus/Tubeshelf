import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// setWatching/toggleQueueStatus/toggleWatchedFromWatchingPage operate against the
// module-level `db` singleton in src/db/client.ts, which reads DB_FILE_NAME at import
// time -- so it must be set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { videos, youtubeChannels } = await import("../../src/db/schema");
const { setWatching, toggleQueueStatus, toggleWatchedFromWatchingPage } =
  await import("../../src/lib/watch-status");

migrate(db, { migrationsFolder: "./drizzle" });

const channel = db
  .insert(youtubeChannels)
  .values({
    youtubeChannelId: "UCwatchstatus0001",
    name: "Test Channel",
    rssUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCwatchstatus0001",
  })
  .returning()
  .get();

let videoCounter = 0;

function makeVideo(
  status: "unwatched" | "watching" | "watched" | "ignored",
  watchedAt: Date | null = null,
) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId: channel.id,
      youtubeVideoId: `vid-watch-status-${videoCounter}`,
      title: `Video ${videoCounter}`,
      status,
      watchedAt,
    })
    .returning()
    .get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

test("setWatching transitions unwatched to watching", () => {
  const video = makeVideo("unwatched");
  const result = setWatching(video.id);
  expect(result).toEqual({ status: "watching" });
  expect(videoRow(video.id).status).toBe("watching");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("setWatching transitions watching to watching", () => {
  const video = makeVideo("watching");
  const result = setWatching(video.id);
  expect(result).toEqual({ status: "watching" });
  expect(videoRow(video.id).status).toBe("watching");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("setWatching transitions watched to watching and clears watchedAt", () => {
  const video = makeVideo("watched", new Date("2026-07-01T00:00:00Z"));
  const result = setWatching(video.id);
  expect(result).toEqual({ status: "watching" });
  expect(videoRow(video.id).status).toBe("watching");
  expect(videoRow(video.id).watchedAt).toBeNull();
});

test("setWatching returns null for a nonexistent video ID", () => {
  expect(setWatching(999999)).toBeNull();
});

test("toggleQueueStatus transitions unwatched to watched and sets watchedAt", () => {
  const video = makeVideo("unwatched");
  const before = new Date();
  const result = toggleQueueStatus(video.id);
  expect(result).toEqual({ status: "watched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("watched");
  expect(row.watchedAt).not.toBeNull();
  expect(row.watchedAt?.getTime()).toBeGreaterThanOrEqual(
    before.getTime() - 1000,
  );
});

test("toggleQueueStatus transitions watched to unwatched and clears watchedAt", () => {
  const video = makeVideo("watched", new Date("2026-07-01T00:00:00Z"));
  const result = toggleQueueStatus(video.id);
  expect(result).toEqual({ status: "unwatched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.watchedAt).toBeNull();
});

test("toggleQueueStatus transitions watching to unwatched and leaves watchedAt null", () => {
  const video = makeVideo("watching");
  const result = toggleQueueStatus(video.id);
  expect(result).toEqual({ status: "unwatched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.watchedAt).toBeNull();
});

test("toggleQueueStatus returns null for a nonexistent video ID", () => {
  expect(toggleQueueStatus(999999)).toBeNull();
});

test("toggleWatchedFromWatchingPage transitions unwatched to watched and sets watchedAt", () => {
  const video = makeVideo("unwatched");
  const result = toggleWatchedFromWatchingPage(video.id);
  expect(result).toEqual({ status: "watched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("watched");
  expect(row.watchedAt).not.toBeNull();
});

test("toggleWatchedFromWatchingPage transitions watching to watched and sets watchedAt (regression case)", () => {
  const video = makeVideo("watching");
  const result = toggleWatchedFromWatchingPage(video.id);
  expect(result).toEqual({ status: "watched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("watched");
  expect(row.watchedAt).not.toBeNull();
});

test("toggleWatchedFromWatchingPage transitions watched to unwatched and clears watchedAt", () => {
  const video = makeVideo("watched", new Date("2026-07-01T00:00:00Z"));
  const result = toggleWatchedFromWatchingPage(video.id);
  expect(result).toEqual({ status: "unwatched" });
  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.watchedAt).toBeNull();
});

test("toggleWatchedFromWatchingPage returns null for a nonexistent video ID", () => {
  expect(toggleWatchedFromWatchingPage(999999)).toBeNull();
});
