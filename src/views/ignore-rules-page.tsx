import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";
import type { CategoryWithCount } from "../lib/categories";
import type { NavCounts } from "../lib/nav-counts";
import { IgnoreRulesList } from "./ignore-rules-list";
import { Layout } from "./layout";

export const IgnoreRulesPage: FC<{
  rules: (typeof ignoreRules.$inferSelect)[];
  navCounts: NavCounts;
  categories: CategoryWithCount[];
  currentView: "ignore-rules";
}> = (props) => (
  <Layout
    title="Ignore Rules"
    navCounts={props.navCounts}
    categories={props.categories}
    currentView={props.currentView}
  >
    <IgnoreRulesList rules={props.rules} />
  </Layout>
);
