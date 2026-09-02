// Msteams plugin module implements errors behavior.
import { asFiniteNumberInRange, parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  isTransientNetworkError,
  parseRetryAfterHeaderSeconds,
} from "openclaw/plugin-sdk/retry-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_SAFE_RETRY_AFTER_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === null) {
    return "null";
  }
  if (err === undefined) {
    return "undefined";
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? err.toString();
  }
  if (typeof err === "function") {
    return err.name ? `[function ${err.name}]` : "[function]";
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function extractStatusCode(err: unknown): number | null {
  if (!isRecord(err)) {
    return null;
  }
  const parseStatusCode = (value: unknown): number | null => {
    if (typeof value === "number") {
      return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d{3}$/.test(trimmed)) {
        return null;
      }
      const parsed = Number(trimmed);
      return parsed >= 100 && parsed <= 599 ? parsed : null;
    }
    return null;
  };
  const direct = err.statusCode ?? err.status;
  const directStatus = parseStatusCode(direct);
  if (directStatus !== null) {
    return directStatus;
  }

  const response = err.response;
  if (isRecord(response)) {
    const responseStatus = parseStatusCode(response.status);
    if (responseStatus !== null) {
      return responseStatus;
    }
  }

  return null;
}

function extractErrorCode(err: unknown): string | null {
  if (!isRecord(err)) {
    return null;
  }

  const direct = err.code;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const response = err.response;
  if (!isRecord(response)) {
    return null;
  }

  const body = response.body;
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.code === "string" && error.code.trim()) {
      return error.code;
    }
  }

  return null;
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!isRecord(err)) {
    return null;
  }

  const direct = err.retryAfterMs ?? err.retry_after_ms;
  const directMs = asFiniteNumberInRange(direct, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (directMs !== undefined) {
    return directMs;
  }

  const retryAfter = err.retryAfter ?? err.retry_after;
  const retryAfterSeconds = asFiniteNumberInRange(retryAfter, {
    min: 0,
    max: MAX_SAFE_RETRY_AFTER_SECONDS,
  });
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds * 1000;
  }
  if (typeof retryAfter === "string") {
    const parsed = parseNonNegativeRetryAfterSeconds(retryAfter);
    if (parsed !== undefined) {
      return parsed * 1000;
    }
  }

  const response = err.response;
  if (!isRecord(response)) {
    return null;
  }

  const headers = response.headers;
  if (!headers) {
    return null;
  }

  if (isRecord(headers)) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string") {
      const parsed = parseRetryAfterHeaderSeconds(raw);
      if (parsed !== undefined) {
        return parsed * 1000;
      }
    }
  }

  // Fetch Headers-like interface
  if (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
    if (raw) {
      const parsed = parseRetryAfterHeaderSeconds(raw);
      if (parsed !== undefined) {
        return parsed * 1000;
      }
    }
  }

  return null;
}

function parseNonNegativeRetryAfterSeconds(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  return asFiniteNumberInRange(parseStrictFiniteNumber(trimmed), {
    min: 0,
    max: MAX_SAFE_RETRY_AFTER_SECONDS,
  });
}

type MSTeamsSendErrorMetadata = {
  statusCode?: number;
  errorCode?: string;
};

type MSTeamsSendErrorClassification =
  | (MSTeamsSendErrorMetadata & { kind: "auth" })
  | (MSTeamsSendErrorMetadata & {
      kind: "replay-safe";
      statusCode: 429;
      retryAfterMs?: number;
    })
  | (MSTeamsSendErrorMetadata & {
      kind: "ambiguous";
      source: "http" | "transport";
    })
  | (MSTeamsSendErrorMetadata & { kind: "permanent" })
  | (MSTeamsSendErrorMetadata & { kind: "unknown" });

/**
 * Owns retry safety and delivery ambiguity for Teams send failures.
 * Only Teams rate-limit rejection proves this unkeyed POST safe to replay.
 */
export function classifyMSTeamsSendError(err: unknown): MSTeamsSendErrorClassification {
  const statusCode = extractStatusCode(err);
  const retryAfterMs = extractRetryAfterMs(err);
  const errorCode = extractErrorCode(err) ?? undefined;

  if (statusCode === 401) {
    return { kind: "auth", statusCode, errorCode };
  }

  if (statusCode === 403) {
    if (errorCode === "ContentStreamNotAllowed") {
      return { kind: "permanent", statusCode, errorCode };
    }
    return { kind: "auth", statusCode, errorCode };
  }

  if (statusCode === 429) {
    return {
      kind: "replay-safe",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
      errorCode,
    };
  }

  if (statusCode === 408 || (statusCode != null && statusCode >= 500)) {
    return {
      kind: "ambiguous",
      source: "http",
      statusCode,
      errorCode,
    };
  }

  if (statusCode != null && statusCode >= 400) {
    return { kind: "permanent", statusCode, errorCode };
  }

  // A transport failure can happen after the Connector accepted the POST.
  // Preserve its code for diagnostics without implying replay is safe.
  if (statusCode == null && isTransientNetworkError(err)) {
    return { kind: "ambiguous", source: "transport", errorCode };
  }

  return {
    kind: "unknown",
    statusCode: statusCode ?? undefined,
    errorCode,
  };
}

/**
 * Detect whether an error is caused by a revoked Proxy.
 *
 * The Bot Framework SDK wraps TurnContext in a Proxy that is revoked once the
 * turn handler returns.  Any later access (e.g. from a debounced callback)
 * throws a TypeError whose message contains the distinctive "proxy that has
 * been revoked" string.
 */
export function isRevokedProxyError(err: unknown): boolean {
  if (!(err instanceof TypeError)) {
    return false;
  }
  return /proxy that has been revoked/i.test(err.message);
}

export function formatMSTeamsSendErrorHint(
  classification: MSTeamsSendErrorClassification,
): string | undefined {
  if (classification.kind === "auth") {
    return "check msteams appId/appPassword/tenantId (or env vars MSTEAMS_APP_ID/MSTEAMS_APP_PASSWORD/MSTEAMS_TENANT_ID)";
  }
  if (classification.errorCode === "ContentStreamNotAllowed") {
    return "Teams expired the content stream; stop streaming earlier and fall back to normal message delivery";
  }
  if (classification.kind === "replay-safe") {
    return "Teams throttled the bot; backing off may help";
  }
  if (classification.kind === "ambiguous") {
    if (classification.source === "transport") {
      return "transport-level failure sending to Teams Bot Connector (smba.trafficmanager.net); the outcome is unknown, so check egress and conversation history before taking further action";
    }
    return "Teams/Bot Framework delivery outcome is unknown; inspect the conversation history before taking further action";
  }
  return undefined;
}

export function formatMSTeamsDeliveryFailureGuidance(
  classification: MSTeamsSendErrorClassification,
): string | undefined {
  if (classification.kind === "replay-safe") {
    return "The request was rate-limited before delivery; retrying later may succeed.";
  }
  if (classification.kind === "ambiguous") {
    return "Delivery may already have succeeded; do not send the same content again without checking the conversation.";
  }
  return undefined;
}
