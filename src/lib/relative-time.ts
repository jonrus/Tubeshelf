const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  // Clamp negative diffs (a future publishedAt from clock skew, or a malformed/adversarial
  // RSS timestamp -- publishedAt is untrusted external feed data, same posture rss.ts
  // already takes toward it elsewhere) to "just now" rather than rendering "-1h" or similar.
  if (diffMs <= 0) return "just now";
  if (diffMs < MINUTE) return "just now";
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h ago`;
  if (diffMs < WEEK) return `${Math.floor(diffMs / DAY)}d ago`;
  if (diffMs < 4 * WEEK) return `${Math.floor(diffMs / WEEK)}w ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
