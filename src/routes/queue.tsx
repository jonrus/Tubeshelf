import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  categories,
  subscriptions,
  videos,
  youtubeChannels,
} from "../db/schema";
import { csrfCheck, requireAuth } from "../lib/auth";
import { listCategoriesWithCounts } from "../lib/categories";
import { getCurrentUser } from "../lib/current-user";
import { getNavCounts } from "../lib/nav-counts";
import { buildQueueHref } from "../lib/queue-urls";
import {
  ignoreVideo,
  setWatching,
  toggleQueueStatus,
  toggleWatchedFromWatchingPage,
  unignoreVideo,
} from "../lib/watch-status";
import { Layout } from "../views/layout";
import { QueueList, QueueListMore, queueCard } from "../views/queue-list";
import { WatchingPage, WatchStatusBadge } from "../views/watching-page";

const PAGE_SIZE = 20;

function parseCursor(
  cursor: string | undefined,
  cursorId: string | undefined,
): { at: Date; id: number } | undefined {
  if (cursor === undefined || cursorId === undefined) return undefined;
  const at = new Date(Number(cursor));
  const id = Number(cursorId);
  if (Number.isNaN(at.getTime()) || !Number.isInteger(id)) return undefined;
  return { at, id };
}

function queueVideos(
  userId: number,
  sort: "newest" | "oldest",
  categoryId: number | undefined,
  cursor: { at: Date; id: number } | undefined,
) {
  const fetched = db
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
        ...(cursor
          ? [
              sort === "oldest"
                ? or(
                    gt(videos.publishedAt, cursor.at),
                    and(
                      eq(videos.publishedAt, cursor.at),
                      gt(videos.id, cursor.id),
                    ),
                  )
                : or(
                    lt(videos.publishedAt, cursor.at),
                    and(
                      eq(videos.publishedAt, cursor.at),
                      lt(videos.id, cursor.id),
                    ),
                  ),
            ]
          : []),
      ),
    )
    .orderBy(
      ...(sort === "oldest"
        ? [asc(videos.publishedAt), asc(videos.id)]
        : [desc(videos.publishedAt), desc(videos.id)]),
    )
    .limit(PAGE_SIZE + 1)
    .all();

  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    hasMore && lastRow && lastRow.publishedAt !== null
      ? { at: lastRow.publishedAt, id: lastRow.id }
      : undefined;

  return { rows, nextCursor };
}

function queueRowById(id: number) {
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
    .where(eq(videos.id, id))
    .get();
}

