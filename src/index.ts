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

runMigrations();
console.log("Migrations complete.");
seed(db);
console.log("Seed complete.");
await applyRecoveryPasswordFromEnv();

const app = new Hono();

app.use("/css/*", serveStatic({ root: "./public" }));
app.route("/", authRoute);
app.route("/", categoriesRoute);
app.route("/", channelsRoute);
app.route("/", healthRoute);
app.route("/", queueRoute);
app.route("/", ignoreRulesRoute);

startScheduler();

Bun.serve({ port: 3000, fetch: app.fetch });

console.log("Listening on http://localhost:3000");
