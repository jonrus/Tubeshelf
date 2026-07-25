import { and, asc, eq, inArray } from "drizzle-orm";
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
// unwatched/watching video (auto-ignoring the ones that newly match). Manual ignores
// and watched videos are excluded from both queries below, by construction -- neither
// is a candidate the reconciliation pass ever considers, matching app_idea.md's MVP
// item 6 ("auto-ignored video that no longer matches... Unwatched/Watching video that
// newly matches... Manually-ignored videos are never touched").
export function reconcileIgnoreRules(): void {
  const rules = listIgnoreRules();

  // Wrapped in one transaction -- unlike applyFeedToChannel's per-channel upserts
  // (docs/specs/003-scheduled-video-ingestion.md's "no transaction needed" call),
  // which self-heal automatically on the next hourly scheduled poll regardless of a
  // mid-run failure, this function only reruns on the next explicit rule add/edit/
  // delete. A crash partway through the loop below (a genuine DB failure, not a
  // reachable app-level error) would otherwise leave some videos reconciled and
  // others not, with no guaranteed retry -- a single transaction makes the whole pass
  // atomic instead.
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
      .where(inArray(videos.status, ["unwatched", "watching"]))
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
