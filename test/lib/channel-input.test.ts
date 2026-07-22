import { expect, test } from "bun:test";
import { parseChannelInput } from "../../src/lib/channel-input";

const CHANNEL_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

test("parses a raw channel ID", () => {
  expect(parseChannelInput(CHANNEL_ID)).toEqual({
    channelId: CHANNEL_ID,
    rssUrl: RSS_URL,
  });
});

test("parses a /channel/<id> URL", () => {
  expect(
    parseChannelInput(`https://www.youtube.com/channel/${CHANNEL_ID}`),
  ).toEqual({ channelId: CHANNEL_ID, rssUrl: RSS_URL });
});

test("parses an RSS URL with a channel_id query param", () => {
  expect(parseChannelInput(RSS_URL)).toEqual({
    channelId: CHANNEL_ID,
    rssUrl: RSS_URL,
  });
});

test("returns null for invalid input", () => {
  expect(parseChannelInput("not a channel")).toBeNull();
  expect(parseChannelInput("https://example.com/")).toBeNull();
  expect(parseChannelInput("UCshort")).toBeNull();
});

test("normalizes all three valid forms of the same channel to an identical result", () => {
  const fromId = parseChannelInput(CHANNEL_ID);
  const fromChannelUrl = parseChannelInput(
    `https://www.youtube.com/channel/${CHANNEL_ID}`,
  );
  const fromRssUrl = parseChannelInput(RSS_URL);

  expect(fromId).toEqual(fromChannelUrl);
  expect(fromChannelUrl).toEqual(fromRssUrl);
});
