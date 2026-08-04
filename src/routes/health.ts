import { Hono } from "hono";
import { sqlite } from "../db/client";

export const healthRoute = new Hono();

healthRoute.get("/healthz", (c) => {
  try {
    sqlite.query("SELECT 1").get();
    return c.text("ok", 200);
  } catch {
    return c.text("unhealthy", 503);
  }
});
