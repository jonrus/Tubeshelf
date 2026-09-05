const ISO_8601_DURATION_RE =
  /^P(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

const BAD_KEY_REASONS = new Set([
  "keyInvalid",
  "forbidden",
  "accessNotConfigured",
]);

export function parseIso8601Duration(iso: string): number | null {
  const match = ISO_8601_DURATION_RE.exec(iso);
  if (!match) return null;

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return totalSeconds > 0 ? totalSeconds : null;
}

export function classifyYoutubeApiError(
  status: number,
  reason: string | undefined,
): "transient" | "bad-key" {
  if (status === 403 && reason !== undefined && BAD_KEY_REASONS.has(reason)) {
    return "bad-key";
  }
  return "transient";
}
