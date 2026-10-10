function buildParams(
  params: URLSearchParams,
  category?: number,
  cursor?: { at: Date; id: number },
): URLSearchParams {
  if (category !== undefined) params.set("category", String(category));
  if (cursor !== undefined) {
    params.set("cursor", String(cursor.at.getTime()));
    params.set("cursorId", String(cursor.id));
  }
  return params;
}

// Shared by both the sort-toggle links and the sidebar's category links (layout.tsx) --
// one place that knows how to assemble a /queue URL from its optional params, so
// there's exactly one `?` vs. no-`?` decision instead of two ad hoc ones that could
// drift. `sort` is omitted only when `undefined` ("use the category's default"); a given
// sort -- newest included -- is always written, since absence no longer means newest.
export function buildQueueHref(
  sort: "newest" | "oldest" | undefined,
  category?: number,
  cursor?: { at: Date; id: number },
): string {
  const params = new URLSearchParams();
  if (sort !== undefined) params.set("sort", sort);
  const qs = buildParams(params, category, cursor).toString();
  return `/queue${qs ? `?${qs}` : ""}`;
}

export function buildContinueWatchingHref(
  category?: number,
  cursor?: { at: Date; id: number },
): string {
  const qs = buildParams(new URLSearchParams(), category, cursor).toString();
  return `/continue-watching${qs ? `?${qs}` : ""}`;
}

export function buildWatchedHref(
  category?: number,
  cursor?: { at: Date; id: number },
): string {
  const qs = buildParams(new URLSearchParams(), category, cursor).toString();
  return `/watched${qs ? `?${qs}` : ""}`;
}

export function buildIgnoredHref(
  category?: number,
  cursor?: { at: Date; id: number },
): string {
  const qs = buildParams(new URLSearchParams(), category, cursor).toString();
  return `/ignored${qs ? `?${qs}` : ""}`;
}
