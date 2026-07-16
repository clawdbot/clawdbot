/**
 * Parses Codex account rate-limit payloads into user-facing usage summaries,
 * reset hints, and enriched usage-limit error messages.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromEpochSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import {
  clampPercent,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { asFiniteNumber, parseStrictFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const CODEX_LIMIT_ID = "codex";
const LIMIT_WINDOW_KEYS = ["primary", "secondary"] as const;
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DAY_WINDOW_MINUTES = 24 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * DAY_WINDOW_MINUTES;
const WEEKLY_RESET_GAP_MS = 3 * ONE_DAY_MS;
const CODEX_USAGE_LIMIT_MESSAGE_PREFIX = "You've reached your Codex subscription usage limit.";

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

/** Human-readable Codex account usage state derived from rate-limit snapshots. */
export type CodexAccountUsageSummary = {
  usageLine?: string;
  blocked: boolean;
  blockedUntilMs?: number;
  blockedUntilText?: string;
  blockedResetRelative?: string;
  blockingPeriod?: string;
  blockingReason?: string;
};

/** Enriches Codex usage-limit failures with reset timing and recovery guidance. */
export function formatCodexUsageLimitErrorMessage(params: {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  nowMs?: number;
}): string | undefined {
  const message = normalizeText(params.message);
  if (!isCodexUsageLimitError(params.codexErrorInfo)) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const usageSummary = summarizeCodexAccountUsage(params.rateLimits, nowMs);
  const blockingReset = selectBlockingRateLimitReset(params.rateLimits, nowMs);
  const nextReset =
    blockingReset ??
    (usageSummary?.blocked ? undefined : selectNextRateLimitReset(params.rateLimits, nowMs));
  const parts = [CODEX_USAGE_LIMIT_MESSAGE_PREFIX];
  let recoveryAction = "Wait until Codex becomes available";
  if (nextReset) {
    parts.push(`Next reset ${formatResetTime(nextReset.resetsAtMs, nowMs)}.`);
    recoveryAction = "Wait until the reset time";
  } else {
    const codexRetryHint = extractCodexRetryHint(message);
    if (codexRetryHint) {
      parts.push(`Codex says to try again ${codexRetryHint}.`);
      recoveryAction = "Wait until the retry time";
    } else {
      if (usageSummary?.blockingPeriod && usageSummary.blockingReason) {
        parts.push(`Your ${usageSummary.blockingReason}.`);
      }
      parts.push("OpenClaw could not determine a reset time from Codex.");
    }
  }
  parts.push(
    `${recoveryAction}, use another Codex account if available, or switch to another configured model/provider.`,
  );
  return parts.join(" ");
}

/** Detects usage-limit messages that need a fresh rate-limit query before display. */
export function shouldRefreshCodexRateLimitsForUsageLimitMessage(
  message: string | null | undefined,
): boolean {
  const text = normalizeText(message);
  // Only our formatted prefix is a refresh contract. Provider prose alone is
  // not structural evidence of a Codex usage-limit failure.
  return Boolean(
    text?.startsWith(CODEX_USAGE_LIMIT_MESSAGE_PREFIX) && !text.includes("Next reset "),
  );
}

/** Formats compact summaries for raw Codex rate-limit snapshot payloads. */
export function summarizeCodexRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value).filter(snapshotHasDisplayableData);
  if (snapshots.length === 0) {
    return undefined;
  }
  const summaries = snapshots
    .slice(0, 4)
    .map((snapshot) => summarizeRateLimitSnapshot(snapshot, nowMs))
    .filter((summary): summary is string => summary !== undefined);
  return summaries.length > 0 ? summaries.join("; ") : undefined;
}

/** Returns true when a value contains any recognizable Codex rate-limit snapshots. */
export function hasCodexRateLimitSnapshots(value: JsonValue | undefined): boolean {
  return collectCodexRateLimitSnapshots(value).length > 0;
}

/** Builds short account availability lines suitable for status surfaces. */
export function summarizeCodexAccountRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string[] | undefined {
  const summary = summarizeCodexAccountUsage(value, nowMs);
  if (!summary) {
    return undefined;
  }
  if (!summary.blocked) {
    return ["Codex is available."];
  }
  return [
    summary.blockedUntilText
      ? `Codex is paused until ${summary.blockedUntilText}.`
      : "Codex is paused by a usage limit.",
    summary.blockingReason
      ? `Your ${summary.blockingReason}.`
      : "Your Codex usage limit is reached.",
  ];
}

