// Control UI controller manages usage gateway state.
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { SessionsUsageResult, CostUsageSummary, SessionUsageTimeSeries } from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageScope: "instance" | "family";
  usageAgentId: string | null;
  usageQuery: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageTimeZone: "local" | "utc";
  settings?: { gatewayUrl?: string };
};

const LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY = "openclaw.control.usage.date-params.v1";
const LEGACY_USAGE_SCOPE_PARAMS_STORAGE_KEY = "openclaw.control.usage.scope-params.v1";
const LEGACY_USAGE_AGENT_PARAMS_STORAGE_KEY = "openclaw.control.usage.agent-params.v1";
const LEGACY_USAGE_AGENT_SCOPE_STORAGE_KEY = "openclaw.control.usage.agent-scope.v1";
const LEGACY_USAGE_DATE_PARAMS_MODE_RE = /unexpected property ['"]mode['"]/i;
const LEGACY_USAGE_DATE_PARAMS_OFFSET_RE = /unexpected property ['"]utcoffset['"]/i;
const LEGACY_USAGE_SCOPE_PARAMS_GROUP_BY_RE = /unexpected property ['"]groupby['"]/i;
const LEGACY_USAGE_SCOPE_PARAMS_INCLUDE_HISTORICAL_RE =
  /unexpected property ['"]includehistorical['"]/i;
const LEGACY_USAGE_AGENT_PARAMS_AGENT_ID_RE = /unexpected property ['"]agentid['"]/i;
const LEGACY_USAGE_AGENT_SCOPE_RE = /unexpected property ['"]agentscope['"]/i;
const LEGACY_USAGE_DATE_PARAMS_INVALID_RE = /invalid sessions\.usage params/i;

let legacyUsageDateParamsCache: Set<string> | null = null;
let legacyUsageScopeParamsCache: Set<string> | null = null;
let legacyUsageAgentParamsCache: Set<string> | null = null;
let legacyUsageAgentScopeCache: Set<string> | null = null;

function loadLegacyGatewayParamCache(storageKey: string): Set<string> {
  const raw = getSafeLocalStorage()?.getItem(storageKey);
  if (!raw) {
    return new Set<string>();
  }
  try {
    const keys = (JSON.parse(raw) as { unsupportedGatewayKeys?: unknown } | null)
      ?.unsupportedGatewayKeys;
    if (!Array.isArray(keys)) {
      return new Set<string>();
    }
    return new Set(
      keys
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}

function persistLegacyGatewayParamCache(storageKey: string, cache: Set<string>) {
  try {
    getSafeLocalStorage()?.setItem(
      storageKey,
      JSON.stringify({ unsupportedGatewayKeys: Array.from(cache) }),
    );
  } catch {
    // ignore quota/private-mode failures
  }
}

function getLegacyUsageDateParamsCache(): Set<string> {
  if (!legacyUsageDateParamsCache) {
    legacyUsageDateParamsCache = loadLegacyGatewayParamCache(LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY);
  }
  return legacyUsageDateParamsCache;
}

function getLegacyUsageScopeParamsCache(): Set<string> {
  if (!legacyUsageScopeParamsCache) {
    legacyUsageScopeParamsCache = loadLegacyGatewayParamCache(
      LEGACY_USAGE_SCOPE_PARAMS_STORAGE_KEY,
    );
  }
  return legacyUsageScopeParamsCache;
}

function getLegacyUsageAgentParamsCache(): Set<string> {
  if (!legacyUsageAgentParamsCache) {
    legacyUsageAgentParamsCache = loadLegacyGatewayParamCache(
      LEGACY_USAGE_AGENT_PARAMS_STORAGE_KEY,
    );
  }
  return legacyUsageAgentParamsCache;
}

function getLegacyUsageAgentScopeCache(): Set<string> {
  if (!legacyUsageAgentScopeCache) {
    legacyUsageAgentScopeCache = loadLegacyGatewayParamCache(LEGACY_USAGE_AGENT_SCOPE_STORAGE_KEY);
  }
  return legacyUsageAgentScopeCache;
}

function normalizeGatewayCompatibilityKey(gatewayUrl?: string): string {
  const trimmed = gatewayUrl?.trim();
  if (!trimmed) {
    return "__default__";
  }
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return normalizeLowercaseStringOrEmpty(`${parsed.protocol}//${parsed.host}${pathname}`);
  } catch {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
}

function shouldSendLegacyDateInterpretation(state: UsageState): boolean {
  return !getLegacyUsageDateParamsCache().has(
    normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl),
  );
}

function rememberLegacyDateInterpretation(state: UsageState) {
  const cache = getLegacyUsageDateParamsCache();
  cache.add(normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl));
  persistLegacyGatewayParamCache(LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY, cache);
}

function shouldSendLegacyUsageScopeParams(state: UsageState): boolean {
  return !getLegacyUsageScopeParamsCache().has(
    normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl),
  );
}

function rememberLegacyUsageScopeParams(state: UsageState) {
  const cache = getLegacyUsageScopeParamsCache();
  cache.add(normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl));
  persistLegacyGatewayParamCache(LEGACY_USAGE_SCOPE_PARAMS_STORAGE_KEY, cache);
}

function shouldSendLegacyUsageAgentParams(state: UsageState): boolean {
  return !getLegacyUsageAgentParamsCache().has(
    normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl),
  );
}

function rememberLegacyUsageAgentParams(state: UsageState) {
  const cache = getLegacyUsageAgentParamsCache();
  cache.add(normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl));
  persistLegacyGatewayParamCache(LEGACY_USAGE_AGENT_PARAMS_STORAGE_KEY, cache);
}

function shouldSendLegacyUsageAgentScope(state: UsageState): boolean {
  return !getLegacyUsageAgentScopeCache().has(
    normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl),
  );
}

function rememberLegacyUsageAgentScope(state: UsageState) {
  const cache = getLegacyUsageAgentScopeCache();
  cache.add(normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl));
  persistLegacyGatewayParamCache(LEGACY_USAGE_AGENT_SCOPE_STORAGE_KEY, cache);
}

function isLegacyDateInterpretationUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    (LEGACY_USAGE_DATE_PARAMS_MODE_RE.test(message) ||
      LEGACY_USAGE_DATE_PARAMS_OFFSET_RE.test(message))
  );
}

function isLegacyUsageScopeUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    (LEGACY_USAGE_SCOPE_PARAMS_GROUP_BY_RE.test(message) ||
      LEGACY_USAGE_SCOPE_PARAMS_INCLUDE_HISTORICAL_RE.test(message))
  );
}

function isLegacyUsageAgentUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    LEGACY_USAGE_AGENT_PARAMS_AGENT_ID_RE.test(message)
  );
}

function isLegacyUsageAgentScopeUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) && LEGACY_USAGE_AGENT_SCOPE_RE.test(message)
  );
}

const formatUtcOffset = (timezoneOffsetMinutes: number): string => {
  // `Date#getTimezoneOffset()` is minutes to add to local time to reach UTC.
  // Convert to UTC±H[:MM] where positive means east of UTC.
  const offsetFromUtcMinutes = -timezoneOffsetMinutes;
  const sign = offsetFromUtcMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetFromUtcMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
};

const buildDateInterpretationParams = (timeZone: "local" | "utc") => {
  if (timeZone === "utc") {
    return { mode: "utc" };
  }
  return {
    mode: "specific",
    utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
  };
};

function toErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error && typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err) || "request failed";
    } catch {
      // ignore
    }
  }
  return "request failed";
}

function applyUsageResults(state: UsageState, sessionsRes: unknown, costRes: unknown) {
  if (sessionsRes) {
    state.usageResult = sessionsRes as SessionsUsageResult;
  }
  if (costRes) {
    state.usageCostSummary = costRes as CostUsageSummary;
  }
}

