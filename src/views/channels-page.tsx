import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import type { NavCounts } from "../lib/nav-counts";
import { Layout } from "./layout";
import { BlankSubscribeForm } from "./subscribe-confirm";
import { type Subscription, SubscriptionList } from "./subscription-list";

type Category = typeof categories.$inferSelect;

export const ChannelsPage: FC<{
  categories: Category[];
  subscriptions: Subscription[];
  navCounts: NavCounts;
}> = (props) => {
  return (
    <Layout title="Channels" navCounts={props.navCounts}>
      <BlankSubscribeForm categories={props.categories} />
      <SubscriptionList subscriptions={props.subscriptions} />
    </Layout>
  );
};
