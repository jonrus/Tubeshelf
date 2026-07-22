import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import { Layout } from "./layout";
import { type Subscription, SubscriptionList } from "./subscription-list";

type Category = typeof categories.$inferSelect;

export const ChannelsPage: FC<{
  categories: Category[];
  subscriptions: Subscription[];
}> = (props) => {
  return (
    <Layout title="Channels">
      <form
        hx-post="/subscriptions"
        hx-target="#subscription-list"
        hx-swap="outerHTML"
      >
        <input
          type="text"
          name="channelInput"
          placeholder="Channel ID or URL"
        />
        <select name="categoryId">
          <option value="">Uncategorized</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button type="submit">Subscribe</button>
      </form>
      <SubscriptionList subscriptions={props.subscriptions} />
    </Layout>
  );
};
