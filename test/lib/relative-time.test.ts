import { expect, test } from "bun:test";
import { formatRelativeTime } from "../../src/lib/relative-time";

const NOW = new Date("2026-07-30T12:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("returns 'just now' for a diff under a minute", () => {
  const date = new Date(NOW.getTime() - 30_000);
  expect(formatRelativeTime(date, NOW)).toBe("just now");
});

test("clamps a future date (negative diff) to 'just now'", () => {
  const date = new Date(NOW.getTime() + HOUR);
  expect(formatRelativeTime(date, NOW)).toBe("just now");
});

test("formats minutes for a diff under an hour", () => {
  const date = new Date(NOW.getTime() - 5 * MINUTE);
  expect(formatRelativeTime(date, NOW)).toBe("5m");
});

test("formats hours for a diff under a day", () => {
  const date = new Date(NOW.getTime() - 3 * HOUR);
  expect(formatRelativeTime(date, NOW)).toBe("3h");
});

test("formats days for a diff under a week", () => {
  const date = new Date(NOW.getTime() - 2 * DAY);
  expect(formatRelativeTime(date, NOW)).toBe("2d");
});

test("formats weeks for a diff under four weeks", () => {
  const date = new Date(NOW.getTime() - 2 * WEEK);
  expect(formatRelativeTime(date, NOW)).toBe("2w");
});

test("falls back to an absolute date without a year when the year matches now", () => {
  const date = new Date(NOW.getTime() - 40 * DAY);
  expect(date.getFullYear()).toBe(NOW.getFullYear());
  const expected = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  expect(formatRelativeTime(date, NOW)).toBe(expected);
});

test("falls back to an absolute date with a year when the year differs from now", () => {
  const date = new Date("2025-03-01T00:00:00.000Z");
  expect(date.getFullYear()).not.toBe(NOW.getFullYear());
  const expected = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  expect(formatRelativeTime(date, NOW)).toBe(expected);
});
