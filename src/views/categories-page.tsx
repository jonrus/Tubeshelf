import type { FC } from "hono/jsx";
import type { NavCounts } from "../lib/nav-counts";
import { CategoriesList, type Category } from "./categories-list";
import { Layout } from "./layout";

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