/** Returns the reset timestamp for the currently blocking Codex usage limit. */
export function resolveCodexUsageLimitResetAtMs(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): number | undefined {
  return selectBlockingRateLimitReset(value, nowMs)?.resetsAtMs;
}

/** Summarizes account availability, blocking reason, and reset time from rate-limit data. */
export function summarizeCodexAccountUsage(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): CodexAccountUsageSummary | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value).filter(snapshotHasDisplayableData);
  if (snapshots.length === 0) {
    return undefined;
  }
  const usageSnapshot =
    snapshots.find(isCodexLimitSnapshot) ??
    expectDefined(snapshots[0], "displayable Codex rate-limit snapshot");
  const blockedSnapshots = snapshots.filter(snapshotHasLimitBlock);
  const blockingSnapshot =
    blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0] ?? undefined;
  const blockingEntries = blockingSnapshot ? readWindowEntries(blockingSnapshot) : [];
  const blockingWindowEntry = selectBlockingWindowEntry(blockingEntries, nowMs);
  const blockingWindow = blockingWindowEntry?.window;
  const blockingReset =
    blockingWindow && blockingWindow.resetsAtMs > nowMs ? blockingWindow : undefined;
  const blockingPeriod = formatBlockingLimitPeriod(blockingWindowEntry, blockingEntries);
  const blockedUntilText = blockingReset
    ? formatAccountResetTime(blockingReset.resetsAtMs, nowMs)
    : undefined;
  const blockedResetRelative = blockingReset
    ? `in ${formatRelativeDuration(blockingReset.resetsAtMs - nowMs)}`
    : undefined;
  const blockingReason = blockingPeriod
    ? `${blockingPeriod} Codex usage limit is reached`
    : blockingSnapshot
      ? "Codex usage limit is reached"
      : undefined;
  return {
    usageLine: formatUsageLine(usageSnapshot),
    blocked: Boolean(blockingSnapshot),
    ...(blockingReset ? { blockedUntilMs: blockingReset.resetsAtMs } : {}),
    ...(blockedUntilText ? { blockedUntilText } : {}),
    ...(blockedResetRelative ? { blockedResetRelative } : {}),
    ...(blockingPeriod ? { blockingPeriod } : {}),
    ...(blockingReason ? { blockingReason } : {}),
  };
}

/** Converts Codex app-server rate-limit payloads into OpenAI/Codex usage windows. */
export function buildCodexAppServerUsageSnapshot(value: unknown): ProviderUsageSnapshot {
  const snapshot = selectCodexProviderUsageSnapshot(value);
  const entries = snapshot ? readWindowEntries(snapshot) : [];
  const windows = entries
    .map((entry) => readProviderUsageWindow(entry, entries))
    .filter((window): window is UsageWindow => Boolean(window));
  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    ...(snapshot ? { plan: resolveCodexProviderUsagePlan(snapshot) } : {}),
  };
}

function isCodexUsageLimitError(codexErrorInfo: JsonValue | null | undefined): boolean {
  if (codexErrorInfo === "usageLimitExceeded") {
    return true;
  }
  if (typeof codexErrorInfo === "string") {
    const normalized = codexErrorInfo.replace(/[_\s-]/gu, "").toLowerCase();
    if (normalized === "usagelimitexceeded") {
      return true;
    }
  }
  return false;
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
  return candidates.toSorted((left, right) => left.resetsAtMs - right.resetsAtMs)[0];
}

function selectBlockingRateLimitReset(
  value: JsonValue | undefined,
  nowMs: number,
): RateLimitReset | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value);
  const blockedSnapshots = snapshots.filter(snapshotHasLimitBlock);
  const blockingSnapshot =
    blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0] ?? undefined;
  return blockingSnapshot ? selectSnapshotBlockingReset(blockingSnapshot, nowMs) : undefined;
}