function continueWatchingVideos(
  userId: number,
  categoryId: number | undefined,
  cursor: { at: Date; id: number } | undefined,
) {
  const fetched = db
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
        ...(cursor
          ? [
              or(
                lt(videos.publishedAt, cursor.at),
                and(
                  eq(videos.publishedAt, cursor.at),
                  lt(videos.id, cursor.id),
                ),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(videos.publishedAt), desc(videos.id))
    .limit(PAGE_SIZE + 1)
    .all();

  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    hasMore && lastRow && lastRow.publishedAt !== null
      ? { at: lastRow.publishedAt, id: lastRow.id }
      : undefined;

  return { rows, nextCursor };
}

function watchedVideos(
  userId: number,
  categoryId: number | undefined,
  cursor: { at: Date; id: number } | undefined,
) {
  const fetched = db
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
        ...(cursor
          ? [
              or(
                lt(videos.watchedAt, cursor.at),
                and(eq(videos.watchedAt, cursor.at), lt(videos.id, cursor.id)),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(videos.watchedAt), desc(videos.id))
    .limit(PAGE_SIZE + 1)
    .all();

  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  // watchedAt is DB-guaranteed non-null here via the watched_at_check constraint
  // (schema.ts) given the fixed status = "watched" filter above, but the column's
  // schema type is still nullable, so this guard stays for tsc's benefit.
  const nextCursor =
    hasMore && lastRow && lastRow.watchedAt !== null
      ? { at: lastRow.watchedAt, id: lastRow.id }
      : undefined;

  return { rows, nextCursor };
}

function ignoredVideos(
  userId: number,
  categoryId: number | undefined,
  cursor: { at: Date; id: number } | undefined,
) {
  const fetched = db
    .select({
      id: videos.id,
      youtubeVideoId: videos.youtubeVideoId,
      title: videos.title,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
      ignoreMethod: videos.ignoreMethod,
      createdAt: videos.createdAt,
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
        eq(videos.status, "ignored"),
        ...(categoryId !== undefined
          ? [eq(subscriptions.categoryId, categoryId)]
          : []),
        ...(cursor
          ? [
              or(
                lt(videos.createdAt, cursor.at),
                and(eq(videos.createdAt, cursor.at), lt(videos.id, cursor.id)),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(videos.createdAt), desc(videos.id))
    .limit(PAGE_SIZE + 1)
    .all();

  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    hasMore && lastRow ? { at: lastRow.createdAt, id: lastRow.id } : undefined;

  return { rows, nextCursor };
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

function resolveToggleView(
  view: string | undefined,
): "queue" | "continue-watching" {
  return view === "continue-watching" ? "continue-watching" : "queue";
}

// All three branches build their URL through URLSearchParams, not string
// interpolation -- category is an unvalidated, attacker-controlled string at this
// call site, and URLSearchParams guarantees it's percent-encoded into the querystring
// rather than splicing raw bytes (CR/LF, `&`, `#`, etc.) into a value later handed
// straight to c.redirect() in POST /videos/:id/watched-toggle.
function buildReturnPath(
  base: string,
  sort?: string,
  category?: string,
): string {
  const params = new URLSearchParams();
  if (sort === "oldest") params.set("sort", "oldest");
  if (category !== undefined) params.set("category", category);
  const qs = params.toString();
  return `${base}${qs ? `?${qs}` : ""}`;
}

// All three `path` functions share the exact `(sort?: string, category?: string) =>
// string` signature, even though only "queue" uses `sort` -- TypeScript infers a call
// signature for a union of function types from their *common* arity, so a mismatched
// signature here (e.g. two of the three taking fewer params) would make
// `entry.path(sort, category)` below a `tsc --noEmit` error ("Expected 1 arguments,
// but got 2") despite being invisible to `bun run lint`/`bun test`/`bun run dev`,
// which don't full-type-check.
const RETURN_VIEWS = {
  queue: {
    label: "Queue",
    path: (sort?: string, category?: string) =>
      buildReturnPath("/queue", sort, category),
  },
  "continue-watching": {
    label: "Continue Watching",
    path: (_sort?: string, category?: string) =>
      buildReturnPath("/continue-watching", undefined, category),
  },
  watched: {
    label: "Watched",
    path: (_sort?: string, category?: string) =>
      buildReturnPath("/watched", undefined, category),
  },
} as const;

function resolveReturnTarget(
  from: string | undefined,
  sort: string | undefined,
  category: string | undefined,
) {
  const key =
    from !== undefined && from in RETURN_VIEWS
      ? (from as keyof typeof RETURN_VIEWS)
      : "queue";
  const entry = RETURN_VIEWS[key];
  return { url: entry.path(sort, category), label: entry.label };
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

queueRoute.use("*", csrfCheck, requireAuth);

queueRoute.get("/", (c) => c.redirect("/queue", 302));

queueRoute.get("/queue", (c) => {
  const user = getCurrentUser();
  const sort = resolveSort(c.req.query("sort"));
  const category = resolveCategoryFilter(c.req.query("category"));
  const cursor = parseCursor(c.req.query("cursor"), c.req.query("cursorId"));
  const { rows, nextCursor } = queueVideos(user.id, sort, category, cursor);

  if (cursor !== undefined) {
    return c.html(
      <QueueListMore
        view="queue"
        sort={sort}
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />,
    );
  }

  return c.html(
    <Layout
      title="Queue"
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView="queue"
      currentCategory={category}
      currentSort={sort}
    >
      <p>
        <a href={buildQueueHref("newest", category)}>Newest first</a> ·{" "}
        <a href={buildQueueHref("oldest", category)}>Oldest first</a>
      </p>
      <QueueList
        view="queue"
        sort={sort}
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />
    </Layout>,
  );
});

queueRoute.get("/continue-watching", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  const cursor = parseCursor(c.req.query("cursor"), c.req.query("cursorId"));
  const { rows, nextCursor } = continueWatchingVideos(
    user.id,
    category,
    cursor,
  );

  if (cursor !== undefined) {
    return c.html(
      <QueueListMore
        view="continue-watching"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />,
    );
  }

  return c.html(
    <Layout
      title="Continue Watching"
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView="continue-watching"
      currentCategory={category}
    >
      <QueueList
        view="continue-watching"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />
    </Layout>,
  );
});

queueRoute.get("/watched", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  const cursor = parseCursor(c.req.query("cursor"), c.req.query("cursorId"));
  const { rows, nextCursor } = watchedVideos(user.id, category, cursor);

  if (cursor !== undefined) {
    return c.html(
      <QueueListMore
        view="watched"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />,
    );
  }

  return c.html(
    <Layout
      title="Watched"
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView="watched"
      currentCategory={category}
    >
      <QueueList
        view="watched"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />
    </Layout>,
  );
});

queueRoute.get("/ignored", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  const cursor = parseCursor(c.req.query("cursor"), c.req.query("cursorId"));
  const { rows, nextCursor } = ignoredVideos(user.id, category, cursor);

  if (cursor !== undefined) {
    return c.html(
      <QueueListMore
        view="ignored"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />,
    );
  }

  return c.html(
    <Layout
      title="Ignored"
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView="ignored"
      currentCategory={category}
    >
      <QueueList
        view="ignored"
        category={category}
        rows={rows}
        nextCursor={nextCursor}
      />
    </Layout>,
  );
});

queueRoute.get("/watching/:id", (c) => {
  const id = Number(c.req.param("id"));
  const video = videoForWatchingPage(id);
  if (!video) return c.notFound();

  const user = getCurrentUser();
  const from = c.req.query("from");
  const sort = c.req.query("sort");
  const category = c.req.query("category");
  const returnTarget = resolveReturnTarget(from, sort, category);

  return c.html(
    <WatchingPage
      id={video.id}
      youtubeVideoId={video.youtubeVideoId}
      title={video.title}
      status={video.status}
      from={from}
      sort={sort}
      category={category}
      returnUrl={returnTarget.url}
      returnLabel={returnTarget.label}
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView={undefined}
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
  const category = c.req.query("category");
  return c.redirect(resolveReturnTarget(from, sort, category).url, 303);
});

queueRoute.post("/videos/:id/toggle", (c) => {
  const id = Number(c.req.param("id"));
  const result = toggleQueueStatus(id);
  if (!result) return c.notFound();

  const view = resolveToggleView(c.req.query("view"));

  if (result.status === "watched") {
    c.header("HX-Reswap", "delete");
    return c.body(null);
  }
  if (view === "continue-watching") {
    c.header("HX-Reswap", "delete");
    return c.body(null);
  }

  const sort = resolveSort(c.req.query("sort"));
  const category = resolveCategoryFilter(c.req.query("category"));
  const row = queueRowById(id);
  if (!row) return c.notFound();
  return c.html(queueCard(row, "queue", sort, category));
});

queueRoute.post("/videos/:id/ignore", (c) => {
  const id = Number(c.req.param("id"));
  const result = ignoreVideo(id);
  if (!result) return c.notFound();

  c.header("HX-Reswap", "delete");
  return c.body(null);
});

queueRoute.post("/videos/:id/unignore", (c) => {
  const id = Number(c.req.param("id"));
  const result = unignoreVideo(id);
  if (!result) return c.notFound();

  c.header("HX-Reswap", "delete");
  return c.body(null);
});
