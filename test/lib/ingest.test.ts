import { expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ChannelFeed, FeedEntry } from "../../src/lib/rss";

// applyFeedToChannel/ingestChannel operate against the module-level `db` singleton
// in src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be set
// before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { videos, youtubeChannels } = await import("../../src/db/schema");
const { applyFeedToChannel, ingestChannel } = await import(
  "../../src/lib/ingest"
);

migrate(db, { migrationsFolder: "./drizzle" });

const ONE_ENTRY_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:live1</id>
    <title>Live Video</title>
    <published>2026-07-10T00:00:00+00:00</published>
  </entry>
</feed>`;

function makeChannel(youtubeChannelId: string) {
  return db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId,
      name: "Test Channel",
      rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`,
    })
    .returning()
    .get();
}

function feedOf(entries: FeedEntry[]): ChannelFeed {
  return { title: "Test Channel", entries };
}

function channelRow(id: number) {
  const row = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.id, id))
    .get();
  if (!row) throw new Error(`channel ${id} not found`);
  return row;
}

test("applyFeedToChannel inserts new videos as unwatched", () => {
  const channel = makeChannel("UCingest0001");

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-new-1",
        title: "Video 1",
        description: "desc 1",
        publishedAt: new Date("2026-07-01T00:00:00Z"),
      },
      {
        videoId: "vid-new-2",
        title: "Video 2",
        description: null,
        publishedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]),
  );

  const rows = db
    .select()
    .from(videos)
    .where(eq(videos.channelId, channel.id))
    .all();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.status).toBe("unwatched");
    expect(row.ignoreMethod).toBeNull();
  }
});

test("re-ingesting an existing video updates title/description/publishedAt without touching status/ignoreMethod", () => {
  const channel = makeChannel("UCingest0002");

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-reingest",
        title: "Original Title",
        description: "Original description",
        publishedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]),
  );

  db.update(videos)
    .set({ status: "watched", ignoreMethod: "manual", watchedAt: new Date() })
    .where(eq(videos.youtubeVideoId, "vid-reingest"))
    .run();

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-reingest",
        title: "Updated Title",
        description: "Updated description",
        publishedAt: new Date("2026-07-03T00:00:00Z"),
      },
    ]),
  );

  const row = db
    .select()
    .from(videos)
    .where(eq(videos.youtubeVideoId, "vid-reingest"))
    .get();
  expect(row?.title).toBe("Updated Title");
  expect(row?.description).toBe("Updated description");
  expect(row?.publishedAt).toEqual(new Date("2026-07-03T00:00:00Z"));
  expect(row?.status).toBe("watched");
  expect(row?.ignoreMethod).toBe("manual");
});

test("gap detection does not fire on a channel's first-ever ingest", () => {
  const channel = makeChannel("UCingest0003");

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-first-ever",
        title: "Video 1",
        description: null,
        publishedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]),
  );

  expect(channelRow(channel.id).possibleMissedVideos).toBe(false);
});

test("gap detection sets possibleMissedVideos when the feed's oldest entry postdates the previously-newest stored video", () => {
  const channel = makeChannel("UCingest0004");

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-gap-baseline",
        title: "Video 1",
        description: null,
        publishedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]),
  );
  expect(channelRow(channel.id).possibleMissedVideos).toBe(false);

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-gap-newer",
        title: "Video 2",
        description: null,
        publishedAt: new Date("2026-07-05T00:00:00Z"),
      },
    ]),
  );

  expect(channelRow(channel.id).possibleMissedVideos).toBe(true);
});

test("gap detection does not clear an already-true flag on a subsequent gap-free ingest", () => {
  const channel = makeChannel("UCingest0005");

  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-gf-baseline",
        title: "Video 1",
        description: null,
        publishedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]),
  );
  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-gf-gap",
        title: "Video 2",
        description: null,
        publishedAt: new Date("2026-07-05T00:00:00Z"),
      },
    ]),
  );
  expect(channelRow(channel.id).possibleMissedVideos).toBe(true);

  // Gap-free: this entry's publishedAt predates the previously-newest stored
  // video (vid-gf-gap at 07-05), so gap detection itself does not fire here --
  // the flag should stay true only because it's never cleared, not because
  // this ingest re-triggers it.
  applyFeedToChannel(
    channel.id,
    feedOf([
      {
        videoId: "vid-gf-clean",
        title: "Video 3",
        description: null,
        publishedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]),
  );

  expect(channelRow(channel.id).possibleMissedVideos).toBe(true);
});

test("ingestChannel advances nextFetchDueAt and resolves ok:false when the fetch fails", async () => {
  const channel = makeChannel("UCingest0006");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 500 }),
  );

  const result = await ingestChannel(channel);
  fetchSpy.mockRestore();

  expect(result).toEqual({ ok: false });
  expect(channelRow(channel.id).nextFetchDueAt).not.toBeNull();
});

test("ingestChannel catches a DB error thrown from applyFeedToChannel, still advances nextFetchDueAt, and resolves ok:false", async () => {
  const channel = makeChannel("UCingest0007");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(ONE_ENTRY_FEED_XML, { status: 200 }),
  );
  const insertSpy = spyOn(db, "insert").mockImplementationOnce(() => {
    throw new Error("simulated DB failure");
  });

  const result = await ingestChannel(channel);
  fetchSpy.mockRestore();
  insertSpy.mockRestore();

  expect(result).toEqual({ ok: false });
  expect(channelRow(channel.id).nextFetchDueAt).not.toBeNull();
});

test("ingestChannel catches a failing reschedule update and still resolves ok:false", async () => {
  const channel = makeChannel("UCingest0008");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 500 }),
  );
  const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  const updateSpy = spyOn(db, "update").mockImplementationOnce(() => {
    throw new Error("simulated reschedule failure");
  });

  const result = await ingestChannel(channel);

  // Assert on the spies before restoring -- mockRestore() clears recorded
  // calls, so any assertion on .mock.calls must happen first.
  expect(result).toEqual({ ok: false });
  expect(consoleErrorSpy).toHaveBeenCalled();

  fetchSpy.mockRestore();
  updateSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});