function summarizeRateLimitSnapshot(snapshot: JsonObject, nowMs: number): string | undefined {
  const label = formatLimitLabel(snapshot);
  const windows = LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = readRateLimitWindow(snapshot, key);
    return window ? [formatRateLimitWindow(key, window, nowMs)] : [];
  });
  const reachedType =
    readString(snapshot, "rateLimitReachedType") ?? readString(snapshot, "rate_limit_reached_type");
  const suffix = reachedType ? ` (${formatReachedType(reachedType)})` : "";
  if (windows.length > 0) {
    return `${label}: ${windows.join(" · ")}${suffix}`;
  }
  if (reachedType) {
    return `${label}: ${formatReachedType(reachedType)}`;
  }
  return undefined;
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
  const resetsAtMs =
    resolveExpiresAtMsFromEpochSeconds(resetsAt, { maxMs: MAX_DATE_TIMESTAMP_MS }) ?? 0;
  return {
    resetsAtMs,
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

function snapshotHasDisplayableData(snapshot: JsonObject): boolean {
  if (
    readString(snapshot, "rateLimitReachedType") ??
    readString(snapshot, "rate_limit_reached_type")
  ) {
    return true;
  }
  return readWindowEntries(snapshot).some(
    (entry) => entry.window.usedPercent !== undefined || entry.window.resetsAtMs > 0,
  );
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
  const remainingPercent =
    window.usedPercent === undefined
      ? "usage unknown"
      : `${Math.max(0, 100 - Math.round(window.usedPercent))}% left`;
  const reset =
    window.resetsAtMs > nowMs ? ` ⏱${formatResetDuration(window.resetsAtMs, nowMs)}` : "";
  return `${remainingPercent}${reset}`;
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

function selectCodexProviderUsageSnapshot(value: unknown): JsonObject | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value as JsonValue | undefined);
  return snapshots.find(isCodexLimitSnapshot) ?? snapshots[0];
}

function readProviderUsageWindow(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): UsageWindow | undefined {
  const { window } = entry;
  if (window.usedPercent === undefined && window.resetsAtMs <= 0) {
    return undefined;
  }
  return {
    label: formatProviderUsageWindowLabel(entry, entries),
    usedPercent: clampPercent(window.usedPercent ?? 0),
    resetAt: window.resetsAtMs > 0 ? window.resetsAtMs : undefined,
  };
}

