import { asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { CATEGORY_NAME_MAX_LENGTH, categories } from "../db/schema";
import { CategoriesList } from "../views/categories-list";
import { CategoriesPage } from "../views/categories-page";

function listCategories() {
  return db
    .select()
    .from(categories)
    .orderBy(desc(categories.isSystem), asc(categories.name))
    .all();
}

export const categoriesRoute = new Hono();

categoriesRoute.get("/", (c) => {
  return c.html(<CategoriesPage categories={listCategories()} />);
});

categoriesRoute.post("/categories", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        error={`Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`}
      />,
    );
  }
  if (!name) {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        error="Category name is required."
      />,
    );
  }
  if (name.toLowerCase() === "uncategorized") {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        error='"Uncategorized" is a reserved name.'
      />,
    );
  }

  try {
    db.insert(categories).values({ name }).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      return c.html(
        <CategoriesList
          categories={listCategories()}
          error="A category with that name already exists."
        />,
      );
    }
    throw err;
  }

  return c.html(<CategoriesList categories={listCategories()} />);
});

categoriesRoute.get("/categories/:id/edit", (c) => {
  const id = Number(c.req.param("id"));
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  if (!category || category.isSystem) {
    return c.html(<CategoriesList categories={listCategories()} />);
  }
  return c.html(
    <CategoriesList categories={listCategories()} editingId={id} />,
  );
});

categoriesRoute.post("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  if (!category) return c.notFound();

  if (category.isSystem) {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        error="Cannot rename the system category."
      />,
    );
  }

  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        editingId={id}
        error={`Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`}
      />,
    );
  }
  if (!name) {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        editingId={id}
        error="Category name is required."
      />,
    );
  }
  if (name.toLowerCase() === "uncategorized") {
    return c.html(
      <CategoriesList
        categories={listCategories()}
        editingId={id}
        error='"Uncategorized" is a reserved name.'
      />,
    );
  }

  try {
    db.update(categories).set({ name }).where(eq(categories.id, id)).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      return c.html(
        <CategoriesList
          categories={listCategories()}
          editingId={id}
          error="A category with that name already exists."
        />,
      );
    }
    throw err;
  }

  return c.html(<CategoriesList categories={listCategories()} />);
});
