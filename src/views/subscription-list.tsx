import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import { EmptyState } from "./empty-state";

type Category = typeof categories.$inferSelect;

export type Subscription = {
  id: number;
  channelName: string;
  categoryId: number;
  unwatchedCount: number;
  showMissedVideosBadge: boolean;
};

const SECONDARY_BUTTON_CLASS =
  "rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised";

export const SubscriptionList: FC<{
  subscriptions: Subscription[];
  categories: Category[];
  systemCategoryId: number;
  error?: string;
  oob?: boolean;
}> = (props) => {
  return (
    <div
      id="subscription-list"
      hx-swap-oob={props.oob ? "true" : undefined}
      class="rounded-lg border border-border bg-surface"
    >
      {props.subscriptions.length === 0 ? (
        <EmptyState message="No subscriptions yet — add a channel above." />
      ) : (
        <ul class="divide-y divide-border">
          {props.subscriptions.map((subscription) => (
            <li
              key={subscription.id}
              class="flex items-center justify-between gap-2 px-4 py-3 hover:bg-surface-raised"
            >
              <span class="flex flex-wrap items-center gap-2">
                {subscription.channelName} ({subscription.unwatchedCount})
                <select
                  name="categoryId"
                  aria-label={`Category for ${subscription.channelName}`}
                  hx-post={`/subscriptions/${subscription.id}/category`}
                  hx-trigger="change"
                  hx-target="#subscription-list"
                  hx-swap="outerHTML"
                  hx-disabled-elt="this"
                  class="rounded border border-border bg-surface px-2 py-0.5 text-xs text-text-muted"
                >
                  <option
                    value=""
                    selected={
                      subscription.categoryId === props.systemCategoryId
                    }
                  >
                    Uncategorized
                  </option>
                  {props.categories.map((category) => (
                    <option
                      key={category.id}
                      value={String(category.id)}
                      selected={subscription.categoryId === category.id}
                    >
                      {category.name}
                    </option>
                  ))}
                </select>
                {subscription.showMissedVideosBadge ? (
                  <>
                    {" "}
                    <span class="text-sm text-danger">
                      ⚠ Possible missed videos
                    </span>
                    <button
                      type="button"
                      hx-post={`/subscriptions/${subscription.id}/dismiss-missed-videos`}
                      hx-target="#subscription-list"
                      hx-swap="outerHTML"
                      class={SECONDARY_BUTTON_CLASS}
                    >
                      Dismiss
                    </button>
                  </>
                ) : null}
              </span>
              <span class="flex items-center gap-2">
                <button
                  type="button"
                  hx-delete={`/subscriptions/${subscription.id}`}
                  hx-confirm={`Unsubscribe from "${subscription.channelName}"?`}
                  hx-target="#subscription-list"
                  hx-swap="outerHTML"
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Unsubscribe
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.error ? (
        <p class="px-4 pt-2 text-sm text-danger">{props.error}</p>
      ) : null}
    </div>
  );
};
