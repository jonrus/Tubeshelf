import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { db } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seed } from "./db/seed";
import { applyRecoveryPasswordFromEnv } from "./lib/auth";
import { startScheduler } from "./lib/scheduler";
import { authRoute } from "./routes/auth";
import { categoriesRoute } from "./routes/categories";
import { channelsRoute } from "./routes/channels";
import { healthRoute } from "./routes/health";
import { ignoreRulesRoute } from "./routes/ignore-rules";
import { queueRoute } from "./routes/queue";

try {
  runMigrations();
} catch (err) {
  console.error("Database migration failed:", err);
  console.error(
    "The database may be partially migrated: each migration file runs in its own " +
      "transaction, so an earlier file's changes are not automatically undone by a " +
      "later file's failure. Restore your previous container image and/or your most " +
      "recent database backup, then retry.",
  );
  process.exit(1);
}
console.log("Migrations complete.");
seed(db);
console.log("Seed complete.");
await applyRecoveryPasswordFromEnv();

const app = new Hono();

app.use("/css/*", serveStatic({ root: "./public" }));
app.use("/icons/*", serveStatic({ root: "./public" }));
app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/", categoriesRoute);
app.route("/", channelsRoute);
app.route("/", queueRoute);
app.route("/", ignoreRulesRoute);

startScheduler();

Bun.serve({ port: 3000, fetch: app.fetch });

console.log("Listening on http://localhost:3000");
