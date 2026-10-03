import { logger } from "./logger";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const VIDEO_ID_PREFIX = "yt:video:";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type FeedEntry = {
  videoId: string;
  title: string;
  description: string | null;
  publishedAt: Date;
};

export type ChannelFeed = { title: string; entries: FeedEntry[] };

function parseVideoId(entry: Record<string, unknown>): string | null {
  const id = entry.id;
  if (typeof id !== "string" || !id.startsWith(VIDEO_ID_PREFIX)) return null;
  const videoId = id.slice(VIDEO_ID_PREFIX.length);
  return VIDEO_ID_RE.test(videoId) ? videoId : null;
}

function parseTitle(entry: Record<string, unknown>): string | null {
  const title = entry.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

function parsePublishedAt(entry: Record<string, unknown>): Date | null {
  const published = entry.published;
  if (typeof published !== "string") return null;
  const publishedAt = new Date(published);
  return Number.isNaN(publishedAt.getTime()) ? null : publishedAt;
}

function parseDescription(entry: Record<string, unknown>): string | null {
  const mediaGroup = entry["media:group"];
  const description =
    typeof mediaGroup === "object" && mediaGroup !== null
      ? (mediaGroup as Record<string, unknown>)["media:description"]
      : undefined;
  return typeof description === "string" ? description : null;
}

function parseEntry(raw: unknown): FeedEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const videoId = parseVideoId(entry);
  if (!videoId) return null;

  const title = parseTitle(entry);
  if (!title) return null;

  const publishedAt = parsePublishedAt(entry);
  if (!publishedAt) return null;

  return {
    videoId,
    title,
    description: parseDescription(entry),
    publishedAt,
  };
}

// Reads the body as UTF-8 text, bailing out (null) once it exceeds
// MAX_FEED_BYTES. Chunks are concatenated and decoded once so multi-byte
// characters split across chunk boundaries stay intact.
async function readCappedBody(
  res: Response,
  rssUrl: string,
): Promise<string | null> {
  const warnTooLarge = () =>
    logger.warn("Feed exceeds size cap", {
      url: rssUrl,
      maxBytes: MAX_FEED_BYTES,
    });

  if (Number(res.headers.get("content-length")) > MAX_FEED_BYTES) {
    warnTooLarge();
    return null;
  }
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // a rejecting cancel() must not mask the null return
      }
      warnTooLarge();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchChannelFeed(
  rssUrl: string,
): Promise<ChannelFeed | null> {
  let xml: string | null;
  try {
    const res = await fetch(rssUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    xml = await readCappedBody(res, rssUrl);
  } catch {
    return null; // network error, timeout, or read error mid-stream
  }
  if (xml === null) return null;

  let parsed: ReturnType<typeof Bun.XML.parse>;
  try {
    parsed = Bun.XML.parse(xml);
  } catch (err) {
    logger.warn("Feed is not valid XML", { url: rssUrl, err });
    return null;
  }
  const feed = parsed.feed;
  if (typeof feed !== "object" || feed === null) return null;

  const title = feed.title;
  if (typeof title !== "string" || title.length === 0) return null;

  const rawEntries = feed.entry;
  const entryList: unknown[] = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries
      ? [rawEntries]
      : [];

  const entries: FeedEntry[] = [];
  let malformedCount = 0;
  for (const raw of entryList) {
    const entry = parseEntry(raw);
    if (entry) {
      entries.push(entry);
    } else {
      malformedCount++;
      logger.debug("Malformed feed entry", {
        channel: title,
        url: rssUrl,
        raw,
      });
    }
  }
  if (malformedCount > 0) {
    logger.warn("Skipped malformed feed entries", {
      channel: title,
      url: rssUrl,
      count: malformedCount,
    });
  }

  return { title, entries };
}
