import type { FC } from "hono/jsx";
import type { CategoryWithCount } from "../lib/categories";
import type { NavCounts } from "../lib/nav-counts";
import { CategoriesList } from "./categories-list";
import { Layout } from "./layout";

export const CategoriesPage: FC<{
  categories: CategoryWithCount[];
  navCounts: NavCounts;
  currentView: "categories";
}> = (props) => {
  return (
    <Layout
      title="Categories"
      navCounts={props.navCounts}
      categories={props.categories}
      currentView={props.currentView}
    >
      <CategoriesList categories={props.categories} />
    </Layout>
  );
};
