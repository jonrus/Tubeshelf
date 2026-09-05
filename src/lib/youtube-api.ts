const ISO_8601_DURATION_RE =
  /^P(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

const BAD_KEY_REASONS = new Set([
  "keyInvalid",
  "forbidden",
  "accessNotConfigured",
]);

const FETCH_TIMEOUT_MS = 5_000;
const VIDEOS_LIST_URL = "https://www.googleapis.com/youtube/v3/videos";

export type FetchVideoDurationsResult = {
  durations: Map<string, number>;
  failure: { class: "transient" | "bad-key"; reason: string } | null;
};

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

export async function fetchVideoDurations(
  videoIds: string[],
  apiKey: string,
): Promise<FetchVideoDurationsResult> {
  const url = new URL(VIDEOS_LIST_URL);
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("key", apiKey);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return {
      durations: new Map(),
      failure: { class: "transient", reason: "network-error" },
    };
  }

  if (!res.ok) {
    let reason: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: { errors?: { reason?: string }[] };
      };
      reason = body.error?.errors?.[0]?.reason;
    } catch {
      reason = undefined;
    }
    return {
      durations: new Map(),
      failure: {
        class: classifyYoutubeApiError(res.status, reason),
        reason: reason ?? `http-${res.status}`,
      },
    };
  }

  const body = (await res.json()) as {
    items?: { id?: string; contentDetails?: { duration?: string } }[];
  };

  const durations = new Map<string, number>();
  for (const item of body.items ?? []) {
    if (typeof item.id !== "string") continue;
    const duration = item.contentDetails?.duration;
    if (typeof duration !== "string") continue;
    const seconds = parseIso8601Duration(duration);
    if (seconds !== null) durations.set(item.id, seconds);
  }
  return { durations, failure: null };
}
