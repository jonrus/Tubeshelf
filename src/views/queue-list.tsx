import type { FC } from "hono/jsx";
import type { videos } from "../db/schema";

type VideoStatus = (typeof videos.$inferSelect)["status"];

export type QueueListView = "queue" | "continue-watching" | "watched";

export type QueueRow = {
  id: number;
  youtubeVideoId: string;
  title: string;
  publishedAt: Date | null;
  status: VideoStatus;
  channelName: string;
  categoryName: string;
};

export type WatchedRow = {
  id: number;
  youtubeVideoId: string;
  title: string;
  watchedAt: Date | null;
  channelName: string;
  categoryName: string;
};

export type IgnoredRow = {
  id: number;
  title: string;
  channelName: string;
  categoryName: string;
  ignoreMethod: "manual" | "auto" | null;
};

function youtubeUrl(youtubeVideoId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
}

function watchingHref(
  id: number,
  view: QueueListView,
  sort?: "newest" | "oldest",
  category?: number,
): string {
  const params = new URLSearchParams({ from: view });
  if (view === "queue" && sort) params.set("sort", sort);
  if (category !== undefined) params.set("category", String(category));
  return `/watching/${id}?${params.toString()}`;
}

function toggleHref(
  id: number,
  view: "queue" | "continue-watching",
  sort?: "newest" | "oldest",
  category?: number,
): string {
  const params = new URLSearchParams({ view });
  if (sort) params.set("sort", sort);
  if (category !== undefined) params.set("category", String(category));
  return `/videos/${id}/toggle?${params.toString()}`;
}

function ignoreHref(
  id: number,
  view: "queue" | "continue-watching",
  sort?: "newest" | "oldest",
  category?: number,
): string {
  const params = new URLSearchParams({ view });
  if (sort) params.set("sort", sort);
  if (category !== undefined) params.set("category", String(category));
  return `/videos/${id}/ignore?${params.toString()}`;
}

function unignoreHref(id: number, category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/videos/${id}/unignore${qs ? `?${qs}` : ""}`;
}

type QueueListProps =
  | {
      view: "queue";
      sort: "newest" | "oldest";
      category?: number;
      rows: QueueRow[];
    }
  | { view: "continue-watching"; category?: number; rows: QueueRow[] }
  | { view: "watched"; category?: number; rows: WatchedRow[] }
  | { view: "ignored"; category?: number; rows: IgnoredRow[] };

export const QueueList: FC<QueueListProps> = (props) => {
  return (
    <div id="queue-list">
      <ul>
        {props.view === "watched"
          ? props.rows.map((row) => (
              <li key={row.id}>
                <a
                  href={watchingHref(
                    row.id,
                    "watched",
                    undefined,
                    props.category,
                  )}
                  class="watch-link"
                  data-youtube-url={youtubeUrl(row.youtubeVideoId)}
                >
                  {row.title}
                </a>{" "}
                — {row.channelName} ({row.categoryName})
                {row.watchedAt
                  ? ` · watched ${row.watchedAt.toLocaleDateString()}`
                  : ""}
              </li>
            ))
          : props.view === "ignored"
            ? props.rows.map((row) => (
                <li key={row.id}>
                  {row.title}
                  {row.ignoreMethod ? ` [${row.ignoreMethod}]` : ""} —{" "}
                  {row.channelName} ({row.categoryName})
                  <button
                    type="button"
                    hx-post={unignoreHref(row.id, props.category)}
                    hx-target="#queue-list"
                    hx-swap="outerHTML"
                    hx-disabled-elt="this"
                  >
                    Un-ignore
                  </button>
                </li>
              ))
            : props.rows.map((row) => {
                const sort = props.view === "queue" ? props.sort : undefined;
                return (
                  <li key={row.id}>
                    <a
                      href={watchingHref(
                        row.id,
                        props.view,
                        sort,
                        props.category,
                      )}
                      class="watch-link"
                      data-youtube-url={youtubeUrl(row.youtubeVideoId)}
                    >
                      {row.title}
                    </a>{" "}
                    — {row.channelName} ({row.categoryName})
                    {row.publishedAt
                      ? ` · published ${row.publishedAt.toLocaleDateString()}`
                      : ""}
                    <button
                      type="button"
                      hx-post={toggleHref(
                        row.id,
                        props.view,
                        sort,
                        props.category,
                      )}
                      hx-target="#queue-list"
                      hx-swap="outerHTML"
                      hx-disabled-elt="this"
                    >
                      {row.status === "watching"
                        ? "Clear to Unwatched"
                        : "Mark Watched"}
                    </button>
                    <button
                      type="button"
                      hx-post={ignoreHref(
                        row.id,
                        props.view,
                        sort,
                        props.category,
                      )}
                      hx-target="#queue-list"
                      hx-swap="outerHTML"
                      hx-disabled-elt="this"
                    >
                      Ignore
                    </button>
                  </li>
                );
              })}
      </ul>
    </div>
  );
};
