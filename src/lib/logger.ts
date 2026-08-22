const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

function levelIndex(level: Level): number {
  return LEVELS.indexOf(level);
}

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  return raw !== undefined && (LEVELS as readonly string[]).includes(raw)
    ? (raw as Level)
    : "info";
}

function formatTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const rawOffset =
    offsetParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const offset = rawOffset.replace("GMT", "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

function normalizeMeta(
  meta: Record<string, unknown>,
  debug: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      result[key] = value.message;
      if (debug) {
        result[`${key}Stack`] = value.stack;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function render(
  level: Level,
  message: string,
  meta: Record<string, unknown> | undefined,
): string {
  const timestamp = formatTimestamp(new Date());
  const debug = currentLevel() === "debug";
  const normalizedMeta = meta ? normalizeMeta(meta, debug) : undefined;
  const format = process.env.LOG_FORMAT === "json" ? "json" : "text";

  if (format === "json") {
    return JSON.stringify({
      time: timestamp,
      level,
      message,
      ...normalizedMeta,
    });
  }

  const metaText = normalizedMeta
    ? Object.entries(normalizedMeta)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  const line = `${timestamp} [${level.toUpperCase()}] ${message}`;
  return metaText ? `${line} ${metaText}` : line;
}

function log(
  level: Level,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (levelIndex(level) < levelIndex(currentLevel())) return;
  const line = render(level, message, meta);
  if (level === "debug" || level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    log("debug", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    log("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    log("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    log("error", message, meta);
  },
};
