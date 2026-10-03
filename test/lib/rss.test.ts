import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/lib/logger";
import { fetchChannelFeed } from "../../src/lib/rss";

const RSS_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA";

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:abc12345678</id>
    <yt:videoId>abc12345678</yt:videoId>
    <title>First Video</title>
    <published>2026-07-01T12:00:00+00:00</published>
    <media:group>
      <media:description>First video description</media:description>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:def45678901</id>
    <yt:videoId>def45678901</yt:videoId>
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
      videoId: "abc12345678",
      title: "First Video",
      description: "First video description",
      publishedAt: new Date("2026-07-01T12:00:00+00:00"),
    },
    {
      videoId: "def45678901",
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
    <id>yt:video:abc12345678</id>
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
      videoId: "abc12345678",
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
    <id>yt:video:abc12345678</id>
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

test("returns null (no throw) on a non-XML body", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("hello", { status: 200 }),
  );
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
  expect(warnSpy).toHaveBeenCalledWith(
    "Feed is not valid XML",
    expect.objectContaining({ url: RSS_URL }),
  );
});

test("returns null on well-formed XML that isn't a feed", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("<html><body>hi</body></html>", { status: 200 }),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});

test("returns null on an empty <feed/> root", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("<feed/>", { status: 200 }),
  );

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("returns null when Content-Length exceeds the size cap", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(FEED_XML, {
      status: 200,
      headers: { "Content-Length": String(3 * 1024 * 1024) },
    }),
  );
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
  expect(warnSpy).toHaveBeenCalledWith("Feed exceeds size cap", {
    url: RSS_URL,
    maxBytes: 2 * 1024 * 1024,
  });
});

test("returns null when a streamed body without Content-Length exceeds the size cap", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(streamOf([chunk, chunk, chunk]), { status: 200 }),
  );
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

  expect(await fetchChannelFeed(RSS_URL)).toBeNull();
  expect(warnSpy).toHaveBeenCalledWith(
    "Feed exceeds size cap",
    expect.objectContaining({ url: RSS_URL }),
  );
});

test("decodes a multi-byte character split across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode(
    FEED_XML.replace("Test Channel", "Café 🎬 Channel"),
  );
  // Split inside both the 2-byte "é" and the 4-byte emoji.
  const eAcute = bytes.indexOf(0xc3);
  const emoji = bytes.indexOf(0xf0);
  const chunks = [
    bytes.slice(0, eAcute + 1),
    bytes.slice(eAcute + 1, emoji + 2),
    bytes.slice(emoji + 2),
  ];
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(streamOf(chunks), { status: 200 }),
  );

  const feed = await fetchChannelFeed(RSS_URL);
  expect(feed?.title).toBe("Café 🎬 Channel");
});

test("skips entries whose video ID is too short, too long, or has bad characters", async () => {
  const entry = (id: string) => `  <entry>
    <id>yt:video:${id}</id>
    <title>Video ${id}</title>
    <published>2026-07-01T12:00:00+00:00</published>
  </entry>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
${[entry("short"), entry("waytoolongvideoid"), entry("bad!chars!!!"), entry("good_ID-123")].join("\n")}
</feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

  const feed = await fetchChannelFeed(RSS_URL);
  expect(feed?.entries.map((e) => e.videoId)).toEqual(["good_ID-123"]);
  expect(warnSpy).toHaveBeenCalledWith(
    "Skipped malformed feed entries",
    expect.objectContaining({ count: 3 }),
  );
});
