const ISO_8601_DURATION_RE =
  /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

const BAD_KEY_REASONS_403 = new Set([
  "keyInvalid",
  "forbidden",
  "accessNotConfigured",
]);

// Google's real invalid-key response is HTTP 400 with a generic
// errors[0].reason ("badRequest") and the specific reason only in details[].
const BAD_KEY_REASONS_400 = new Set([
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "keyInvalid",
  "keyExpired",
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

  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  const seconds = match[4] ? parseInt(match[4], 10) : 0;

  const totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return totalSeconds > 0 ? totalSeconds : null;
}

function badKeyReasons(status: number): Set<string> | null {
  if (status === 403) return BAD_KEY_REASONS_403;
  if (status === 400) return BAD_KEY_REASONS_400;
  return null;
}

export function classifyYoutubeApiError(
  status: number,
  reasons: string[],
): "transient" | "bad-key" {
  const keyReasons = badKeyReasons(status);
  if (keyReasons && reasons.some((reason) => keyReasons.has(reason))) {
    return "bad-key";
  }
  return "transient";
}

function extractErrorReasons(body: unknown): string[] {
  const reasons: string[] = [];
  const error = (body as { error?: unknown } | null)?.error as
    | { errors?: unknown; details?: unknown }
    | null
    | undefined;
  if (typeof error !== "object" || error === null) return reasons;

  const first = Array.isArray(error.errors) ? error.errors[0] : undefined;
  const candidates = [
    first,
    ...(Array.isArray(error.details) ? error.details : []),
  ];
  for (const candidate of candidates) {
    const reason = (candidate as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string") reasons.push(reason);
  }
  return reasons;
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
    let reasons: string[] = [];
    try {
      reasons = extractErrorReasons(await res.json());
    } catch {
      reasons = [];
    }
    const failureClass = classifyYoutubeApiError(res.status, reasons);
    const keyReasons = badKeyReasons(res.status);
    const reason =
      (failureClass === "bad-key"
        ? reasons.find((r) => keyReasons?.has(r))
        : undefined) ??
      reasons[0] ??
      `http-${res.status}`;
    return {
      durations: new Map(),
      failure: { class: failureClass, reason },
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
