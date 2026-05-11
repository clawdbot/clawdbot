import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const CODEX_LIMIT_ID = "codex";
const LIMIT_WINDOW_KEYS = ["primary", "secondary"] as const;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

type LimitWindowKey = (typeof LIMIT_WINDOW_KEYS)[number];

type RateLimitReset = {
  resetsAtMs: number;
  usedPercent?: number;
  windowDurationMins?: number;
};

type RateLimitWindowEntry = {
  key: LimitWindowKey;
  window: RateLimitReset;
};

export function formatCodexUsageLimitErrorMessage(params: {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  nowMs?: number;
}): string | undefined {
  const message = normalizeText(params.message);
  if (!isCodexUsageLimitError(params.codexErrorInfo, message)) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const nextReset = selectNextRateLimitReset(params.rateLimits, nowMs);
  const parts = ["You've reached your Codex subscription usage limit."];
  if (nextReset) {
    parts.push(`Next reset ${formatResetTime(nextReset.resetsAtMs, nowMs)}.`);
  } else {
    const codexRetryHint = extractCodexRetryHint(message);
    if (codexRetryHint) {
      parts.push(`Codex says to try again ${codexRetryHint}.`);
    } else {
      parts.push("Codex did not return a reset time for this limit.");
    }
  }
  parts.push("Run /codex account for current usage details.");
  return parts.join(" ");
}

export function shouldRefreshCodexRateLimitsForUsageLimitMessage(
  message: string | null | undefined,
): boolean {
  const text = normalizeText(message);
  return Boolean(
    text?.includes("You've reached your Codex subscription usage limit.") &&
    !text.includes("Next reset "),
  );
}

export function summarizeCodexRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value);
  if (snapshots.length === 0) {
    return undefined;
  }
  return snapshots
    .slice(0, 4)
    .map((snapshot) => summarizeRateLimitSnapshot(snapshot, nowMs))
    .join("; ");
}

export function summarizeCodexAccountRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string[] | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value);
  if (snapshots.length === 0) {
    return undefined;
  }
  const blockedSnapshots = snapshots.filter(snapshotHasLimitBlock);
  const blockingSnapshot =
    blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0] ?? undefined;
  if (!blockingSnapshot) {
    return ["Codex is available."];
  }
  const blockingReset = selectSnapshotBlockingReset(blockingSnapshot, nowMs);
  return [
    blockingReset
      ? `Codex is paused until ${formatAccountResetTime(blockingReset.resetsAtMs, nowMs)}.`
      : "Codex is paused by a usage limit.",
    formatBlockingLimitReason(blockingReset),
  ];
}

function isCodexUsageLimitError(
  codexErrorInfo: JsonValue | null | undefined,
  message: string | undefined,
): boolean {
  if (codexErrorInfo === "usageLimitExceeded") {
    return true;
  }
  if (typeof codexErrorInfo === "string") {
    const normalized = codexErrorInfo.replace(/[_\s-]/gu, "").toLowerCase();
    if (normalized === "usagelimitexceeded") {
      return true;
    }
  }
  return Boolean(message?.toLowerCase().includes("usage limit"));
}

function selectNextRateLimitReset(
  value: JsonValue | undefined,
  nowMs: number,
): RateLimitReset | undefined {
  const windows = collectCodexRateLimitSnapshots(value).flatMap((snapshot) =>
    LIMIT_WINDOW_KEYS.flatMap((key) => readRateLimitWindow(snapshot, key) ?? []),
  );
  const futureWindows = windows.filter((window) => window.resetsAtMs > nowMs);
  if (futureWindows.length === 0) {
    return undefined;
  }
  const exhaustedWindows = futureWindows.filter(
    (window) => window.usedPercent !== undefined && window.usedPercent >= 100,
  );
  const candidates = exhaustedWindows.length > 0 ? exhaustedWindows : futureWindows;
  candidates.sort((left, right) => left.resetsAtMs - right.resetsAtMs);
  return candidates[0];
}

function summarizeRateLimitSnapshot(snapshot: JsonObject, nowMs: number): string {
  const label = formatLimitLabel(snapshot);
  const windows = LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = readRateLimitWindow(snapshot, key);
    return window ? [formatRateLimitWindow(key, window, nowMs)] : [];
  });
  const reachedType =
    readString(snapshot, "rateLimitReachedType") ?? readString(snapshot, "rate_limit_reached_type");
  const suffix = reachedType ? ` (${formatReachedType(reachedType)})` : "";
  return `${label}: ${windows.join(", ") || "available"}${suffix}`;
}

