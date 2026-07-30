// Shared by both the sort-toggle links and CategoryFilterLinks's buildHref below --
// one place that knows how to assemble a /queue URL from its two optional params, so
// there's exactly one `?` vs. no-`?` decision instead of two ad hoc ones that could
// drift.
export function buildQueueHref(
  sort: "newest" | "oldest",
  category?: number,
): string {
  const params = new URLSearchParams();
  if (sort === "oldest") params.set("sort", "oldest");
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/queue${qs ? `?${qs}` : ""}`;
}

export function buildContinueWatchingHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/continue-watching${qs ? `?${qs}` : ""}`;
}

export function buildWatchedHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/watched${qs ? `?${qs}` : ""}`;
}

export function buildIgnoredHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/ignored${qs ? `?${qs}` : ""}`;
}
