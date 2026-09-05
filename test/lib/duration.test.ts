import { expect, test } from "bun:test";
import { formatDuration } from "../../src/lib/duration";

test("formats a duration under a minute", () => {
  expect(formatDuration(5)).toBe("0:05");
});

test("formats minutes-only under an hour", () => {
  expect(formatDuration(333)).toBe("5:33");
});

test("formats exactly one hour", () => {
  expect(formatDuration(3600)).toBe("1:00:00");
});

test("formats a multi-hour duration", () => {
  expect(formatDuration(3735)).toBe("1:02:15");
});