function collectCodexRateLimitSnapshots(value: JsonValue | undefined): JsonObject[] {
  const snapshots: JsonObject[] = [];
  const seen = new Set<string>();
  collectRateLimitSnapshots(value, snapshots, seen);
  return snapshots;
}

function collectRateLimitSnapshots(
  value: JsonValue | undefined,
  snapshots: JsonObject[],
  seen: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRateLimitSnapshots(entry, snapshots, seen);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  if (isRateLimitSnapshot(value)) {
    addRateLimitSnapshot(value, snapshots, seen);
    return;
  }
  const byLimitId = value.rateLimitsByLimitId;
  if (isJsonObject(byLimitId)) {
    for (const key of sortedRateLimitKeys(Object.keys(byLimitId))) {
      collectRateLimitSnapshots(byLimitId[key], snapshots, seen);
    }
  }
  const snakeByLimitId = value.rate_limits_by_limit_id;
  if (isJsonObject(snakeByLimitId)) {
    for (const key of sortedRateLimitKeys(Object.keys(snakeByLimitId))) {
      collectRateLimitSnapshots(snakeByLimitId[key], snapshots, seen);
    }
  }
  collectRateLimitSnapshots(value.rateLimits, snapshots, seen);
  collectRateLimitSnapshots(value.rate_limits, snapshots, seen);
  collectRateLimitSnapshots(value.data, snapshots, seen);
  collectRateLimitSnapshots(value.items, snapshots, seen);
}

