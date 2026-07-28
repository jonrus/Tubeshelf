import type { Child, FC } from "hono/jsx";
import type { NavCounts } from "../lib/nav-counts";

const WATCH_LINK_CLICK_SCRIPT = `
function handleWatchLinkClick(e) {
  const link = e.target.closest(".watch-link");
  if (!link) return;
  if (e.type === "auxclick" && e.button !== 1) return;
  if (e.type === "click" && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
  window.open(link.dataset.youtubeUrl, "_blank");
}
document.addEventListener("click", handleWatchLinkClick);
document.addEventListener("auxclick", handleWatchLinkClick);
`;

export const Layout: FC<{
  title: string;
  navCounts: NavCounts;
  children?: Child;
}> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/css/tailwind.css" />
        <script src="https://unpkg.com/htmx.org@2.0.4" />
      </head>
      <body class="bg-gray-50 text-gray-900">
        <nav>
          <a href="/categories">Categories</a> | <a href="/channels">Channels</a> |{" "}
          <a href="/queue">Queue ({props.navCounts.queueCount})</a> |{" "}
          <a href="/continue-watching">
            Continue Watching ({props.navCounts.continueWatchingCount})
          </a>{" "}
          | <a href="/watched">Watched ({props.navCounts.watchedCount})</a> |{" "}
          <a href="/ignored">Ignored</a> |{" "}
          <a href="/ignore-rules">Ignore Rules</a>
        </nav>
        {props.children}
        <script dangerouslySetInnerHTML={{ __html: WATCH_LINK_CLICK_SCRIPT }} />
      </body>
    </html>
  );
};
