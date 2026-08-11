import type { FC } from "hono/jsx";
import { EmptyState } from "./empty-state";

export type Subscription = {
  id: number;
  channelName: string;
  categoryName: string;
  unwatchedCount: number;
  showMissedVideosBadge: boolean;
};

const SECONDARY_BUTTON_CLASS =
  "rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised";

export const SubscriptionList: FC<{
  subscriptions: Subscription[];
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
                <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                  {subscription.categoryName}
                </span>
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
