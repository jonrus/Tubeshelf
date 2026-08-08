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

const NAV_LINK_CLASS =
  "block rounded px-3 py-2 text-sm font-medium text-text-muted hover:bg-surface-raised hover:text-text data-[active=true]:bg-surface-raised data-[active=true]:text-accent";

const NAV_SUBLINK_CLASS =
  "block rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-raised hover:text-text data-[active=true]:text-accent data-[active=true]:font-semibold";

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
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/icons/icon-32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/icons/icon-16.png"
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/icons/icon-180.png"
        />
        <link rel="manifest" href="/manifest.json" />
        <link rel="stylesheet" href="/css/tailwind.css" />
        <script src="https://unpkg.com/htmx.org@2.0.4" />
      </head>
      <body class="bg-bg text-text lg:flex lg:min-h-screen">
        <button
          type="button"
          id="sidebar-toggle"
          aria-expanded="false"
          aria-controls="sidebar"
          class="lg:hidden fixed top-4 left-4 z-50 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text shadow"
        >
          Menu
        </button>
        <div
          id="sidebar-backdrop"
          data-open="false"
          class="lg:hidden fixed inset-0 z-30 hidden bg-bg/70 data-[open=true]:block"
        />
        <aside
          id="sidebar"
          data-open="false"
          class="fixed inset-y-0 left-0 z-40 w-64 -translate-x-full overflow-y-auto border-r border-border bg-surface transition-transform data-[open=true]:translate-x-0 lg:z-auto lg:w-64 lg:shrink-0 lg:translate-x-0 lg:static"
        >
          <nav class="flex h-full flex-col gap-1 p-4 pt-16 lg:pt-4">
            <a
              href={buildQueueHref(props.currentSort ?? "newest")}
              data-active={props.currentView === "queue"}
              class={NAV_LINK_CLASS}
            >
              Queue ({props.navCounts.queueCount})
            </a>
            <a
              href="/continue-watching"
              data-active={props.currentView === "continue-watching"}
              class={NAV_LINK_CLASS}
            >
              Continue Watching ({props.navCounts.continueWatchingCount})
            </a>
            <a
              href="/watched"
              data-active={props.currentView === "watched"}
              class={NAV_LINK_CLASS}
            >
              Watched ({props.navCounts.watchedCount})
            </a>

            <a
              href="/categories"
              data-active={props.currentView === "categories"}
              class={NAV_LINK_CLASS}
            >
              Manage Categories
            </a>
            <ul class="ml-3 flex flex-col gap-1 border-l border-border pl-3">
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
                    class={NAV_SUBLINK_CLASS}
                  >
                    {cat.name} ({cat.unwatchedCount})
                  </a>
                </li>
              ))}
            </ul>

            <a
              href="/ignored"
              data-active={props.currentView === "ignored"}
              class={NAV_LINK_CLASS}
            >
              Ignored
            </a>
            <ul class="ml-3 flex flex-col gap-1 border-l border-border pl-3">
              <li>
                <a
                  href="/ignore-rules"
                  data-active={props.currentView === "ignore-rules"}
                  class={NAV_SUBLINK_CLASS}
                >
                  Ignore Rules
                </a>
              </li>
            </ul>

            <a
              href="/channels"
              data-active={props.currentView === "channels"}
              class={NAV_LINK_CLASS}
            >
              Channels
            </a>

            <p class="mt-2 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              YouTube
            </p>
            <ul class="ml-3 flex flex-col gap-1 border-l border-border pl-3">
              <li>
                <a
                  href="https://www.youtube.com/feed/subscriptions"
                  target="_blank"
                  rel="noopener noreferrer"
                  class={NAV_SUBLINK_CLASS}
                >
                  Subscriptions
                </a>
              </li>
              <li>
                <a
                  href="https://www.youtube.com/playlist?list=WL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class={NAV_SUBLINK_CLASS}
                >
                  Watch Later
                </a>
              </li>
            </ul>

            <form action="/logout" method="post" class="mt-auto pt-4">
              <button
                type="submit"
                class="w-full rounded px-3 py-2 text-left text-sm font-medium text-text-muted hover:bg-surface-raised hover:text-text"
              >
                Log out
              </button>
            </form>
          </nav>
        </aside>
        <main class="min-w-0 flex-1 p-4 pt-20 lg:pt-6">{props.children}</main>
        <script dangerouslySetInnerHTML={{ __html: WATCH_LINK_CLICK_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_TOGGLE_SCRIPT }} />
      </body>
    </html>
  );
};
