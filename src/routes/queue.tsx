import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  categories,
  subscriptions,
  videos,
  youtubeChannels,
} from "../db/schema";

function queueVideos(userId: number, sort: "newest" | "oldest") {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      publishedAt: videos.publishedAt,
      status: videos.status,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(
      subscriptions,
      eq(subscriptions.youtubeChannelId, youtubeChannels.id),
    )
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        inArray(videos.status, ["unwatched", "watching"]),
      ),
    )
    .orderBy(
      sort === "oldest" ? asc(videos.publishedAt) : desc(videos.publishedAt),
    )
    .all();
}

function continueWatchingVideos(userId: number) {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      publishedAt: videos.publishedAt,
      status: videos.status,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(
      subscriptions,
      eq(subscriptions.youtubeChannelId, youtubeChannels.id),
    )
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        eq(videos.status, "watching"),
      ),
    )
    .orderBy(desc(videos.publishedAt))
    .all();
}

function watchedVideos(userId: number) {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      watchedAt: videos.watchedAt,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(
      subscriptions,
      eq(subscriptions.youtubeChannelId, youtubeChannels.id),
    )
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(videos.status, "watched"),
        // Deliberately NO isNull(subscriptions.unsubscribedAt) filter here, unlike
        // queueVideos/continueWatchingVideos above -- this is true history, so a
        // channel's watched videos must keep showing even after unsubscribing. The
        // join still resolves a category, since spec002's unsubscribe only soft-deletes
        // the subscriptions row (sets unsubscribedAt) rather than removing it -- MVP's
        // single-user unique(userId, youtubeChannelId) constraint guarantees exactly one
        // such row per channel this user has ever subscribed to, active or not.
      ),
    )
    .orderBy(desc(videos.watchedAt))
    .all();
}

function resolveToggleView(
  view: string | undefined,
): "queue" | "continue-watching" {
  return view === "continue-watching" ? "continue-watching" : "queue";
}

// All three `path` functions share the exact `(sort?: string) => string` signature,
// even though only "queue" uses the argument -- TypeScript infers a call signature for
// a union of function types from their *common* arity, so a mismatched signature here
// (e.g. two of the three taking zero params) would make `entry.path(sort)` below a
// `tsc --noEmit` error ("Expected 0 arguments, but got 1") despite being invisible to
// `bun run lint`/`bun test`/`bun run dev`, which don't full-type-check.
const RETURN_VIEWS = {
  queue: {
    label: "Queue",
    path: (sort?: string) => `/queue${sort === "oldest" ? "?sort=oldest" : ""}`,
  },
  "continue-watching": {
    label: "Continue Watching",
    path: (_sort?: string) => "/continue-watching",
  },
  watched: {
    label: "Watched",
    path: (_sort?: string) => "/watched",
  },
} as const;

function resolveReturnTarget(
  from: string | undefined,
  sort: string | undefined,
) {
  const key =
    from !== undefined && from in RETURN_VIEWS
      ? (from as keyof typeof RETURN_VIEWS)
      : "queue";
  const entry = RETURN_VIEWS[key];
  return { url: entry.path(sort), label: entry.label };
}
