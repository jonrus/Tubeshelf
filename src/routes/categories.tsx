import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  CATEGORY_NAME_MAX_LENGTH,
  categories,
  subscriptions,
} from "../db/schema";
import { csrfCheck, requireAuth } from "../lib/auth";
import { getSystemCategory, listCategoriesWithCounts } from "../lib/categories";
import { getCurrentUser } from "../lib/current-user";
import { getNavCounts } from "../lib/nav-counts";
import { CategoriesList } from "../views/categories-list";
import { CategoriesPage } from "../views/categories-page";

export const categoriesRoute = new Hono();

categoriesRoute.use("*", csrfCheck, requireAuth);

function getCategoryById(id: number) {
  return db.select().from(categories).where(eq(categories.id, id)).get();
}

function categoryEditGuard(
  c: Context,
  userId: number,
  id: number,
  systemErrorMessage: string,
) {
  const category = getCategoryById(id);
  if (!category) return c.notFound();
  if (category.isSystem) {
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(userId)}
        error={systemErrorMessage}
      />,
    );
  }
  return null;
}

function validateCategoryName(name: string): string | null {
  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    return `Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (!name) {
    return "Category name is required.";
  }
  if (name.toLowerCase() === "uncategorized") {
    return '"Uncategorized" is a reserved name.';
  }
  return null;
}

async function parseAndValidateCategoryName(
  c: Context,
  userId: number,
  opts?: { editingId?: number },
) {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const nameError = validateCategoryName(name);
  if (nameError) {
    return {
      response: c.html(
        <CategoriesList
          categories={listCategoriesWithCounts(userId)}
          editingId={opts?.editingId}
          error={nameError}
        />,
      ),
    };
  }
  return { name };
}

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed");
}

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
  const parsed = await parseAndValidateCategoryName(c, user.id);
  if ("response" in parsed) return parsed.response;
  const { name } = parsed;

  try {
    db.insert(categories).values({ name }).run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        error="A category with that name already exists."
      />,
    );
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});

categoriesRoute.get("/categories/:id/edit", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));
  const category = getCategoryById(id);
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
  const guard = categoryEditGuard(
    c,
    user.id,
    id,
    "Cannot rename the system category.",
  );
  if (guard) return guard;

  const parsed = await parseAndValidateCategoryName(c, user.id, {
    editingId: id,
  });
  if ("response" in parsed) return parsed.response;
  const { name } = parsed;

  try {
    db.update(categories).set({ name }).where(eq(categories.id, id)).run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(user.id)}
        editingId={id}
        error="A category with that name already exists."
      />,
    );
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});

categoriesRoute.delete("/categories/:id", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));
  const guard = categoryEditGuard(
    c,
    user.id,
    id,
    "Cannot delete the system category.",
  );
  if (guard) return guard;

  const systemCategory = getSystemCategory();

  db.transaction((tx) => {
    tx.update(subscriptions)
      .set({ categoryId: systemCategory.id })
      .where(eq(subscriptions.categoryId, id))
      .run();
    tx.delete(categories).where(eq(categories.id, id)).run();
  });

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(user.id)} />,
  );
});
