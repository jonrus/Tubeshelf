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

export const CategoryFilterLinks: FC<{
  categories: { id: number; name: string }[];
  buildHref: (categoryId?: number) => string;
  current?: number;
}> = (props) => (
  <p>
    <a href={props.buildHref()}>All</a>
    {props.categories.map((cat) => (
      <>
        {" "}
        · <a href={props.buildHref(cat.id)}>{cat.name}</a>
      </>
    ))}
  </p>
);

type QueueListProps =
  | {
      view: "queue";
      sort: "newest" | "oldest";
      category?: number;
      rows: QueueRow[];
    }
  | { view: "continue-watching"; category?: number; rows: QueueRow[] }
  | { view: "watched"; category?: number; rows: WatchedRow[] };

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
                </li>
              );
            })}
      </ul>
    </div>
  );
};
