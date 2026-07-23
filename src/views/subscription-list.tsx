import type { FC } from "hono/jsx";

export type Subscription = {
  id: number;
  channelName: string;
  categoryName: string;
};

export const SubscriptionList: FC<{
  subscriptions: Subscription[];
  error?: string;
  oob?: boolean;
}> = (props) => {
  return (
    <div id="subscription-list" hx-swap-oob={props.oob ? "true" : undefined}>
      <ul>
        {props.subscriptions.map((subscription) => (
          <li key={subscription.id}>
            {subscription.channelName} ({subscription.categoryName})
            <button
              type="button"
              hx-delete={`/subscriptions/${subscription.id}`}
              hx-target="#subscription-list"
              hx-swap="outerHTML"
            >
              Unsubscribe
            </button>
          </li>
        ))}
      </ul>
      {props.error ? <p class="text-red-600">{props.error}</p> : null}
    </div>
  );
};
