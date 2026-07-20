import { asc, desc } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { categories } from "../db/schema";
import { CategoriesList } from "../views/categories-list";
import { CategoriesPage } from "../views/categories-page";

function listCategories() {
  return db.select().from(categories).orderBy(desc(categories.isSystem), asc(categories.name)).all();
}

export const categoriesRoute = new Hono();

categoriesRoute.get("/", (c) => {
  return c.html(<CategoriesPage categories={listCategories()} />);
});

categoriesRoute.post("/categories", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return c.html(<CategoriesList categories={listCategories()} error="Category name is required." />);
  }
  if (name.toLowerCase() === "uncategorized") {
    return c.html(<CategoriesList categories={listCategories()} error='"Uncategorized" is a reserved name.' />);
  }

  try {
    db.insert(categories).values({ name }).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      return c.html(
        <CategoriesList categories={listCategories()} error="A category with that name already exists." />,
      );
    }
    throw err;
  }

  return c.html(<CategoriesList categories={listCategories()} />);
});
