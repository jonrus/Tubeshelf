import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { CATEGORY_NAME_MAX_LENGTH, categories } from "../db/schema";
import { csrfCheck, requireAuth } from "../lib/auth";
import { listCategoriesWithCounts } from "../lib/categories";
import { getCurrentUser } from "../lib/current-user";
import { getNavCounts } from "../lib/nav-counts";
import { CategoriesList } from "../views/categories-list";
import { CategoriesPage } from "../views/categories-page";

export const categoriesRoute = new Hono();

categoriesRoute.use("*", csrfCheck, requireAuth);

categoriesRoute.get("/categories", (c) => {
  const user = getCurrentUser();
  return c.html(
    <CategoriesPage
      categories={listCategoriesWithCounts(user.id)}
      navCounts={getNavCounts(user.id)}
      currentView="categories"
    />,
  );
});

categoriesRoute.post("/categories", async (c) => {
  const user = getCurrentUser();
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        error={`Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`}
      />,
    );
  }
  if (!name) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        error="Category name is required."
      />,
    );
  }
  if (name.toLowerCase() === "uncategorized") {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
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
          categories={listCategoriesWithCounts(user.id)}
          error="A category with that name already exists."
        />,
      );
    }
    throw err;
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});

categoriesRoute.get("/categories/:id/edit", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  if (!category || category.isSystem) {
    return c.html(
      <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
    );
  }
  return c.html(
    <CategoriesList
      categories={listCategoriesWithCounts(user.id)}
      editingId={id}
    />,
  );
});

categoriesRoute.post("/categories/:id", async (c) => {
  const user = getCurrentUser();
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
        categories={listCategoriesWithCounts(user.id)}
        error="Cannot rename the system category."
      />,
    );
  }

  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        editingId={id}
        error={`Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`}
      />,
    );
  }
  if (!name) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        editingId={id}
        error="Category name is required."
      />,
    );
  }
  if (name.toLowerCase() === "uncategorized") {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
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
          categories={listCategoriesWithCounts(user.id)}
          editingId={id}
          error="A category with that name already exists."
        />,
      );
    }
    throw err;
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});
