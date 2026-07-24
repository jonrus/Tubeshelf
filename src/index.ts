import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { db } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seed } from "./db/seed";
import { startScheduler } from "./lib/scheduler";
import { categoriesRoute } from "./routes/categories";
import { channelsRoute } from "./routes/channels";

runMigrations();
console.log("Migrations complete.");
seed(db);
console.log("Seed complete.");

const app = new Hono();

app.use("/css/*", serveStatic({ root: "./public" }));
app.route("/", categoriesRoute);
app.route("/", channelsRoute);

startScheduler();

Bun.serve({ port: 3000, fetch: app.fetch });

console.log("Listening on http://localhost:3000");
