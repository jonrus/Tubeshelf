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
  opts?: { editingId?: number; requireDefaultSort?: boolean },
) {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const defaultSort = body.defaultSort;
  const error =
    validateCategoryName(name) ??
    (opts?.requireDefaultSort &&
    defaultSort !== "newest" &&
    defaultSort !== "oldest"
      ? "Default sort must be newest or oldest."
      : null);
  if (error) {
    return {
      response: c.html(
        <CategoriesList
          categories={listCategoriesWithCounts(userId)}
          editingId={opts?.editingId}
          error={error}
        />,
      ),
    };
  }
  return { name, defaultSort };
}

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed");
}

categoriesRoute.get("/categories", (c) => {
  const userId = c.get("userId");
  return c.html(
    <CategoriesPage
      categories={listCategoriesWithCounts(userId)}
      navCounts={getNavCounts(userId)}
      currentView="categories"
    />,
  );
});

categoriesRoute.post("/categories", async (c) => {
  const userId = c.get("userId");
  const parsed = await parseAndValidateCategoryName(c, userId);
  if ("response" in parsed) return parsed.response;
  const { name } = parsed;

  try {
    db.insert(categories).values({ name }).run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(userId)}
        error="A category with that name already exists."
      />,
    );
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(userId)} />,
  );
});

categoriesRoute.get("/categories/:id/edit", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const category = getCategoryById(id);
  if (!category || category.isSystem) {
    return c.html(
      <CategoriesList categories={listCategoriesWithCounts(userId)} />,
    );
  }
  return c.html(
    <CategoriesList
      categories={listCategoriesWithCounts(userId)}
      editingId={id}
    />,
  );
});

categoriesRoute.post("/categories/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const guard = categoryEditGuard(
    c,
    userId,
    id,
    "Cannot rename the system category.",
  );
  if (guard) return guard;

  const parsed = await parseAndValidateCategoryName(c, userId, {
    editingId: id,
    requireDefaultSort: true,
  });
  if ("response" in parsed) return parsed.response;
  const { name, defaultSort } = parsed;
  if (defaultSort !== "newest" && defaultSort !== "oldest") {
    throw new Error("unreachable: defaultSort validated above");
  }

  try {
    db.update(categories)
      .set({ name, defaultSort })
      .where(eq(categories.id, id))
      .run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return c.html(
      <CategoriesList
        categories={listCategoriesWithCounts(userId)}
        editingId={id}
        error="A category with that name already exists."
      />,
    );
  }

  return c.html(
    <CategoriesList categories={listCategoriesWithCounts(userId)} />,
  );
});

categoriesRoute.delete("/categories/:id", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const guard = categoryEditGuard(
    c,
    userId,
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
    <CategoriesList categories={listCategoriesWithCounts(userId)} />,
  );
});
