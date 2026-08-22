import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/lib/logger";

let savedLogLevel: string | undefined;
let savedLogFormat: string | undefined;
let savedTz: string | undefined;
let logSpy: ReturnType<typeof spyOn> | undefined;
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  savedLogLevel = process.env.LOG_LEVEL;
  savedLogFormat = process.env.LOG_FORMAT;
  savedTz = process.env.TZ;
});

afterEach(() => {
  if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLogLevel;
  if (savedLogFormat === undefined) delete process.env.LOG_FORMAT;
  else process.env.LOG_FORMAT = savedLogFormat;
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;

  // Restored here (not at the end of each test) so a failed expect() earlier
  // in a test still cleans up rather than leaking a spy into the next test.
  logSpy?.mockRestore();
  errorSpy?.mockRestore();
  logSpy = undefined;
  errorSpy = undefined;
});

test("level filtering: debug is a no-op under default LOG_LEVEL, info is not", () => {
  delete process.env.LOG_LEVEL;
  logSpy = spyOn(console, "log").mockImplementation(() => {});

  logger.debug("x");
  expect(logSpy).not.toHaveBeenCalled();

  logger.info("x");
  expect(logSpy).toHaveBeenCalledTimes(1);
});

test("level filtering: LOG_LEVEL=debug allows debug calls through", () => {
  process.env.LOG_LEVEL = "debug";
  logSpy = spyOn(console, "log").mockImplementation(() => {});

  logger.debug("x");
  expect(logSpy).toHaveBeenCalledTimes(1);
});

test("level ordering: LOG_LEVEL=error suppresses warn but allows error", () => {
  process.env.LOG_LEVEL = "error";
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  logger.warn("x");
  expect(errorSpy).not.toHaveBeenCalled();

  logger.error("x");
  expect(errorSpy).toHaveBeenCalledTimes(1);
});

test("LOG_FORMAT=json produces a parseable JSON line with expected fields", () => {
  process.env.LOG_FORMAT = "json";
  logSpy = spyOn(console, "log").mockImplementation(() => {});

  logger.info("hello", { foo: "bar" });

  const line = logSpy.mock.calls[0]?.[0] as string;
  const parsed = JSON.parse(line);
  expect(parsed.message).toBe("hello");
  expect(parsed.foo).toBe("bar");
  expect(typeof parsed.time).toBe("string");
});

test("text format is the default and includes level, message, and meta", () => {
  delete process.env.LOG_FORMAT;
  logSpy = spyOn(console, "log").mockImplementation(() => {});

  logger.info("hello", { foo: "bar" });

  const line = logSpy.mock.calls[0]?.[0] as string;
  expect(line).toContain("[INFO]");
  expect(line).toContain("hello");
  expect(line).toContain("foo=bar");
});

test("timestamp uses an offset-bearing format that reflects a non-UTC TZ", () => {
  process.env.TZ = "America/Chicago";
  logSpy = spyOn(console, "log").mockImplementation(() => {});

  logger.info("hello");

  const line = logSpy.mock.calls[0]?.[0] as string;
  const timestamp = line.split(" ")[0] as string;
  expect(timestamp).toMatch(/-\d{2}:\d{2}$/);
});

test("error meta renders message only by default, stack under LOG_LEVEL=debug", () => {
  delete process.env.LOG_LEVEL;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  logger.error("failed", { err: new Error("boom") });
  let line = errorSpy.mock.calls[0]?.[0] as string;
  expect(line).toContain("boom");
  expect(line).not.toContain("at ");
  expect(line).not.toContain("errStack");

  errorSpy.mockClear();
  process.env.LOG_LEVEL = "debug";

  logger.error("failed", { err: new Error("boom") });
  line = errorSpy.mock.calls[0]?.[0] as string;
  expect(line).toContain("errStack");
});

test("non-Error err value passes through without throwing", () => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  expect(() => {
    logger.error("failed", { err: "not an error object" });
  }).not.toThrow();
  const line = errorSpy.mock.calls[0]?.[0] as string;
  expect(line).toContain("not an error object");
});

test("stream split: debug/info use console.log, warn/error use console.error, in both formats", () => {
  for (const format of ["text", "json"] as const) {
    process.env.LOG_FORMAT = format;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    process.env.LOG_LEVEL = "debug";

    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy = undefined;
    errorSpy = undefined;
  }
});
