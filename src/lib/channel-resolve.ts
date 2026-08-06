import { parseChannelInput, rssUrlFor } from "./channel-input";

const SCRAPE_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const ALLOWED_HOSTS = new Set(["www.youtube.com", "youtube.com"]);
const HANDLE_SEGMENT = "[A-Za-z0-9_.-]{3,30}";
const CUSTOM_SEGMENT = "[A-Za-z0-9_.-]{1,100}";
const BARE_HANDLE_PATTERN = new RegExp(`^@${HANDLE_SEGMENT}$`);
const URL_PATH_PATTERN = new RegExp(
  `^(?:\\/@(${HANDLE_SEGMENT})|\\/c\\/(${CUSTOM_SEGMENT})|\\/user\\/(${CUSTOM_SEGMENT}))(?:\\/.*)?$`,
);
const CANONICAL_LINK_PATTERN =
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/;

export type ResolveChannelInputResult =
  | { ok: true; channelId: string; rssUrl: string }
  | { ok: false; reason: "unrecognized" }
  | { ok: false; reason: "resolve-failed" };

function scrapeUrlFor(input: string): string | null {
  if (BARE_HANDLE_PATTERN.test(input)) {
    return `https://www.youtube.com/${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;

  const match = url.pathname.match(URL_PATH_PATTERN);
  if (!match) return null;

  return `https://www.youtube.com${match[0]}`;
}

export async function resolveChannelInput(
  input: string,
): Promise<ResolveChannelInputResult> {
  const trimmed = input.trim();

  const direct = parseChannelInput(trimmed);
  if (direct) return { ok: true, ...direct };

  const scrapeUrl = scrapeUrlFor(trimmed);
  if (!scrapeUrl) return { ok: false, reason: "unrecognized" };

  let res: Response;
  try {
    res = await fetch(scrapeUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "resolve-failed" };
  }
  if (!res.ok) return { ok: false, reason: "resolve-failed" };

  const html = await res.text();
  const match = html.match(CANONICAL_LINK_PATTERN);
  const channelId = match?.[1];
  if (!channelId) return { ok: false, reason: "resolve-failed" };

  return { ok: true, channelId, rssUrl: rssUrlFor(channelId) };
}
