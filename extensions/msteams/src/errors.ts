function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const direct = err.statusCode ?? err.status;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === "string") {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const response = err.response;
  if (isRecord(response)) {
    const status = response.status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
    if (typeof status === "string") {
      const parsed = Number.parseInt(status, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
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
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return direct;
  }

  const retryAfter = err.retryAfter ?? err.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return retryAfter >= 0 ? retryAfter * 1000 : null;
  }
  if (typeof retryAfter === "string") {
    const parsed = Number.parseFloat(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
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
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
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
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed * 1000;
      }
    }
  }

  return null;
}

type MSTeamsSendErrorKind = "auth" | "throttled" | "transient" | "permanent" | "unknown";

type MSTeamsSendErrorClassification = {
  kind: MSTeamsSendErrorKind;
  statusCode?: number;
  retryAfterMs?: number;
  errorCode?: string;
};

/**
 * Classify outbound send errors for safe retries and actionable logs.
 *
 * Important: We only mark errors as retryable when we have an explicit HTTP
 * status code that indicates the message was not accepted (e.g. 429, 5xx).
 * For transport-level errors where delivery is ambiguous, we prefer to avoid
 * retries to reduce the chance of duplicate posts.
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
      kind: "throttled",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
      errorCode,
    };
  }

  if (statusCode === 408 || (statusCode != null && statusCode >= 500)) {
    return {
      kind: "transient",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
      errorCode,
    };
  }

  if (statusCode != null && statusCode >= 400) {
    return { kind: "permanent", statusCode, errorCode };
  }

  return {
    kind: "unknown",
    statusCode: statusCode ?? undefined,
    retryAfterMs: retryAfterMs ?? undefined,
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
  if (classification.kind === "throttled") {
    return "Teams throttled the bot; backing off may help";
  }
  if (classification.kind === "transient") {
    return "transient Teams/Bot Framework error; retry may succeed";
  }
  return undefined;
}
