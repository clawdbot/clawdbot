const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|missing_scope|cannot_find_service|invalid_token/i;
const SLACK_TOKEN_RE = /\bx(?:app|ox[baprs]?)-[A-Za-z0-9-]+\b/g;
const NO_ERROR_DETAIL = "no error detail";

export const SLACK_SOCKET_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
} as const;

type SlackSocketDisconnectEvent = "disconnect" | "unable_to_socket_mode_start" | "error";

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export function getSocketEmitter(app: unknown): EmitterLike | null {
  const receiver = (app as { receiver?: unknown }).receiver;
  const client =
    receiver && typeof receiver === "object"
      ? (receiver as { client?: unknown }).client
      : undefined;
  if (!client || typeof client !== "object") {
    return null;
  }
  const on = (client as { on?: unknown }).on;
  const off = (client as { off?: unknown }).off;
  if (typeof on !== "function" || typeof off !== "function") {
    return null;
  }
  return {
    on: (event, listener) =>
      (
        on as (this: unknown, event: string, listener: (...args: unknown[]) => void) => unknown
      ).call(client, event, listener),
    off: (event, listener) =>
      (
        off as (this: unknown, event: string, listener: (...args: unknown[]) => void) => unknown
      ).call(client, event, listener),
  };
}

export function waitForSlackSocketDisconnect(
  app: unknown,
  abortSignal?: AbortSignal,
): Promise<{
  event: SlackSocketDisconnectEvent;
  error?: unknown;
}> {
  return new Promise((resolve) => {
    const emitter = getSocketEmitter(app);
    if (!emitter) {
      abortSignal?.addEventListener("abort", () => resolve({ event: "disconnect" }), {
        once: true,
      });
      return;
    }

    const disconnectListener = () => resolveOnce({ event: "disconnect" });
    const startFailListener = (error?: unknown) =>
      resolveOnce({ event: "unable_to_socket_mode_start", error });
    const errorListener = (error: unknown) => resolveOnce({ event: "error", error });
    const abortListener = () => resolveOnce({ event: "disconnect" });

    const cleanup = () => {
      emitter.off("disconnected", disconnectListener);
      emitter.off("unable_to_socket_mode_start", startFailListener);
      emitter.off("error", errorListener);
      abortSignal?.removeEventListener("abort", abortListener);
    };

    const resolveOnce = (value: { event: SlackSocketDisconnectEvent; error?: unknown }) => {
      cleanup();
      resolve(value);
    };

    emitter.on("disconnected", disconnectListener);
    emitter.on("unable_to_socket_mode_start", startFailListener);
    emitter.on("error", errorListener);
    abortSignal?.addEventListener("abort", abortListener, { once: true });
  });
}

/**
 * Detect non-recoverable Slack API / auth errors that should NOT be retried.
 * These indicate permanent credential problems (revoked bot, deactivated account, etc.)
 * and retrying will never succeed — continuing to retry blocks the entire gateway.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return SLACK_AUTH_ERROR_RE.test(formatUnknownError(error, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactSlackSecrets(value: string) {
  return value.replaceAll(SLACK_TOKEN_RE, "[redacted-slack-token]");
}

function addStringDetail(details: string[], label: string, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = redactSlackSecrets(value.trim());
  if (trimmed) {
    details.push(label ? `${label}: ${trimmed}` : trimmed);
  }
}

function addScalarDetail(details: string[], label: string, value: unknown) {
  if (typeof value === "string") {
    addStringDetail(details, label, value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    details.push(`${label}: ${String(value)}`);
  }
}

function safeStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "object" || nested === null) {
        return nested;
      }
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
      return nested;
    });
    return result ? redactSlackSecrets(result) : undefined;
  } catch {
    return undefined;
  }
}

function addSlackResponseMetadata(details: string[], value: unknown) {
  if (!isRecord(value)) {
    return;
  }
  const messages = value.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      addStringDetail(details, "slack message", message);
    }
  }
  const warnings = value.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      addStringDetail(details, "slack warning", warning);
    }
  }
}

function addSlackDataDetails(details: string[], value: unknown) {
  if (!isRecord(value)) {
    return;
  }
  addScalarDetail(details, "slack error", value.error);
  addScalarDetail(details, "needed", value.needed);
  addScalarDetail(details, "provided", value.provided);
  addSlackResponseMetadata(details, value.response_metadata);
}

function addRecordDetails(details: string[], value: Record<string, unknown>) {
  addScalarDetail(details, "code", value.code);
  addScalarDetail(details, "status", value.status);
  addScalarDetail(details, "statusCode", value.statusCode);
  addScalarDetail(details, "errno", value.errno);
  addScalarDetail(details, "syscall", value.syscall);
  addScalarDetail(details, "hostname", value.hostname);
  addScalarDetail(details, "type", value.type);
  addStringDetail(details, "statusText", value.statusText);
  addStringDetail(details, "body", value.body);
  addSlackDataDetails(details, value.data);
  if (isRecord(value.response)) {
    addScalarDetail(details, "response status", value.response.status);
    addStringDetail(details, "response statusText", value.response.statusText);
    addSlackDataDetails(details, value.response.data);
  }
}

function collectErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  if (error === undefined || error === null) {
    return details;
  }
  if (typeof error === "string") {
    addStringDetail(details, "", error);
    return details;
  }
  if (error instanceof Error) {
    addStringDetail(details, "", error.message || error.name);
    if (error.cause !== undefined) {
      const cause = formatUnknownError(error.cause, "");
      if (cause) {
        details.push(`cause: ${cause}`);
      }
    }
  }
  if (isRecord(error)) {
    addRecordDetails(details, error);
    const fallback = safeStringify(error);
    if (details.length === 0 && fallback && fallback !== "{}") {
      details.push(fallback);
    }
  }
  return details;
}

export function formatUnknownError(error: unknown, fallback = NO_ERROR_DETAIL): string {
  const details = collectErrorDetails(error);
  if (details.length > 0) {
    return details.join("; ");
  }
  if (error === undefined || error === null) {
    return fallback;
  }
  if (typeof error === "string" && !error.trim()) {
    return fallback;
  }
  return safeStringify(error) ?? fallback;
}
