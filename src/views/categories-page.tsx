import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import type { NavCounts } from "../lib/nav-counts";
import { CategoriesList } from "./categories-list";
import { Layout } from "./layout";

type Category = typeof categories.$inferSelect;

export const CategoriesPage: FC<{
  categories: Category[];
  navCounts: NavCounts;
}> = (props) => {
  return (
    <Layout title="Categories" navCounts={props.navCounts}>
      <CategoriesList categories={props.categories} />
    </Layout>
  );
};
