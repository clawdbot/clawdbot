/**
 * Enriches Codex usage-limit failures with current rate-limit information and
 * marks blocked auth profiles when Codex exposes a reset time.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { markAuthProfileBlockedUntil } from "openclaw/plugin-sdk/agent-runtime";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";
import {
  formatCodexUsageLimitErrorMessage,
  resolveCodexUsageLimitResetAtMs,
  shouldRefreshCodexRateLimitsForUsageLimitMessage,
} from "./rate-limits.js";

const CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS = 5_000;

type CodexUsageLimitErrorSource = {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  rateLimitsTrustedForProfile?: boolean;
};

type CodexUsageLimitErrorResult = {
  message: string;
  rateLimitsForProfile?: JsonValue;
};

export function createCodexUsageLimitPromptError(message: string): Error & { status: 429 } {
  return Object.assign(new Error(message), { status: 429 as const });
}

export function isCodexUsageLimitPromptError(error: unknown): error is Error & { status: 429 } {
  return error instanceof Error && "status" in error && error.status === 429;
}

/** Marks a Codex auth profile blocked until the reset time advertised by rate limits. */
export async function markCodexAuthProfileBlockedFromRateLimits(params: {
  params: EmbeddedRunAttemptParams;
  authProfileId?: string;
  rateLimits?: JsonValue;
}): Promise<void> {
  const authProfileId = params.authProfileId?.trim();
  if (!authProfileId || !params.params.authProfileStore) {
    return;
  }
  const blockedUntil = resolveCodexUsageLimitResetAtMs(params.rateLimits);
  if (!blockedUntil) {
    return;
  }
  try {
    await markAuthProfileBlockedUntil({
      store: params.params.authProfileStore,
      profileId: authProfileId,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: params.params.agentDir,
      runId: params.params.runId,
      modelId: params.params.modelId,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to mark Codex auth profile blocked from app-server limits", {
      authProfileId,
      error: formatErrorMessage(error),
    });
  }
}

/** Formats a turn-start usage-limit error, refreshing rate limits when needed. */
export async function formatCodexTurnStartUsageLimitError(params: {
  client: CodexAppServerClient;
  error: unknown;
  errorNotification?: CodexServerNotification;
  rateLimitsRevisionBeforeTurnStart?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  return refreshCodexUsageLimitError({
    client: params.client,
    source: readCodexTurnStartUsageLimitErrorSource(
      params.client,
      params.error,
      params.errorNotification,
      params.rateLimitsRevisionBeforeTurnStart,
    ),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

/** Refreshes a generic prompt usage-limit message into a reset-aware message. */
export async function refreshCodexUsageLimitPromptError(params: {
  client: CodexAppServerClient;
  message: string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(params.message)) {
    return undefined;
  }
  return refreshCodexUsageLimitError({
    client: params.client,
    source: {
      message: params.message,
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: readRecentCodexRateLimits(params.client),
    },
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

async function refreshCodexUsageLimitError(params: {
  client: CodexAppServerClient;
  source: CodexUsageLimitErrorSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  const initialMessage = formatCodexUsageLimitErrorMessage(params.source);
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(initialMessage)) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const rateLimits = await readCodexRateLimitsFromAppServerForUsageLimitError({
    client: params.client,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  if (!rateLimits) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const refreshedMessage = formatCodexUsageLimitErrorMessage({
    message: params.source.message,
    codexErrorInfo: params.source.codexErrorInfo,
    rateLimits,
  });
  const message = refreshedMessage ?? initialMessage;
  return message ? { message, rateLimitsForProfile: rateLimits } : undefined;
}

async function readCodexRateLimitsFromAppServerForUsageLimitError(params: {
  client: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  if (params.signal?.aborted) {
    return undefined;
  }
  try {
    const rateLimits = await params.client.request(CODEX_CONTROL_METHODS.rateLimits, undefined, {
      timeoutMs: resolveCodexUsageLimitRateLimitRefreshTimeoutMs(params.timeoutMs),
      signal: params.signal,
    });
    rememberCodexRateLimitsRead(params.client, rateLimits);
    return rateLimits;
  } catch (error) {
    embeddedAgentLog.debug("codex app-server rate-limit refresh failed after usage-limit error", {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

function resolveCodexUsageLimitRateLimitRefreshTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(timeoutMs, CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS));
}

function readCodexTurnStartUsageLimitErrorSource(
  client: CodexAppServerClient,
  error: unknown,
  errorNotification: CodexServerNotification | undefined,
  rateLimitsRevisionBeforeTurnStart: number | undefined,
): CodexUsageLimitErrorSource {
  const notificationError = readCodexErrorNotification(errorNotification);
  const errorPayload = readCodexErrorPayload(error);
  const rateLimits = errorPayload.rateLimits ?? readRecentCodexRateLimits(client);
  // The cached snapshot may predate this attempt or belong to another turn on
  // the same process. Trust it for the auth profile only when this client saw
  // a primary update after this turn's startup began.
  const cacheUpdatedDuringTurnStart =
    rateLimitsRevisionBeforeTurnStart !== undefined &&
    readCodexRateLimitsRevision(client) > rateLimitsRevisionBeforeTurnStart;
  return {
    message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
    codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
    rateLimits,
    rateLimitsTrustedForProfile:
      errorPayload.rateLimits !== undefined || cacheUpdatedDuringTurnStart,
  };
}

function readCodexErrorNotification(
  notification: CodexServerNotification | undefined,
): { message?: string; codexErrorInfo?: JsonValue | null } | undefined {
  if (notification?.method !== "error" || !isJsonObject(notification.params)) {
    return undefined;
  }
  const error = notification.params.error;
  return isJsonObject(error)
    ? {
        message: readString(error, "message"),
        codexErrorInfo: error.codexErrorInfo,
      }
    : undefined;
}

function readCodexErrorPayload(error: unknown): {
  message?: string;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
} {
  const message = error instanceof Error ? error.message : undefined;
  if (!error || typeof error !== "object" || !("data" in error)) {
    return { message };
  }
  const data = (error as { data?: unknown }).data as JsonValue | undefined;
  if (!isJsonObject(data)) {
    return { message };
  }
  const nestedError = isJsonObject(data.error) ? data.error : data;
  const rateLimits = nestedError.rateLimits ?? data.rateLimits;
  return {
    message: readString(nestedError, "message") ?? message,
    codexErrorInfo: nestedError.codexErrorInfo,
    rateLimits,
  };
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
