import { afterEach, expect, spyOn, test } from "bun:test";
import { fetchChannelTitle } from "../../src/lib/rss";

const RSS_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA";

let fetchSpy: ReturnType<typeof spyOn>;

afterEach(() => {
  fetchSpy.mockRestore();
});

test("parses feed.title from Atom XML on success", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed><title>Test Channel</title></feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );

  expect(await fetchChannelTitle(RSS_URL)).toBe("Test Channel");
});

test("returns null on network error", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("network error"),
  );

  expect(await fetchChannelTitle(RSS_URL)).toBeNull();
});

test("returns null on timeout", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new DOMException("The operation timed out.", "TimeoutError"),
  );

  expect(await fetchChannelTitle(RSS_URL)).toBeNull();
});

test("returns null on non-OK response", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );

  expect(await fetchChannelTitle(RSS_URL)).toBeNull();
});

test("returns null when title is missing", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed></feed>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );

  expect(await fetchChannelTitle(RSS_URL)).toBeNull();
});
