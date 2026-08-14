import { expect, test } from "bun:test";
import { createShutdownHandler, runShutdown } from "../../src/lib/shutdown";

// A real (but effectively inert) interval so `clearInterval(deps.schedulerTimer)`
// inside runShutdown has a genuine Timer to operate on, matching the type deps
// declares -- the interval's own callback never fires within a test's lifetime.
function fakeSchedulerTimer(): Timer {
  return setInterval(() => {}, 1_000_000);
}

test("runShutdown resolves with exit code 0 and closes the db on a clean drain", async () => {
  let closeDbCalled = false;

  const exitCode = await runShutdown("SIGTERM", {
    server: { stop: () => Promise.resolve() },
    schedulerTimer: fakeSchedulerTimer(),
    waitForSchedulerIdle: () => Promise.resolve(),
    closeDb: () => {
      closeDbCalled = true;
    },
    exit: () => {},
    timeoutMs: 1000,
  });

  expect(exitCode).toBe(0);
  expect(closeDbCalled).toBe(true);
});

test("runShutdown resolves with exit code 1 and still closes the db when the drain never finishes", async () => {
  let closeDbCalled = false;

  const exitCode = await runShutdown("SIGTERM", {
    server: { stop: () => new Promise(() => {}) }, // never resolves
    schedulerTimer: fakeSchedulerTimer(),
    waitForSchedulerIdle: () => new Promise(() => {}), // never resolves
    closeDb: () => {
      closeDbCalled = true;
    },
    exit: () => {},
    timeoutMs: 20,
  });

  expect(exitCode).toBe(1);
  expect(closeDbCalled).toBe(true);
});

test("createShutdownHandler's re-entrancy guard invokes exit exactly once for back-to-back signals", async () => {
  let resolveStop!: () => void;
  const pendingStop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  let exitCalls = 0;

  const handler = createShutdownHandler({
    server: { stop: () => pendingStop },
    schedulerTimer: fakeSchedulerTimer(),
    waitForSchedulerIdle: () => Promise.resolve(),
    closeDb: () => {},
    exit: () => {
      exitCalls++;
    },
    timeoutMs: 1000,
  });

  // Both calls made back-to-back while the first is still in flight -- the
  // second should be a no-op guarded by `shuttingDown`, not a second run.
  const first = handler("SIGTERM");
  const second = handler("SIGTERM");

  resolveStop();
  await first;
  await second;

  expect(exitCalls).toBe(1);
});

test("a late rejection of the losing drain branch does not surface as an unhandled rejection", async () => {
  let rejectStop!: (err: unknown) => void;
  const pendingStop = new Promise<void>((_resolve, reject) => {
    rejectStop = reject;
  });

  const exitCode = await runShutdown("SIGTERM", {
    server: { stop: () => pendingStop },
    schedulerTimer: fakeSchedulerTimer(),
    waitForSchedulerIdle: () => Promise.resolve(),
    closeDb: () => {},
    exit: () => {},
    timeoutMs: 10, // small enough that the timeout branch wins first
  });

  expect(exitCode).toBe(1);

  let unhandled = false;
  const onUnhandledRejection = () => {
    unhandled = true;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  // Reject only after runShutdown has already resolved via the timeout branch --
  // this is what the drain.catch(() => {}) in shutdown.ts guards against.
  rejectStop(new Error("late failure"));
  await Bun.sleep(10);

  process.off("unhandledRejection", onUnhandledRejection);
  expect(unhandled).toBe(false);
});
