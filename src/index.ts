import { buildApp } from "./app";
import { db, sqlite } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seed } from "./db/seed";
import { applyRecoveryPasswordFromEnv, ensureAdminPassword } from "./lib/auth";
import { logger } from "./lib/logger";
import { startScheduler, waitForSchedulerIdle } from "./lib/scheduler";
import { createShutdownHandler } from "./lib/shutdown";

try {
  runMigrations();
} catch (err) {
  logger.error("Database migration failed", { err });
  logger.error(
    "The database may be partially migrated: each migration file runs in its own " +
      "transaction, so an earlier file's changes are not automatically undone by a " +
      "later file's failure. Restore your previous container image and/or your most " +
      "recent database backup, then retry.",
  );
  process.exit(1);
}
logger.info("Migrations complete");
seed(db);
logger.info("Seed complete");
await applyRecoveryPasswordFromEnv();
await ensureAdminPassword();

const app = buildApp();

const schedulerTimer = startScheduler();

const server = Bun.serve({ port: 3000, fetch: app.fetch });

logger.info("Listening", { url: "http://localhost:3000" });

const handleSignal = createShutdownHandler({
  server,
  schedulerTimer,
  waitForSchedulerIdle,
  closeDb: () => sqlite.close(),
  exit: (code) => process.exit(code),
});
process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));
