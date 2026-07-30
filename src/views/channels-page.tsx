import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import type { CategoryWithCount } from "../lib/categories";
import type { NavCounts } from "../lib/nav-counts";
import { Layout } from "./layout";
import { BlankSubscribeForm } from "./subscribe-confirm";
import { type Subscription, SubscriptionList } from "./subscription-list";

type Category = typeof categories.$inferSelect;

export const ChannelsPage: FC<{
  subscribeCategories: Category[];
  categories: CategoryWithCount[];
  subscriptions: Subscription[];
  navCounts: NavCounts;
  currentView: "channels";
}> = (props) => {
  return (
    <Layout
      title="Channels"
      navCounts={props.navCounts}
      categories={props.categories}
      currentView={props.currentView}
    >
      <BlankSubscribeForm categories={props.subscribeCategories} />
      <SubscriptionList subscriptions={props.subscriptions} />
    </Layout>
  );
};
