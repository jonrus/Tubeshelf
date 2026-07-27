import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";
import type { NavCounts } from "../lib/nav-counts";
import { IgnoreRulesList } from "./ignore-rules-list";
import { Layout } from "./layout";

export const IgnoreRulesPage: FC<{
  rules: (typeof ignoreRules.$inferSelect)[];
  navCounts: NavCounts;
}> = (props) => (
  <Layout title="Ignore Rules" navCounts={props.navCounts}>
    <IgnoreRulesList rules={props.rules} />
  </Layout>
);
