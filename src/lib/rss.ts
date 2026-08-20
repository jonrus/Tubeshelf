const FETCH_TIMEOUT_MS = 5_000;
const VIDEO_ID_PREFIX = "yt:video:";

export type FeedEntry = {
  videoId: string;
  title: string;
  description: string | null;
  publishedAt: Date;
};

export type ChannelFeed = { title: string; entries: FeedEntry[] };

function parseEntry(raw: unknown): FeedEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const id = entry.id;
  if (typeof id !== "string" || !id.startsWith(VIDEO_ID_PREFIX)) return null;
  const videoId = id.slice(VIDEO_ID_PREFIX.length);
  if (!videoId) return null;

  const title = entry.title;
  if (typeof title !== "string" || title.length === 0) return null;

  const published = entry.published;
  if (typeof published !== "string") return null;
  const publishedAt = new Date(published);
  if (Number.isNaN(publishedAt.getTime())) return null;

  const mediaGroup = entry["media:group"];
  const description =
    typeof mediaGroup === "object" && mediaGroup !== null
      ? (mediaGroup as Record<string, unknown>)["media:description"]
      : undefined;

  return {
    videoId,
    title,
    description: typeof description === "string" ? description : null,
    publishedAt,
  };
}

export async function fetchChannelFeed(
  rssUrl: string,
): Promise<ChannelFeed | null> {
  let res: Response;
  try {
    res = await fetch(rssUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null; // network error or timeout
  }
  if (!res.ok) return null;

  const xml = await res.text();
  const parsed = Bun.XML.parse(xml);
  const feed = parsed.feed;
  const title = typeof feed === "object" ? feed.title : undefined;
  if (typeof title !== "string" || title.length === 0) return null;

  const rawEntries = typeof feed === "object" ? feed.entry : undefined;
  const entryList: unknown[] = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries
      ? [rawEntries]
      : [];

  const entries: FeedEntry[] = [];
  for (const raw of entryList) {
    const entry = parseEntry(raw);
    if (entry) {
      entries.push(entry);
    } else {
      console.error("skipping malformed feed entry", raw);
    }
  }

  return { title, entries };
}
