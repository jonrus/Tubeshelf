import type { FC } from "hono/jsx";
import type { videos } from "../db/schema";
import type { CategoryWithCount } from "../lib/categories";
import type { NavCounts } from "../lib/nav-counts";
import { youtubeThumbnailUrl } from "../lib/youtube";
import { Layout, type SidebarView } from "./layout";

type VideoStatus = (typeof videos.$inferSelect)["status"];

const STATUS_LABELS: Record<VideoStatus, string> = {
  unwatched: "Unwatched",
  watching: "Watching",
  watched: "Watched",
  ignored: "Ignored",
};

function watchedToggleAction(
  id: number,
  from: string | undefined,
  sort: string | undefined,
  category: string | undefined,
): string {
  const params = new URLSearchParams();
  if (from !== undefined) params.set("from", from);
  if (sort !== undefined) params.set("sort", sort);
  if (category !== undefined) params.set("category", category);
  const qs = params.toString();
  return `/videos/${id}/watched-toggle${qs ? `?${qs}` : ""}`;
}

// Reused as-is for the full-page render (no oob attribute) and for the
// POST /videos/:id/watching response's out-of-band badge update (oob=true) --
// same pattern as SubscriptionList's `oob` prop.
export const WatchStatusBadge: FC<{ status: VideoStatus; oob?: boolean }> = (
  props,
) => (
  <span
    id="watch-status-badge"
    hx-swap-oob={props.oob ? "true" : undefined}
    class={`inline-block rounded-full px-2 py-0.5 text-sm ${
      props.status === "watching"
        ? "bg-accent text-bg"
        : "bg-surface-raised text-text-muted"
    }`}
  >
    {STATUS_LABELS[props.status]}
  </span>
);

export type WatchingPageProps = {
  id: number;
  youtubeVideoId: string;
  title: string;
  status: VideoStatus;
  from: string | undefined;
  sort: string | undefined;
  category: string | undefined;
  returnUrl: string;
  returnLabel: string;
  navCounts: NavCounts;
  categories: CategoryWithCount[];
  currentView?: SidebarView;
};

export const WatchingPage: FC<WatchingPageProps> = (props) => {
  const showAutoTimer = props.status !== "watched";
  const togglePrefix =
    props.status === "watched" ? "Mark Unwatched" : "Mark Watched";

  return (
    <Layout
      title={props.title}
      navCounts={props.navCounts}
      categories={props.categories}
      currentView={props.currentView}
    >
      <h1 class="text-xl font-semibold text-text">{props.title}</h1>
      <div class="mt-3 aspect-video w-full max-w-2xl overflow-hidden rounded-lg bg-surface-raised">
        <img
          src={youtubeThumbnailUrl(props.youtubeVideoId)}
          alt={props.title}
          onerror="this.style.visibility='hidden'"
          class="h-full w-full object-cover"
        />
      </div>
      <p class="mt-3">
        Status: <WatchStatusBadge status={props.status} />
      </p>
      {showAutoTimer ? (
        <div
          hx-trigger="load delay:10s"
          hx-post={`/videos/${props.id}/watching`}
          hx-swap="none"
        />
      ) : null}
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          hx-post={`/videos/${props.id}/watching`}
          hx-swap="none"
          class="rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent"
        >
          Mark Watching
        </button>
        <form
          action={watchedToggleAction(
            props.id,
            props.from,
            props.sort,
            props.category,
          )}
          method="post"
          onsubmit="this.querySelector('button').disabled = true"
        >
          <button
            type="submit"
            class="rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent"
          >
            {togglePrefix} & Return to {props.returnLabel}
          </button>
        </form>
        <a
          href={props.returnUrl}
          class="rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised"
        >
          Return to {props.returnLabel}
        </a>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html:
            'window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });',
        }}
      />
    </Layout>
  );
};
