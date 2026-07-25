import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  categories,
  subscriptions,
  videos,
  youtubeChannels,
} from "../db/schema";
import { getCurrentUser } from "../lib/current-user";
import {
  setWatching,
  toggleQueueStatus,
  toggleWatchedFromWatchingPage,
} from "../lib/watch-status";
import { Layout } from "../views/layout";
import { CategoryFilterLinks, QueueList } from "../views/queue-list";
import { WatchingPage, WatchStatusBadge } from "../views/watching-page";

function queueVideos(
  userId: number,
  sort: "newest" | "oldest",
  categoryId?: number,
) {
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
        ...(categoryId !== undefined
          ? [eq(subscriptions.categoryId, categoryId)]
          : []),
      ),
    )
    .orderBy(
      sort === "oldest" ? asc(videos.publishedAt) : desc(videos.publishedAt),
    )
    .all();
}

function continueWatchingVideos(userId: number, categoryId?: number) {
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
        ...(categoryId !== undefined
          ? [eq(subscriptions.categoryId, categoryId)]
          : []),
      ),
    )
    .orderBy(desc(videos.publishedAt))
    .all();
}

function watchedVideos(userId: number, categoryId?: number) {
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
        ...(categoryId !== undefined
          ? [eq(subscriptions.categoryId, categoryId)]
          : []),
      ),
    )
    .orderBy(desc(videos.watchedAt))
    .all();
}

function resolveCategoryFilter(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id)) return undefined;
  const exists = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  return exists ? id : undefined;
}

function allCategories() {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      isSystem: categories.isSystem,
    })
    .from(categories)
    .orderBy(desc(categories.isSystem), asc(categories.name))
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

function resolveSort(sort: string | undefined): "newest" | "oldest" {
  return sort === "oldest" ? "oldest" : "newest";
}

function videoForWatchingPage(videoId: number) {
  return db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      status: videos.status,
    })
    .from(videos)
    .where(eq(videos.id, videoId))
    .get();
}

export const queueRoute = new Hono();

// Shared by both the sort-toggle links and CategoryFilterLinks's buildHref below --
// one place that knows how to assemble a /queue URL from its two optional params, so
// there's exactly one `?` vs. no-`?` decision instead of two ad hoc ones that could
// drift.
function buildQueueHref(sort: "newest" | "oldest", category?: number): string {
  const params = new URLSearchParams();
  if (sort === "oldest") params.set("sort", "oldest");
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/queue${qs ? `?${qs}` : ""}`;
}

queueRoute.get("/queue", (c) => {
  const user = getCurrentUser();
  const sort = resolveSort(c.req.query("sort"));
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <Layout title="Queue">
      <p>
        <a href={buildQueueHref("newest", category)}>Newest first</a> ·{" "}
        <a href={buildQueueHref("oldest", category)}>Oldest first</a>
      </p>
      <CategoryFilterLinks
        categories={allCategories()}
        current={category}
        buildHref={(catId) => buildQueueHref(sort, catId)}
      />
      <QueueList
        view="queue"
        sort={sort}
        category={category}
        rows={queueVideos(user.id, sort, category)}
      />
    </Layout>,
  );
});

function buildContinueWatchingHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/continue-watching${qs ? `?${qs}` : ""}`;
}

function buildWatchedHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/watched${qs ? `?${qs}` : ""}`;
}

queueRoute.get("/continue-watching", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <Layout title="Continue Watching">
      <CategoryFilterLinks
        categories={allCategories()}
        current={category}
        buildHref={buildContinueWatchingHref}
      />
      <QueueList
        view="continue-watching"
        category={category}
        rows={continueWatchingVideos(user.id, category)}
      />
    </Layout>,
  );
});

queueRoute.get("/watched", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <Layout title="Watched">
      <CategoryFilterLinks
        categories={allCategories()}
        current={category}
        buildHref={buildWatchedHref}
      />
      <QueueList
        view="watched"
        category={category}
        rows={watchedVideos(user.id, category)}
      />
    </Layout>,
  );
});

queueRoute.get("/watching/:id", (c) => {
  const id = Number(c.req.param("id"));
  const video = videoForWatchingPage(id);
  if (!video) return c.notFound();

  const from = c.req.query("from");
  const sort = c.req.query("sort");
  const returnTarget = resolveReturnTarget(from, sort);

  return c.html(
    <WatchingPage
      id={video.id}
      youtubeVideoId={video.youtubeVideoId}
      title={video.title}
      status={video.status}
      from={from}
      sort={sort}
      returnUrl={returnTarget.url}
      returnLabel={returnTarget.label}
    />,
  );
});

queueRoute.post("/videos/:id/watching", (c) => {
  const id = Number(c.req.param("id"));
  const result = setWatching(id);
  if (!result) return c.notFound();

  return c.html(<WatchStatusBadge status={result.status} oob />);
});

queueRoute.post("/videos/:id/watched-toggle", (c) => {
  const id = Number(c.req.param("id"));
  const result = toggleWatchedFromWatchingPage(id);
  if (!result) return c.notFound();

  const from = c.req.query("from");
  const sort = c.req.query("sort");
  return c.redirect(resolveReturnTarget(from, sort).url, 303);
});

queueRoute.post("/videos/:id/toggle", (c) => {
  const id = Number(c.req.param("id"));
  const result = toggleQueueStatus(id);
  if (!result) return c.notFound();

  const user = getCurrentUser();
  const view = resolveToggleView(c.req.query("view"));
  const sort = resolveSort(c.req.query("sort"));

  if (view === "continue-watching") {
    return c.html(
      <QueueList
        view="continue-watching"
        rows={continueWatchingVideos(user.id)}
      />,
    );
  }
  return c.html(
    <QueueList view="queue" sort={sort} rows={queueVideos(user.id, sort)} />,
  );
});
