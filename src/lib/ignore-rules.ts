import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { ignoreRules, videos } from "../db/schema";

export function listIgnoreRules() {
  return db.select().from(ignoreRules).orderBy(asc(ignoreRules.keyword)).all();
}

// Structural typing lets both a full ignoreRules row and a bare {keyword} literal
// satisfy this -- callers that already fetched full rows (listIgnoreRules) don't need
// to re-shape them.
export function matchesAnyRule(
  video: { title: string; description: string | null },
  rules: { keyword: string }[],
): boolean {
  const haystack = `${video.title} ${video.description ?? ""}`.toLowerCase();
  // Relies on IgnoreRule.keyword never being empty -- enforced by the add/edit routes'
  // validation below. An empty keyword's `"".toLowerCase()` would make `.includes("")`
  // true unconditionally, matching every video -- never let an empty keyword reach here.
  return rules.some((rule) => haystack.includes(rule.keyword.toLowerCase()));
}

// Called after every IgnoreRule add/edit/delete. Re-runs the current rule set against
// every ignored+auto video (un-ignoring the ones that no longer match) and every
// unwatched, non-exempt video (auto-ignoring the ones that newly match). Manual ignores,
// watching/watched videos, and videos the user explicitly un-ignored
// (videos.auto_ignore_exempt) are excluded from both queries by construction -- none is a
// candidate the reconciliation pass ever considers (docs/specs/031-behavior-correctness-ops-polish.md).
export function reconcileIgnoreRules(): void {
  const rules = listIgnoreRules();

  // Wrapped in one transaction so the whole pass is atomic. Unlike applyFeedToChannel
  // (also transactional now -- see docs/specs/030-ingestion-enrichment-robustness.md),
  // which gets retried by the next hourly scheduled poll regardless, this function only
  // reruns on the next explicit rule add/edit/delete. A crash partway through the loop
  // below (a genuine DB failure, not a reachable app-level error) would otherwise leave
  // some videos reconciled and others not, with no guaranteed retry.
  db.transaction((tx) => {
    const autoIgnored = tx
      .select({
        id: videos.id,
        title: videos.title,
        description: videos.description,
      })
      .from(videos)
      .where(and(eq(videos.status, "ignored"), eq(videos.ignoreMethod, "auto")))
      .all();
    for (const video of autoIgnored) {
      if (!matchesAnyRule(video, rules)) {
        tx.update(videos)
          .set({ status: "unwatched", ignoreMethod: null })
          .where(eq(videos.id, video.id))
          .run();
      }
    }

    const candidates = tx
      .select({
        id: videos.id,
        title: videos.title,
        description: videos.description,
      })
      .from(videos)
      .where(
        and(eq(videos.status, "unwatched"), eq(videos.autoIgnoreExempt, false)),
      )
      .all();
    for (const video of candidates) {
      if (matchesAnyRule(video, rules)) {
        tx.update(videos)
          .set({ status: "ignored", ignoreMethod: "auto" })
          .where(eq(videos.id, video.id))
          .run();
      }
    }
  });
}
