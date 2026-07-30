import type { Child, FC } from "hono/jsx";
import type { CategoryWithCount } from "../lib/categories";
import type { NavCounts } from "../lib/nav-counts";
import {
  buildContinueWatchingHref,
  buildIgnoredHref,
  buildQueueHref,
  buildWatchedHref,
} from "../lib/queue-urls";

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

const SIDEBAR_TOGGLE_SCRIPT = `
function toggleSidebar() {
  const aside = document.getElementById("sidebar");
  const btn = document.getElementById("sidebar-toggle");
  const backdrop = document.getElementById("sidebar-backdrop");
  const isOpen = aside.dataset.open === "true";
  aside.dataset.open = String(!isOpen);
  backdrop.dataset.open = String(!isOpen);
  btn.setAttribute("aria-expanded", String(!isOpen));
}
document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
document.getElementById("sidebar-backdrop").addEventListener("click", toggleSidebar);
`;

export type SidebarView =
  | "queue"
  | "continue-watching"
  | "watched"
  | "ignored"
  | "categories"
  | "ignore-rules"
  | "channels";

const FILTERABLE_VIEWS = [
  "queue",
  "continue-watching",
  "watched",
  "ignored",
] as const;
type FilterableView = (typeof FILTERABLE_VIEWS)[number];

function isFilterableView(
  view: SidebarView | undefined,
): view is FilterableView {
  return (
    view !== undefined && (FILTERABLE_VIEWS as readonly string[]).includes(view)
  );
}

function sidebarCategoryHref(
  currentView: SidebarView | undefined,
  currentSort: "newest" | "oldest" | undefined,
  categoryId?: number,
): string {
  const view = isFilterableView(currentView) ? currentView : "queue";
  const sort = view === "queue" ? currentSort : undefined;
  switch (view) {
    case "queue":
      return buildQueueHref(sort ?? "newest", categoryId);
    case "continue-watching":
      return buildContinueWatchingHref(categoryId);
    case "watched":
      return buildWatchedHref(categoryId);
    case "ignored":
      return buildIgnoredHref(categoryId);
  }
}

export const Layout: FC<{
  title: string;
  navCounts: NavCounts;
  categories: CategoryWithCount[];
  currentView?: SidebarView;
  currentCategory?: number;
  currentSort?: "newest" | "oldest";
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
      <body class="bg-bg text-text">
        <button
          type="button"
          id="sidebar-toggle"
          aria-expanded="false"
          aria-controls="sidebar"
          class="lg:hidden"
        >
          Menu
        </button>
        <div
          id="sidebar-backdrop"
          data-open="false"
          class="lg:hidden fixed inset-0 hidden data-[open=true]:block"
        />
        <aside
          id="sidebar"
          data-open="false"
          class="fixed inset-y-0 left-0 -translate-x-full transition-transform data-[open=true]:translate-x-0 lg:translate-x-0 lg:static"
        >
          <nav>
            <a
              href={buildQueueHref(props.currentSort ?? "newest")}
              data-active={props.currentView === "queue"}
            >
              Queue ({props.navCounts.queueCount})
            </a>
            <a
              href="/continue-watching"
              data-active={props.currentView === "continue-watching"}
            >
              Continue Watching ({props.navCounts.continueWatchingCount})
            </a>
            <a href="/watched" data-active={props.currentView === "watched"}>
              Watched ({props.navCounts.watchedCount})
            </a>

            <a
              href="/categories"
              data-active={props.currentView === "categories"}
            >
              Categories
            </a>
            <ul>
              {props.categories.map((cat) => (
                <li key={cat.id}>
                  <a
                    href={sidebarCategoryHref(
                      props.currentView,
                      props.currentSort,
                      cat.id,
                    )}
                    data-active={
                      isFilterableView(props.currentView) &&
                      props.currentCategory === cat.id
                    }
                  >
                    {cat.name} ({cat.unwatchedCount})
                  </a>
                </li>
              ))}
            </ul>

            <a href="/ignored" data-active={props.currentView === "ignored"}>
              Ignored
            </a>
            <ul>
              <li>
                <a
                  href="/ignore-rules"
                  data-active={props.currentView === "ignore-rules"}
                >
                  Ignore Rules
                </a>
              </li>
            </ul>

            <a href="/channels" data-active={props.currentView === "channels"}>
              Channels
            </a>
          </nav>
        </aside>
        {props.children}
        <script dangerouslySetInnerHTML={{ __html: WATCH_LINK_CLICK_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_TOGGLE_SCRIPT }} />
      </body>
    </html>
  );
};
