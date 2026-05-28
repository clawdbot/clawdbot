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
import { readRecentCodexRateLimits, rememberCodexRateLimits } from "./rate-limit-cache.js";
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

export async function formatCodexTurnStartUsageLimitError(params: {
  client: CodexAppServerClient;
  error: unknown;
  pendingNotifications: CodexServerNotification[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  return refreshCodexUsageLimitError({
    client: params.client,
    source: readCodexTurnStartUsageLimitErrorSource(params.error, params.pendingNotifications),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

export async function refreshCodexUsageLimitPromptError(params: {
  client: CodexAppServerClient;
  message: string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(params.message)) {
    return undefined;
  }
  return (
    await refreshCodexUsageLimitError({
      client: params.client,
      source: {
        message: params.message,
        codexErrorInfo: "usageLimitExceeded",
        rateLimits: readRecentCodexRateLimits(),
      },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    })
  )?.message;
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
    rememberCodexRateLimits(rateLimits);
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
  error: unknown,
  pendingNotifications: CodexServerNotification[],
): CodexUsageLimitErrorSource {
  const notificationError = readLatestCodexErrorNotification(pendingNotifications);
  const notificationRateLimits = readLatestRateLimitNotificationPayload(pendingNotifications);
  const errorPayload = readCodexErrorPayload(error);
  const rateLimits =
    notificationRateLimits ?? errorPayload.rateLimits ?? readRecentCodexRateLimits();
  return {
    message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
    codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
    rateLimits,
    rateLimitsTrustedForProfile:
      notificationRateLimits !== undefined || errorPayload.rateLimits !== undefined,
  };
}

function readLatestRateLimitNotificationPayload(
  notifications: CodexServerNotification[],
): JsonValue | undefined {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (notification?.method === "account/rateLimits/updated") {
      rememberCodexRateLimits(notification.params);
      return notification.params;
    }
  }
  return undefined;
}

function readLatestCodexErrorNotification(
  notifications: CodexServerNotification[],
): { message?: string; codexErrorInfo?: JsonValue | null } | undefined {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (notification?.method !== "error" || !isJsonObject(notification.params)) {
      continue;
    }
    const error = notification.params.error;
    if (!isJsonObject(error)) {
      continue;
    }
    return {
      message: readString(error, "message"),
      codexErrorInfo: error.codexErrorInfo,
    };
  }
  return undefined;
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
  if (rateLimits !== undefined) {
    rememberCodexRateLimits(rateLimits);
  }
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