export async function loadUsage(
  state: UsageState,
  overrides?: {
    startDate?: string;
    endDate?: string;
  },
) {
  // Capture client for TS18047 work around on it being possibly null
  const client = state.client;
  if (!client || !state.connected || state.usageLoading) {
    return;
  }
  state.usageLoading = true;
  state.usageError = null;
  try {
    const startDate = overrides?.startDate ?? state.usageStartDate;
    const endDate = overrides?.endDate ?? state.usageEndDate;
    const agentId = normalizeLowercaseStringOrEmpty(state.usageAgentId ?? "") || undefined;
    const runUsageRequests = (
      includeDateInterpretation: boolean,
      includeUsageScope: boolean,
      includeAgentScope: boolean,
      includeAllAgentScope: boolean,
    ) => {
      const dateInterpretation = includeDateInterpretation
        ? buildDateInterpretationParams(state.usageTimeZone)
        : undefined;
      const usageScopeParams = includeUsageScope
        ? {
            groupBy: state.usageScope,
            includeHistorical: state.usageScope === "family",
          }
        : undefined;
      const agentScopeParams = agentId
        ? includeAgentScope
          ? { agentId }
          : undefined
        : includeAllAgentScope
          ? { agentScope: "all" as const }
          : undefined;
      return Promise.all([
        client.request("sessions.usage", {
          startDate,
          endDate,
          ...agentScopeParams,
          ...dateInterpretation,
          ...usageScopeParams,
          limit: 1000, // Cap at 1000 sessions
          includeContextWeight: true,
        }),
        client.request("usage.cost", {
          startDate,
          endDate,
          ...agentScopeParams,
          ...dateInterpretation,
        }),
      ]);
    };

    let includeDateInterpretation = shouldSendLegacyDateInterpretation(state);
    let includeUsageScope = shouldSendLegacyUsageScopeParams(state);
    let includeAgentScope = Boolean(agentId) && shouldSendLegacyUsageAgentParams(state);
    let includeAllAgentScope = !agentId && shouldSendLegacyUsageAgentScope(state);
    while (true) {
      try {
        const [sessionsRes, costRes] = await runUsageRequests(
          includeDateInterpretation,
          includeUsageScope,
          includeAgentScope,
          includeAllAgentScope,
        );
        applyUsageResults(state, sessionsRes, costRes);
        break;
      } catch (err) {
        if (includeAgentScope && isLegacyUsageAgentUnsupportedError(err)) {
          // Older gateways reject `agentId` in `sessions.usage`.
          // Remember this per gateway and retry with client-side filtering only.
          rememberLegacyUsageAgentParams(state);
          includeAgentScope = false;
          continue;
        }
        if (includeAllAgentScope && isLegacyUsageAgentScopeUnsupportedError(err)) {
          // Older gateways reject explicit all-agent usage scope. Retrying without
          // it keeps pre-agent-scope gateways usable while current gateways prove all-agent intent.
          rememberLegacyUsageAgentScope(state);
          includeAllAgentScope = false;
          continue;
        }
        if (includeUsageScope && isLegacyUsageScopeUnsupportedError(err)) {
          // Older gateways reject `groupBy`/`includeHistorical` in `sessions.usage`.
          // Remember this per gateway and retry with instance-compatible params.
          rememberLegacyUsageScopeParams(state);
          includeUsageScope = false;
          continue;
        }
        if (includeDateInterpretation && isLegacyDateInterpretationUnsupportedError(err)) {
          // Older gateways reject `mode`/`utcOffset` in `sessions.usage`.
          // Remember this per gateway and retry once without those fields.
          rememberLegacyDateInterpretation(state);
          includeDateInterpretation = false;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.usageResult = null;
      state.usageCostSummary = null;
      state.usageError = formatMissingOperatorReadScopeMessage("usage");
    } else {
      state.usageError = toErrorMessage(err);
    }
  } finally {
    state.usageLoading = false;
  }
}

export const testApi = {
  formatUtcOffset,
  buildDateInterpretationParams,
  toErrorMessage,
  isLegacyDateInterpretationUnsupportedError,
  isLegacyUsageScopeUnsupportedError,
  isLegacyUsageAgentUnsupportedError,
  isLegacyUsageAgentScopeUnsupportedError,
  normalizeGatewayCompatibilityKey,
  shouldSendLegacyDateInterpretation,
  rememberLegacyDateInterpretation,
  shouldSendLegacyUsageScopeParams,
  rememberLegacyUsageScopeParams,
  shouldSendLegacyUsageAgentParams,
  rememberLegacyUsageAgentParams,
  shouldSendLegacyUsageAgentScope,
  rememberLegacyUsageAgentScope,
  resetLegacyUsageDateParamsCache: () => {
    legacyUsageDateParamsCache = null;
    legacyUsageScopeParamsCache = null;
    legacyUsageAgentParamsCache = null;
    legacyUsageAgentScopeCache = null;
  },
};
export { testApi as __test };

async function runOptionalUsageDetailRequest(
  state: UsageState,
  loadingKey: "usageTimeSeriesLoading" | "usageSessionLogsLoading",
  run: (client: GatewayBrowserClient) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state[loadingKey]) {
    return;
  }
  state[loadingKey] = true;
  try {
    await run(client);
  } catch {
    // Silently fail - optional detail endpoints
  } finally {
    state[loadingKey] = false;
  }
}

export async function loadSessionTimeSeries(state: UsageState, sessionKey: string) {
  await runOptionalUsageDetailRequest(state, "usageTimeSeriesLoading", async (client) => {
    state.usageTimeSeries = null;
    const res = await client.request("sessions.usage.timeseries", { key: sessionKey });
    state.usageTimeSeries = res ? (res as SessionUsageTimeSeries) : null;
  });
}

export async function loadSessionLogs(state: UsageState, sessionKey: string) {
  await runOptionalUsageDetailRequest(state, "usageSessionLogsLoading", async (client) => {
    state.usageSessionLogs = null;
    const payload = (await client.request("sessions.usage.logs", {
      key: sessionKey,
      limit: 1000,
    })) as { logs?: unknown } | null;
    const logs = payload?.logs;
    state.usageSessionLogs = Array.isArray(logs) ? (logs as SessionLogEntry[]) : null;
  });
}
