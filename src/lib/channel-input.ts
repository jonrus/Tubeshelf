const CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;

function rssUrlFor(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function parseChannelInput(
  input: string,
): { channelId: string; rssUrl: string } | null {
  const trimmed = input.trim();

  if (CHANNEL_ID_PATTERN.test(trimmed)) {
    return { channelId: trimmed, rssUrl: rssUrlFor(trimmed) };
  }

  const pathMatch = trimmed.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
  const pathChannelId = pathMatch?.[1];
  if (pathChannelId) {
    return { channelId: pathChannelId, rssUrl: rssUrlFor(pathChannelId) };
  }

  try {
    const url = new URL(trimmed);
    const channelId = url.searchParams.get("channel_id");
    if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
      return { channelId, rssUrl: rssUrlFor(channelId) };
    }
  } catch {
    // not a URL at all — falls through to null
  }

  return null;
}
