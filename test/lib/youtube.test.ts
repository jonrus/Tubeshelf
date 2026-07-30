import { expect, test } from "bun:test";
import { youtubeThumbnailUrl, youtubeWatchUrl } from "../../src/lib/youtube";

const VIDEO_ID = "dQw4w9WgXcQ";

test("youtubeWatchUrl builds a watch URL for the given video id", () => {
  expect(youtubeWatchUrl(VIDEO_ID)).toBe(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

test("youtubeThumbnailUrl builds an hqdefault thumbnail URL for the given video id", () => {
  expect(youtubeThumbnailUrl(VIDEO_ID)).toBe(
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  );
});
