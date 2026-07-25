import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";
import { IgnoreRulesList } from "./ignore-rules-list";
import { Layout } from "./layout";

export const IgnoreRulesPage: FC<{
  rules: (typeof ignoreRules.$inferSelect)[];
}> = (props) => (
  <Layout title="Ignore Rules">
    <IgnoreRulesList rules={props.rules} />
  </Layout>
);
