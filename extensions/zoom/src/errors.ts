export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") return err.description ?? err.toString();
  if (typeof err === "function") {
    return err.name ? `[function ${err.name}]` : "[function]";
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractStatusCode(err: unknown): number | null {
  if (!isRecord(err)) return null;
  const direct = err.statusCode ?? err.status;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string") {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const response = err.response;
  if (isRecord(response)) {
    const status = response.status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
    if (typeof status === "string") {
      const parsed = Number.parseInt(status, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!isRecord(err)) return null;

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
    if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  }

  const response = err.response;
  if (!isRecord(response)) return null;

  const headers = response.headers;
  if (!headers) return null;

  if (isRecord(headers)) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
    }
  }

  if (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
    if (raw) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
    }
  }

  return null;
}

export type ZoomSendErrorKind = "auth" | "throttled" | "transient" | "permanent" | "unknown";

export type ZoomSendErrorClassification = {
  kind: ZoomSendErrorKind;
  statusCode?: number;
  retryAfterMs?: number;
};

/**
 * Classify outbound send errors for safe retries and actionable logs.
 */
export function classifyZoomSendError(err: unknown): ZoomSendErrorClassification {
  const statusCode = extractStatusCode(err);
  const retryAfterMs = extractRetryAfterMs(err);

  if (statusCode === 401 || statusCode === 403) {
    return { kind: "auth", statusCode };
  }

  if (statusCode === 429) {
    return {
      kind: "throttled",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
    };
  }

  if (statusCode === 408 || (statusCode != null && statusCode >= 500)) {
    return {
      kind: "transient",
      statusCode,
      retryAfterMs: retryAfterMs ?? undefined,
    };
  }

  if (statusCode != null && statusCode >= 400) {
    return { kind: "permanent", statusCode };
  }

  return {
    kind: "unknown",
    statusCode: statusCode ?? undefined,
    retryAfterMs: retryAfterMs ?? undefined,
  };
}

export function formatZoomSendErrorHint(
  classification: ZoomSendErrorClassification,
): string | undefined {
  if (classification.kind === "auth") {
    return "check zoom clientId/clientSecret/accountId (or env vars ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET/ZOOM_ACCOUNT_ID)";
  }
  if (classification.kind === "throttled") {
    return "Zoom throttled the bot; backing off may help";
  }
  if (classification.kind === "transient") {
    return "transient Zoom API error; retry may succeed";
  }
  return undefined;
}