function formatProviderUsageWindowLabel(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): string {
  const minutes = entry.window.windowDurationMins;
  if (minutes === WEEKLY_WINDOW_MINUTES || hasWeeklySecondaryResetCadence(entry, entries)) {
    return "Week";
  }
  if (minutes === DAY_WINDOW_MINUTES) {
    return "Day";
  }
  if (minutes !== undefined && minutes > 0 && minutes < DAY_WINDOW_MINUTES) {
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % DAY_WINDOW_MINUTES === 0) {
    return `${minutes / DAY_WINDOW_MINUTES}d`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return entry.key === "primary" ? "Short" : "Long";
}

function resolveCodexProviderUsagePlan(snapshot: JsonObject): string | undefined {
  const plan = readString(snapshot, "planType") ?? readString(snapshot, "plan_type");
  const credits = isJsonObject(snapshot.credits) ? snapshot.credits : undefined;
  const creditSummary = formatCodexCreditSummary(credits);
  if (!creditSummary) {
    return plan;
  }
  return plan ? `${plan} (${creditSummary})` : creditSummary;
}

function formatCodexCreditSummary(credits: JsonObject | undefined): string | undefined {
  if (!credits) {
    return undefined;
  }
  const hasCredits = readBoolean(credits, "hasCredits") ?? readBoolean(credits, "has_credits");
  if (hasCredits === false) {
    return undefined;
  }
  if (readBoolean(credits, "unlimited")) {
    return "Unlimited credits";
  }
  const balance =
    typeof credits.balance === "string"
      ? parseStrictFiniteNumber(credits.balance)
      : asFiniteNumber(credits.balance);
  if (balance === undefined || balance <= 0) {
    return undefined;
  }
  const roundedBalance = Math.round(balance);
  return roundedBalance > 0 ? `${roundedBalance} credits` : undefined;
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
  const resetSort =
    exhaustedWindows.length > 0
      ? (left: RateLimitReset, right: RateLimitReset) => right.resetsAtMs - left.resetsAtMs
      : (left: RateLimitReset, right: RateLimitReset) => left.resetsAtMs - right.resetsAtMs;
  return candidates.toSorted(resetSort)[0];
}

function selectBlockingWindowEntry(
  entries: RateLimitWindowEntry[],
  nowMs: number,
): RateLimitWindowEntry | undefined {
  const futureEntries = entries.filter((entry) => entry.window.resetsAtMs > nowMs);
  const exhaustedFutureEntries = futureEntries.filter(
    (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
  );
  const resetCandidates =
    exhaustedFutureEntries.length > 0 ? exhaustedFutureEntries : futureEntries;
  if (resetCandidates.length > 0) {
    const resetSort =
      exhaustedFutureEntries.length > 0
        ? (left: RateLimitWindowEntry, right: RateLimitWindowEntry) =>
            right.window.resetsAtMs - left.window.resetsAtMs
        : (left: RateLimitWindowEntry, right: RateLimitWindowEntry) =>
            left.window.resetsAtMs - right.window.resetsAtMs;
    return resetCandidates.toSorted(resetSort)[0];
  }
  const exhaustedEntries = entries.filter(
    (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
  );
  return exhaustedEntries.toSorted(
    (left, right) => (right.window.windowDurationMins ?? 0) - (left.window.windowDurationMins ?? 0),
  )[0];
}

function readWindowEntries(snapshot: JsonObject): RateLimitWindowEntry[] {
  return LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = readRateLimitWindow(snapshot, key);
    return window ? [{ key, window }] : [];
  });
}

function formatBlockingLimitPeriod(
  entry: RateLimitWindowEntry | undefined,
  entries: RateLimitWindowEntry[],
): string | undefined {
  const minutes = entry?.window.windowDurationMins;
  if (
    entry &&
    (minutes === WEEKLY_WINDOW_MINUTES || hasWeeklySecondaryResetCadence(entry, entries))
  ) {
    return "weekly";
  }
  if (minutes === DAY_WINDOW_MINUTES) {
    return "daily";
  }
  if (minutes !== undefined && minutes > 0 && minutes < DAY_WINDOW_MINUTES) {
    return "short-term";
  }
  return undefined;
}

function formatUsageLine(snapshot: JsonObject): string | undefined {
  const entries = readWindowEntries(snapshot);
  const windows = entries
    .filter((entry) => entry.window.usedPercent !== undefined)
    .toSorted(
      (left, right) =>
        (right.window.windowDurationMins ?? 0) - (left.window.windowDurationMins ?? 0),
    )
    .map((entry) => {
      const label = formatUsageWindowLabel(entry, entries);
      return `${label} ${Math.round(entry.window.usedPercent ?? 0)}%`;
    });
  return windows.length > 0 ? windows.join(" \u00b7 ") : undefined;
}

function formatUsageWindowLabel(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): string {
  const minutes = entry.window.windowDurationMins;
  if (minutes === WEEKLY_WINDOW_MINUTES || hasWeeklySecondaryResetCadence(entry, entries)) {
    return "weekly";
  }
  if (minutes === DAY_WINDOW_MINUTES) {
    return "daily";
  }
  if (minutes !== undefined && minutes > 0 && minutes < DAY_WINDOW_MINUTES) {
    return "short-term";
  }
  if (minutes !== undefined && minutes > 0 && minutes % DAY_WINDOW_MINUTES === 0) {
    const days = minutes / DAY_WINDOW_MINUTES;
    return `${days}-day`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour`;
  }
  return "usage";
}

function hasWeeklySecondaryResetCadence(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): boolean {
  if (entry.key !== "secondary" || entry.window.windowDurationMins !== DAY_WINDOW_MINUTES) {
    return false;
  }
  const primaryResetMs = entries.find((candidate) => candidate.key === "primary")?.window
    .resetsAtMs;
  return (
    typeof primaryResetMs === "number" &&
    primaryResetMs > 0 &&
    entry.window.resetsAtMs > 0 &&
    entry.window.resetsAtMs - primaryResetMs >= WEEKLY_RESET_GAP_MS
  );
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

function formatResetDuration(resetsAtMs: number, nowMs: number): string {
  const durationMs =
    Math.round(Math.max(ONE_SECOND_MS, resetsAtMs - nowMs) / ONE_SECOND_MS) * ONE_SECOND_MS;
  const days = Math.floor(durationMs / ONE_DAY_MS);
  const hours = Math.floor((durationMs % ONE_DAY_MS) / ONE_HOUR_MS);
  const minutes = Math.floor((durationMs % ONE_HOUR_MS) / ONE_MINUTE_MS);
  const seconds = Math.floor((durationMs % ONE_MINUTE_MS) / ONE_SECOND_MS);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
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
  return asFiniteNumber(record[key]);
}

function readBoolean(record: JsonObject, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
