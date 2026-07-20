import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";
import { CategoriesList } from "./categories-list";
import { Layout } from "./layout";

type Category = typeof categories.$inferSelect;

export const CategoriesPage: FC<{ categories: Category[] }> = (props) => {
  return (
    <Layout title="Categories">
      <CategoriesList categories={props.categories} />
    </Layout>
  );
};
