import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { ignoreRules } from "../db/schema";
import { listIgnoreRules, reconcileIgnoreRules } from "../lib/ignore-rules";
import { IgnoreRulesList } from "../views/ignore-rules-list";
import { IgnoreRulesPage } from "../views/ignore-rules-page";

export const ignoreRulesRoute = new Hono();

ignoreRulesRoute.get("/ignore-rules", (c) => {
  return c.html(<IgnoreRulesPage rules={listIgnoreRules()} />);
});

ignoreRulesRoute.post("/ignore-rules", async (c) => {
  const body = await c.req.parseBody();
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    return c.html(
      <IgnoreRulesList
        rules={listIgnoreRules()}
        error="Keyword is required."
      />,
    );
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
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    return c.html(
      <IgnoreRulesList
        rules={listIgnoreRules()}
        editingId={id}
        error="Keyword is required."
      />,
    );
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
