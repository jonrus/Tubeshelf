import { XMLParser } from "fast-xml-parser";

const FETCH_TIMEOUT_MS = 5_000;

export async function fetchChannelTitle(
  rssUrl: string,
): Promise<string | null> {
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
  const parsed = new XMLParser().parse(xml);
  const title = parsed?.feed?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}
