import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { IGNORE_RULE_KEYWORD_MAX_LENGTH, ignoreRules } from "../db/schema";
import { csrfCheck, requireAuth } from "../lib/auth";
import { listCategoriesWithCounts } from "../lib/categories";
import { getCurrentUser } from "../lib/current-user";
import { listIgnoreRules, reconcileIgnoreRules } from "../lib/ignore-rules";
import { getNavCounts } from "../lib/nav-counts";
import { IgnoreRulesList } from "../views/ignore-rules-list";
import { IgnoreRulesPage } from "../views/ignore-rules-page";

export const ignoreRulesRoute = new Hono();

ignoreRulesRoute.use("*", csrfCheck, requireAuth);

function parseKeyword(body: { keyword?: unknown }): string {
  return typeof body.keyword === "string" ? body.keyword.trim() : "";
}

function keywordError(editingId: number | undefined, message: string) {
  return (
    <IgnoreRulesList
      rules={listIgnoreRules()}
      editingId={editingId}
      error={message}
    />
  );
}

ignoreRulesRoute.get("/ignore-rules", (c) => {
  const user = getCurrentUser();
  return c.html(
    <IgnoreRulesPage
      rules={listIgnoreRules()}
      navCounts={getNavCounts(user.id)}
      categories={listCategoriesWithCounts(user.id)}
      currentView="ignore-rules"
    />,
  );
});

ignoreRulesRoute.post("/ignore-rules", async (c) => {
  const body = await c.req.parseBody();
  const keyword = parseKeyword(body);
  if (keyword.length > IGNORE_RULE_KEYWORD_MAX_LENGTH) {
    return c.html(
      keywordError(
        undefined,
        `Keyword must be ${IGNORE_RULE_KEYWORD_MAX_LENGTH} characters or fewer.`,
      ),
    );
  }
  if (!keyword) {
    return c.html(keywordError(undefined, "Keyword is required."));
  }
  db.insert(ignoreRules).values({ keyword }).run();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});

ignoreRulesRoute.get("/ignore-rules/:id/edit", (c) => {
  const id = Number(c.req.param("id"));
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} editingId={id} />);
});

ignoreRulesRoute.post("/ignore-rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const keyword = parseKeyword(body);
  if (keyword.length > IGNORE_RULE_KEYWORD_MAX_LENGTH) {
    return c.html(
      keywordError(
        id,
        `Keyword must be ${IGNORE_RULE_KEYWORD_MAX_LENGTH} characters or fewer.`,
      ),
    );
  }
  if (!keyword) {
    return c.html(keywordError(id, "Keyword is required."));
  }
  const updated = db
    .update(ignoreRules)
    .set({ keyword })
    .where(eq(ignoreRules.id, id))
    .returning()
    .get();
  if (!updated) return c.notFound();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});

ignoreRulesRoute.delete("/ignore-rules/:id", (c) => {
  const id = Number(c.req.param("id"));
  const deleted = db
    .delete(ignoreRules)
    .where(eq(ignoreRules.id, id))
    .returning()
    .get();
  if (!deleted) return c.notFound();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});
