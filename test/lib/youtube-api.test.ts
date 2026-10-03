import { expect, spyOn, test } from "bun:test";
import {
  classifyYoutubeApiError,
  fetchVideoDurations,
  parseIso8601Duration,
} from "../../src/lib/youtube-api";

test("parses minutes and seconds", () => {
  expect(parseIso8601Duration("PT15M33S")).toBe(933);
});

test("parses hours, minutes, and seconds", () => {
  expect(parseIso8601Duration("PT1H2M15S")).toBe(3735);
});

test("parses a day component with hours", () => {
  expect(parseIso8601Duration("P1DT2H")).toBe(93600);
});

test("parses a day-only duration", () => {
  expect(parseIso8601Duration("P1D")).toBe(86400);
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
  expect(classifyYoutubeApiError(403, ["keyInvalid"])).toBe("bad-key");
});

test("classifies 403 forbidden as a bad key", () => {
  expect(classifyYoutubeApiError(403, ["forbidden"])).toBe("bad-key");
});

test("classifies 403 accessNotConfigured as a bad key", () => {
  expect(classifyYoutubeApiError(403, ["accessNotConfigured"])).toBe("bad-key");
});

test("classifies 403 quotaExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, ["quotaExceeded"])).toBe("transient");
});

test("classifies 403 rateLimitExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, ["rateLimitExceeded"])).toBe("transient");
});

test("classifies 403 userRateLimitExceeded as transient", () => {
  expect(classifyYoutubeApiError(403, ["userRateLimitExceeded"])).toBe(
    "transient",
  );
});

test("classifies an unrecognized 403 reason as transient", () => {
  expect(classifyYoutubeApiError(403, ["somethingUnrecognized"])).toBe(
    "transient",
  );
});

test("classifies a generic 400 as transient", () => {
  expect(classifyYoutubeApiError(400, [])).toBe("transient");
});

test("classifies 400 with API_KEY_INVALID alongside a generic badRequest as a bad key", () => {
  expect(classifyYoutubeApiError(400, ["badRequest", "API_KEY_INVALID"])).toBe(
    "bad-key",
  );
});

test("classifies 400 API_KEY_EXPIRED as a bad key", () => {
  expect(classifyYoutubeApiError(400, ["API_KEY_EXPIRED"])).toBe("bad-key");
});

test("classifies 400 keyInvalid as a bad key", () => {
  expect(classifyYoutubeApiError(400, ["keyInvalid"])).toBe("bad-key");
});

test("classifies 400 keyExpired as a bad key", () => {
  expect(classifyYoutubeApiError(400, ["keyExpired"])).toBe("bad-key");
});

test("classifies a 400 badRequest alone as transient", () => {
  expect(classifyYoutubeApiError(400, ["badRequest"])).toBe("transient");
});

test("fetchVideoDurations classifies Google's real invalid-key 400 as bad-key", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          code: 400,
          errors: [{ reason: "badRequest" }],
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "API_KEY_INVALID",
            },
          ],
        },
      }),
      { status: 400 },
    ),
  );

  const result = await fetchVideoDurations(["abcdefghijk"], "bogus");

  expect(result.failure).toEqual({
    class: "bad-key",
    reason: "API_KEY_INVALID",
  });
  fetchSpy.mockRestore();
});

test("fetchVideoDurations tolerates a malformed details field", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { errors: [{ reason: "badRequest" }], details: "oops" },
      }),
      { status: 400 },
    ),
  );

  const result = await fetchVideoDurations(["abcdefghijk"], "k");

  expect(result.failure).toEqual({ class: "transient", reason: "badRequest" });
  fetchSpy.mockRestore();
});

test("fetchVideoDurations returnedIds includes unresolved items but not id-less ones", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        items: [
          { id: "resolved0001", contentDetails: { duration: "PT1M" } },
          { id: "zeroDur0001", contentDetails: { duration: "P0D" } },
          { id: "badDur00001", contentDetails: { duration: "garbage" } },
          { id: "noDur000001", contentDetails: {} },
          { id: "noDetails001" },
          { contentDetails: { duration: "PT5S" } },
        ],
      }),
      { status: 200 },
    ),
  );

  const result = await fetchVideoDurations(["x"], "k");

  expect(result.failure).toBeNull();
  expect([...result.durations.keys()]).toEqual(["resolved0001"]);
  expect(result.returnedIds).toEqual(
    new Set([
      "resolved0001",
      "zeroDur0001",
      "badDur00001",
      "noDur000001",
      "noDetails001",
    ]),
  );
  fetchSpy.mockRestore();
});

test("fetchVideoDurations returnedIds is empty on failure", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 500 }),
  );

  const result = await fetchVideoDurations(["abcdefghijk"], "k");

  expect(result.failure?.class).toBe("transient");
  expect(result.returnedIds.size).toBe(0);
  fetchSpy.mockRestore();
});
