import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/lib/logger";
import { fetchChannelFeed } from "../../src/lib/rss";

const RSS_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA";

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:abc123</id>
    <yt:videoId>abc123</yt:videoId>
    <title>First Video</title>
    <published>2026-07-01T12:00:00+00:00</published>
    <media:group>
      <media:description>First video description</media:description>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:def456</id>
    <yt:videoId>def456</yt:videoId>
    <title>Second Video</title>
    <published>2026-07-10T08:30:00+00:00</published>
    <media:group>
      <media:description>Second video description</media:description>
    </media:group>
  </entry>
</feed>`;

let fetchSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  fetchSpy.mockRestore();
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

test("parses title and entries from Atom XML on success", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(FEED_XML, { status: 200 }),
  );

  const feed = await fetchChannelFeed(RSS_URL);
  expect(feed?.title).toBe("Test Channel");
  expect(feed?.entries).toEqual([
    {
      videoId: "abc123",
      title: "First Video",
      description: "First video description",
      publishedAt: new Date("2026-07-01T12:00:00+00:00"),
    },
    {
      videoId: "def456",
      title: "Second Video",
      description: "Second video description",
      publishedAt: new Date("2026-07-10T08:30:00+00:00"),
    },
  ]);
});

test("skips a malformed entry without failing the whole fetch", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:abc123</id>
    <title>First Video</title>
    <published>2026-07-01T12:00:00+00:00</published>
  </entry>
  <entry>
    <id>not-a-video-id</id>
    <title>Malformed Entry</title>
    <published>2026-07-05T00:00:00+00:00</published>
  </entry>
</feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );

  const feed = await fetchChannelFeed(RSS_URL);
  expect(feed?.title).toBe("Test Channel");
  expect(feed?.entries).toEqual([
    {
      videoId: "abc123",
      title: "First Video",
      description: null,
      publishedAt: new Date("2026-07-01T12:00:00+00:00"),
    },
  ]);
});

test("logs a single warn with a count when multiple entries are malformed", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:abc123</id>
    <title>First Video</title>
    <published>2026-07-01T12:00:00+00:00</published>
  </entry>
  <entry>
    <id>not-a-video-id</id>
    <title>Malformed Entry</title>
    <published>2026-07-05T00:00:00+00:00</published>
  </entry>
  <entry>
    <id>also-not-a-video-id</id>
    <title>Another Malformed Entry</title>
    <published>2026-07-06T00:00:00+00:00</published>
  </entry>
</feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );
  warnSpy = spyOn(logger, "warn");

  await fetchChannelFeed(RSS_URL);

  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy).toHaveBeenCalledWith("Skipped malformed feed entries", {
    channel: "Test Channel",
    url: RSS_URL,
    count: 2,
  });
});

test("returns null on network error", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("network error"),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});

test("returns null on timeout", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new DOMException("The operation timed out.", "TimeoutError"),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});

test("returns null on non-OK response", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});

test("returns null when title is missing", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed></feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});