function sortedRateLimitKeys(keys: string[]): string[] {
  return keys.toSorted((left, right) => {
    if (left === CODEX_LIMIT_ID) {
      return -1;
    }
    if (right === CODEX_LIMIT_ID) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function addRateLimitSnapshot(
  snapshot: JsonObject,
  snapshots: JsonObject[],
  seen: Set<string>,
): void {
  const signature = [
    readNullableString(snapshot, "limitId") ?? readNullableString(snapshot, "limit_id") ?? "",
    readNullableString(snapshot, "limitName") ?? readNullableString(snapshot, "limit_name") ?? "",
    formatWindowSignature(snapshot.primary),
    formatWindowSignature(snapshot.secondary),
  ].join("|");
  if (seen.has(signature)) {
    return;
  }
  seen.add(signature);
  snapshots.push(snapshot);
}

function isRateLimitSnapshot(value: JsonObject): boolean {
  return (
    isJsonObject(value.primary) ||
    isJsonObject(value.secondary) ||
    value.rateLimitReachedType !== undefined ||
    value.rate_limit_reached_type !== undefined ||
    value.limitId !== undefined ||
    value.limit_id !== undefined ||
    value.limitName !== undefined ||
    value.limit_name !== undefined
  );
}

function readRateLimitWindow(
  snapshot: JsonObject,
  key: LimitWindowKey,
): RateLimitReset | undefined {
  const window = snapshot[key];
  if (!isJsonObject(window)) {
    return undefined;
  }
  const resetsAt = readNumber(window, "resetsAt") ?? readNumber(window, "resets_at");
  return {
    ...(typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0
      ? { resetsAtMs: resetsAt * 1000 }
      : { resetsAtMs: 0 }),
    ...readOptionalNumberField(window, "usedPercent", "used_percent"),
    ...readOptionalNumberField(
      window,
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes",
    ),
  };
}

function readOptionalNumberField(
  record: JsonObject,
  ...keys: string[]
): { usedPercent?: number; windowDurationMins?: number } {
  const value = keys.map((key) => readNumber(record, key)).find((entry) => entry !== undefined);
  if (value === undefined) {
    return {};
  }
  return keys.some((key) => key.toLowerCase().includes("window"))
    ? { windowDurationMins: value }
    : { usedPercent: value };
}

function formatRateLimitWindow(key: LimitWindowKey, window: RateLimitReset, nowMs: number): string {
  return `${key} ${formatRateLimitWindowDetails(window, nowMs)}`;
}

function formatRateLimitWindowDetails(window: RateLimitReset, nowMs: number): string {
  const usedPercent =
    window.usedPercent === undefined ? "usage unknown" : `${Math.round(window.usedPercent)}%`;
  const reset =
    window.resetsAtMs > nowMs ? `, resets ${formatResetTime(window.resetsAtMs, nowMs)}` : "";
  return `${usedPercent}${reset}`;
}

function formatLimitLabel(snapshot: JsonObject): string {
  const label =
    readNullableString(snapshot, "limitName") ??
    readNullableString(snapshot, "limit_name") ??
    readNullableString(snapshot, "limitId") ??
    readNullableString(snapshot, "limit_id");
  if (!label || label === CODEX_LIMIT_ID) {
    return "Codex";
  }
  return label.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function formatReachedType(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function formatResetTime(resetsAtMs: number, nowMs: number): string {
  return `in ${formatRelativeDuration(resetsAtMs - nowMs)}, ${formatCalendarResetTime(
    resetsAtMs,
    nowMs,
  )}`;
}

function formatAccountResetTime(resetsAtMs: number, nowMs: number): string {
  return `${formatCalendarResetTime(resetsAtMs, nowMs)} (in ${formatRelativeDuration(
    resetsAtMs - nowMs,
  )})`;
}

function snapshotHasLimitBlock(snapshot: JsonObject): boolean {
  return Boolean(
    readString(snapshot, "rateLimitReachedType") ??
    readString(snapshot, "rate_limit_reached_type") ??
    readWindowEntries(snapshot).some(
      (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
    ),
  );
}

function isCodexLimitSnapshot(snapshot: JsonObject): boolean {
  const id = readNullableString(snapshot, "limitId") ?? readNullableString(snapshot, "limit_id");
  return !id || id === CODEX_LIMIT_ID;
}

function selectSnapshotBlockingReset(
  snapshot: JsonObject,
  nowMs: number,
): RateLimitReset | undefined {
  const futureWindows = readWindowEntries(snapshot)
    .map((entry) => entry.window)
    .filter((window) => window.resetsAtMs > nowMs);
  const exhaustedWindows = futureWindows.filter(
    (window) => window.usedPercent !== undefined && window.usedPercent >= 100,
  );
  const candidates = exhaustedWindows.length > 0 ? exhaustedWindows : futureWindows;
  candidates.sort((left, right) => left.resetsAtMs - right.resetsAtMs);
  return candidates[0];
}

function readWindowEntries(snapshot: JsonObject): RateLimitWindowEntry[] {
  return LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = readRateLimitWindow(snapshot, key);
    return window ? [{ key, window }] : [];
  });
}

function formatBlockingLimitReason(window: RateLimitReset | undefined): string {
  const period = formatBlockingLimitPeriod(window?.windowDurationMins);
  return period
    ? `Your ${period} Codex usage limit is reached.`
    : "Your Codex usage limit is reached.";
}

function formatBlockingLimitPeriod(minutes: number | undefined): string | undefined {
  if (minutes === 7 * 24 * 60) {
    return "weekly";
  }
  if (minutes === 24 * 60) {
    return "daily";
  }
  if (minutes !== undefined && minutes > 0 && minutes < 24 * 60) {
    return "short-term";
  }
  return undefined;
}

function formatCalendarResetTime(resetsAtMs: number, nowMs: number): string {
  const resetDate = new Date(resetsAtMs);
  const resetParts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(resetDate.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(resetDate);
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    resetParts.find((entry) => entry.type === type)?.value;
  const dateParts = [part("month"), part("day"), part("year")].filter(Boolean);
  const day =
    dateParts.length > 1 ? `${dateParts[0]} ${dateParts.slice(1).join(", ")}` : dateParts[0];
  const time = [part("hour"), part("minute")].filter(Boolean).join(":");
  const dayPeriod = part("dayPeriod");
  const timeZone = part("timeZoneName");
  return [day, "at", [time, dayPeriod, timeZone].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
}

function formatRelativeDuration(durationMs: number): string {
  const safeMs = Math.max(1_000, durationMs);
  if (safeMs < ONE_MINUTE_MS) {
    return `${Math.ceil(safeMs / 1000)} seconds`;
  }
  if (safeMs < ONE_HOUR_MS) {
    const minutes = Math.ceil(safeMs / ONE_MINUTE_MS);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (safeMs < ONE_DAY_MS) {
    const hours = Math.ceil(safeMs / ONE_HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(safeMs / ONE_DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function formatWindowSignature(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) {
    return "";
  }
  return `${readNumber(value, "usedPercent") ?? readNumber(value, "used_percent") ?? ""}:${
    readNumber(value, "resetsAt") ?? readNumber(value, "resets_at") ?? ""
  }`;
}

function extractCodexRetryHint(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const tryAgainAt = /\btry again\s+(at\s+[^.!?\n]+)(?:[.!?]|$)/iu.exec(message);
  if (tryAgainAt?.[1]) {
    return tryAgainAt[1].trim();
  }
  const tryAgainRelative = /\btry again\s+((?:tomorrow|in\s+[^.!?\n]+)[^.!?\n]*)(?:[.!?]|$)/iu.exec(
    message,
  );
  return tryAgainRelative?.[1]?.trim();
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableString(record: JsonObject, key: string): string | undefined {
  return readString(record, key) ?? undefined;
}

function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
