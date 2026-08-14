export type ShutdownDeps = {
  server: { stop(): Promise<void> };
  schedulerTimer: Timer;
  waitForSchedulerIdle: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  timeoutMs?: number; // default 8000
};

export async function runShutdown(
  signal: string,
  deps: ShutdownDeps,
): Promise<number> {
  console.log(`Received ${signal}, starting graceful shutdown`);

  clearInterval(deps.schedulerTimer); // no new scheduler ticks start after this point

  const timeoutMs = deps.timeoutMs ?? 8000;
  const drain = Promise.all([deps.server.stop(), deps.waitForSchedulerIdle()]);
  // Prevents an unhandled rejection if drain settles (rejects) after the race below
  // has already resolved via the timeout branch -- see spec's "Known side effect".
  drain.catch(() => {});

  let timeoutHandle: Timer | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const result = await Promise.race([
    drain.then(() => "drain" as const),
    timeout,
  ]);

  let exitCode: number;
  if (result === "drain") {
    clearTimeout(timeoutHandle); // avoid a dangling timer, esp. with short test timeouts
    console.log("Graceful shutdown complete");
    exitCode = 0;
  } else {
    console.error(
      `Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`,
    );
    exitCode = 1;
  }

  // Closed unconditionally. On the forced-timeout path, the still-running abandoned
  // drain (e.g. an in-flight scheduler tick) may hit this now-closed connection and
  // log an "ingestion failed for channel <id>" line afterward -- expected, not a bug.
  deps.closeDb();

  return exitCode;
}

export function createShutdownHandler(
  deps: ShutdownDeps,
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) {
      console.log(`Received ${signal} again, shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    const exitCode = await runShutdown(signal, deps);
    deps.exit(exitCode);
  };
}
