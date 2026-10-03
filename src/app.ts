import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { logger } from "./lib/logger";
import { authRoute } from "./routes/auth";
import { categoriesRoute } from "./routes/categories";
import { channelsRoute } from "./routes/channels";
import { healthRoute } from "./routes/health";
import { ignoreRulesRoute } from "./routes/ignore-rules";
import { queueRoute } from "./routes/queue";

export function buildApp(): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    logger.error("Unhandled request error", {
      err,
      method: c.req.method,
      path: c.req.path,
    });
    return c.text("Internal Server Error", 500);
  });

  app.use("/css/*", serveStatic({ root: "./public" }));
  app.use("/js/*", serveStatic({ root: "./public" }));
  app.use("/icons/*", serveStatic({ root: "./public" }));
  app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
  app.route("/", healthRoute);
  app.route("/", authRoute);
  app.route("/", categoriesRoute);
  app.route("/", channelsRoute);
  app.route("/", queueRoute);
  app.route("/", ignoreRulesRoute);

  return app;
}
