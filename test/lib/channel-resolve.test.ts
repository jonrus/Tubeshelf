import { afterEach, expect, spyOn, test } from "bun:test";
import { rssUrlFor } from "../../src/lib/channel-input";
import { resolveChannelInput } from "../../src/lib/channel-resolve";

const CHANNEL_ID = "UCBJycsmduvYEL83R_U4JriQ";

function canonicalHtml(channelId: string): string {
  return `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${channelId}"><link rel="alternate" type="application/rss+xml" href="..."></head><body></body></html>`;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

test("resolves a raw channel ID without calling fetch", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput(CHANNEL_ID);
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("resolves a /channel/ URL without calling fetch", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput(
    `https://www.youtube.com/channel/${CHANNEL_ID}`,
  );
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("resolves an RSS feed URL without calling fetch", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput(rssUrlFor(CHANNEL_ID));
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("resolves a bare @handle via scrape", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("resolves a full handle URL via scrape", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("https://www.youtube.com/@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("resolves a handle URL with a trailing /videos segment, preserving it in the fetch", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput(
    "https://www.youtube.com/@mkbhd/videos",
  );
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(
    "https://www.youtube.com/@mkbhd/videos",
  );
});

test("resolves a /c/ URL via scrape", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("https://www.youtube.com/c/mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/c/mkbhd");
});

test("resolves a /user/ URL via scrape", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput(
    "https://www.youtube.com/user/marquesbrownlee",
  );
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(
    "https://www.youtube.com/user/marquesbrownlee",
  );
});

test("strips a query string and fragment from the fetched URL", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput(
    "https://www.youtube.com/@mkbhd?foo=bar#frag",
  );
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("resolves a bare youtube.com (no www) host", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("https://youtube.com/@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("resolves an uppercase/mixed-case host", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("https://WWW.YOUTUBE.COM/@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("resolves an http:// (not https://) URL", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(canonicalHtml(CHANNEL_ID), { status: 200 }),
  );

  const result = await resolveChannelInput("http://www.youtube.com/@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.youtube.com/@mkbhd");
});

test("returns unrecognized for an empty string, with no fetch call", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput("");
  expect(result).toEqual({ ok: false, reason: "unrecognized" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("returns unrecognized for whitespace-only input, with no fetch call", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput("   ");
  expect(result).toEqual({ ok: false, reason: "unrecognized" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("resolves to the canonical link's ID, ignoring decoy channelId values in the page", async () => {
  const html = `<html><head>
<script>var ytInitialData = {"decoy1":{"channelId":"UCdecoy0000000000000001"},"decoy2":{"channelId":"UCdecoy0000000000000002"}};</script>
<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}">
</head><body></body></html>`;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(html, { status: 200 }),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({
    ok: true,
    channelId: CHANNEL_ID,
    rssUrl: rssUrlFor(CHANNEL_ID),
  });
});

test("returns unrecognized for a full URL on a non-YouTube host, with zero fetch calls (SSRF guard)", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput("https://example.com/@mkbhd");
  expect(result).toEqual({ ok: false, reason: "unrecognized" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("returns unrecognized for a bare word with no @ prefix", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput("PewDiePie");
  expect(result).toEqual({ ok: false, reason: "unrecognized" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("returns unrecognized for totally invalid input", async () => {
  fetchSpy = spyOn(globalThis, "fetch");

  const result = await resolveChannelInput("not a channel");
  expect(result).toEqual({ ok: false, reason: "unrecognized" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("returns resolve-failed for a recognized form with a 404 response", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({ ok: false, reason: "resolve-failed" });
});

test("returns resolve-failed when the response has no canonical link", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("<html><body>no canonical link here</body></html>", {
      status: 200,
    }),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({ ok: false, reason: "resolve-failed" });
});

test("returns resolve-failed on a network error", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("network error"),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({ ok: false, reason: "resolve-failed" });
});

test("returns resolve-failed on a timeout", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new DOMException("The operation timed out.", "TimeoutError"),
  );

  const result = await resolveChannelInput("@mkbhd");
  expect(result).toEqual({ ok: false, reason: "resolve-failed" });
});
