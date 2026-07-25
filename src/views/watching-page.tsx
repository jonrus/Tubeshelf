import type { FC } from "hono/jsx";
import type { videos } from "../db/schema";
import { Layout } from "./layout";

type VideoStatus = (typeof videos.$inferSelect)["status"];

const STATUS_LABELS: Record<VideoStatus, string> = {
  unwatched: "Unwatched",
  watching: "Watching",
  watched: "Watched",
  ignored: "Ignored",
};

function thumbnailUrl(youtubeVideoId: string): string {
  return `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
}

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
  <span id="watch-status-badge" hx-swap-oob={props.oob ? "true" : undefined}>
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
};

export const WatchingPage: FC<WatchingPageProps> = (props) => {
  const showAutoTimer = props.status !== "watched";
  const togglePrefix =
    props.status === "watched" ? "Mark Unwatched" : "Mark Watched";

  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <img src={thumbnailUrl(props.youtubeVideoId)} alt={props.title} />
      <p>
        Status: <WatchStatusBadge status={props.status} />
      </p>
      {showAutoTimer ? (
        <div
          hx-trigger="load delay:10s"
          hx-post={`/videos/${props.id}/watching`}
          hx-swap="none"
        />
      ) : null}
      <button
        type="button"
        hx-post={`/videos/${props.id}/watching`}
        hx-swap="none"
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
        <button type="submit">
          {togglePrefix} & Return to {props.returnLabel}
        </button>
      </form>
      <p>
        <a href={props.returnUrl}>Return to {props.returnLabel}</a>
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html:
            'window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });',
        }}
      />
    </Layout>
  );
};
