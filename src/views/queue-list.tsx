import type { FC } from "hono/jsx";
import type { videos } from "../db/schema";
import { formatRelativeTime } from "../lib/relative-time";
import { youtubeThumbnailUrl, youtubeWatchUrl } from "../lib/youtube";
import { EmptyState } from "./empty-state";

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
  youtubeVideoId: string;
  title: string;
  channelName: string;
  categoryName: string;
  ignoreMethod: "manual" | "auto" | null;
};

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

const EMPTY_MESSAGES: Record<QueueListProps["view"], string> = {
  queue: "Nothing in your queue — your subscriptions are all caught up.",
  "continue-watching":
    "Nothing in progress — start watching something from your queue.",
  watched: "Nothing watched yet.",
  ignored: "Nothing ignored.",
};

const THUMBNAIL_WRAPPER_CLASS =
  "aspect-video w-full overflow-hidden bg-surface-raised";
const THUMBNAIL_IMG_CLASS = "h-full w-full object-cover";
const CARD_CLASS =
  "flex flex-col rounded-lg border border-border bg-surface overflow-hidden";

export const QueueList: FC<QueueListProps> = (props) => {
  const isEmpty = props.rows.length === 0;
  return (
    <div
      id="queue-list"
      class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]"
    >
      {isEmpty ? (
        <EmptyState message={EMPTY_MESSAGES[props.view]} />
      ) : props.view === "watched" ? (
        props.rows.map((row) => (
          <div key={row.id} class={CARD_CLASS}>
            <a
              href={watchingHref(row.id, "watched", undefined, props.category)}
              class="watch-link block"
              data-youtube-url={youtubeWatchUrl(row.youtubeVideoId)}
            >
              <div class={THUMBNAIL_WRAPPER_CLASS}>
                <img
                  src={youtubeThumbnailUrl(row.youtubeVideoId)}
                  alt={row.title}
                  loading="lazy"
                  onerror="this.style.visibility='hidden'"
                  class={THUMBNAIL_IMG_CLASS}
                />
              </div>
              <div class="p-3">
                <p class="font-medium text-text">{row.title}</p>
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                  <span class="text-text">{row.channelName}</span>
                  <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                    {row.categoryName}
                  </span>
                  {row.watchedAt ? (
                    <span class="text-text-muted">
                      watched {formatRelativeTime(row.watchedAt)}
                    </span>
                  ) : null}
                </div>
              </div>
            </a>
          </div>
        ))
      ) : props.view === "ignored" ? (
        props.rows.map((row) => (
          <div key={row.id} class={CARD_CLASS}>
            <div class={THUMBNAIL_WRAPPER_CLASS}>
              <img
                src={youtubeThumbnailUrl(row.youtubeVideoId)}
                alt={row.title}
                loading="lazy"
                onerror="this.style.visibility='hidden'"
                class={THUMBNAIL_IMG_CLASS}
              />
            </div>
            <div class="p-3">
              <p class="font-medium text-text">{row.title}</p>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                <span class="text-text">{row.channelName}</span>
                <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                  {row.categoryName}
                </span>
                {row.ignoreMethod ? (
                  <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                    {row.ignoreMethod}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                hx-post={unignoreHref(row.id, props.category)}
                hx-target="#queue-list"
                hx-swap="outerHTML"
                hx-disabled-elt="this"
                class="mt-2 rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised"
              >
                Un-ignore
              </button>
            </div>
          </div>
        ))
      ) : (
        props.rows.map((row) => {
          const sort = props.view === "queue" ? props.sort : undefined;
          return (
            <div key={row.id} class={CARD_CLASS}>
              <a
                href={watchingHref(row.id, props.view, sort, props.category)}
                class="watch-link block"
                data-youtube-url={youtubeWatchUrl(row.youtubeVideoId)}
              >
                <div class={THUMBNAIL_WRAPPER_CLASS}>
                  <img
                    src={youtubeThumbnailUrl(row.youtubeVideoId)}
                    alt={row.title}
                    loading="lazy"
                    onerror="this.style.visibility='hidden'"
                    class={THUMBNAIL_IMG_CLASS}
                  />
                </div>
                <div class="p-3">
                  <p class="font-medium text-text">{row.title}</p>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                    <span class="text-text">{row.channelName}</span>
                    <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                      {row.categoryName}
                    </span>
                    {row.publishedAt ? (
                      <span class="text-text-muted">
                        {formatRelativeTime(row.publishedAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </a>
              {row.status === "watching" ? (
                <span class="mx-3 text-sm text-accent">▶ Watching</span>
              ) : null}
              <div class="mt-auto flex gap-2 p-3 pt-2">
                <button
                  type="button"
                  hx-post={toggleHref(row.id, props.view, sort, props.category)}
                  hx-target="#queue-list"
                  hx-swap="outerHTML"
                  hx-disabled-elt="this"
                  class="rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent"
                >
                  {row.status === "watching"
                    ? "Mark Unwatched"
                    : "Mark Watched"}
                </button>
                <button
                  type="button"
                  hx-post={ignoreHref(row.id, props.view, sort, props.category)}
                  hx-target="#queue-list"
                  hx-swap="outerHTML"
                  hx-disabled-elt="this"
                  class="rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised"
                >
                  Ignore
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
