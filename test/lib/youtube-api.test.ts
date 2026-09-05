import { expect, test } from "bun:test";
import {
  classifyYoutubeApiError,
  parseIso8601Duration,
} from "../../src/lib/youtube-api";

test("parses minutes and seconds", () => {
  expect(parseIso8601Duration("PT15M33S")).toBe(933);
});

test("parses hours, minutes, and seconds", () => {
  expect(parseIso8601Duration("PT1H2M15S")).toBe(3735);
});

test("treats PT0S as not yet available", () => {
  expect(parseIso8601Duration("PT0S")).toBeNull();
});

test("treats P0D as not yet available", () => {
  expect(parseIso8601Duration("P0D")).toBeNull();
});

test("treats a malformed string as not yet available", () => {
  expect(parseIso8601Duration("not-a-duration")).toBeNull();
});

test("classifies 403 keyInvalid as a bad key", () => {
  expect(classifyYoutubeApiError(403, "keyInvalid")).toBe("bad-key");
});

test("classifies 403 forbidden as a bad key", () => {
  expect(classifyYoutubeApiError(403, "forbidden")).toBe("bad-key");
});

test("classifies 403 accessNotConfigured as a bad key", () => {
  expect(classifyYoutubeApiError(403, "accessNotConfigured")).toBe(
    "bad-key",
  );
});

test("classifies 403 quotaExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, "quotaExceeded")).toBe("transient");
});

test("classifies 403 rateLimitExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, "rateLimitExceeded")).toBe(
    "transient",
  );
});

test("classifies 403 userRateLimitExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, "userRateLimitExceeded")).toBe(
    "transient",
  );
});

test("classifies an unrecognized 403 reason as transient", () => {
  expect(classifyYoutubeApiError(403, "somethingUnrecognized")).toBe(
    "transient",
  );
});

test("classifies a generic 400 as transient", () => {
  expect(classifyYoutubeApiError(400, undefined)).toBe("transient");
});
