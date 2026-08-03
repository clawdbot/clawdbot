// Slack plugin module implements reconnect policy behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;
const NO_ERROR_DETAIL = "no error detail";

export const SLACK_SOCKET_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

type SlackSocketDisconnectEvent = "disconnect" | "unable_to_socket_mode_start" | "error";

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL =
  "https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections";
const SLACK_SOCKET_HELLO_MARKER = Buffer.from('"hello"');

function getSocketEmitter(app: unknown): EmitterLike | null {
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

function isBufferArray(value: unknown): value is Buffer[] {
  return Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry));
}

function resolveSlackSocketModeConnectionCount(message: unknown): number | undefined {
  const buffer =
    typeof message === "string"
      ? Buffer.from(message)
      : Buffer.isBuffer(message)
        ? message
        : message instanceof ArrayBuffer
          ? Buffer.from(message)
          : isBufferArray(message)
            ? Buffer.concat(message)
            : undefined;
  if (!buffer?.includes(SLACK_SOCKET_HELLO_MARKER)) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  const count = isRecord(payload) && payload.type === "hello" ? payload.num_connections : undefined;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function formatSlackSocketModeSharedConnectionWarning(activeConnections: number): string {
  return [
    `slack socket mode reports ${activeConnections} active connections for this Slack app`,
    "Slack may deliver each event to any one connection",
    "ensure every OpenClaw gateway sharing this app has equivalent routing and authorization, or use a separate Slack app per gateway, one relay ingress, or HTTP Request URLs behind a load balancer",
    `See ${SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL}`,
  ].join("; ");
}

export function registerSlackSocketModeConnectionDiagnostics(params: {
  app: unknown;
  onSharedConnection: (activeConnections: number) => void;
}): () => void {
  const emitter = getSocketEmitter(params.app);
  if (!emitter) {
    return () => {};
  }
  let hasWarned = false;
  const listener = (message: unknown, isBinary?: unknown) => {
    if (isBinary === true || hasWarned) {
      return;
    }
    const activeConnections = resolveSlackSocketModeConnectionCount(message);
    if (activeConnections === undefined || activeConnections <= 1) {
      return;
    }
    hasWarned = true;
    params.onSharedConnection(activeConnections);
  };
  emitter.on("ws_message", listener);
  return () => {
    emitter.off("ws_message", listener);
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
 * Detect permanent Slack account and credential failures.
 * Transient request and HTTP failures stay in OpenClaw's reconnect loop.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return SLACK_AUTH_ERROR_RE.test(formatUnknownError(error, ""));
}

export function formatUnknownError(error: unknown, fallback = NO_ERROR_DETAIL): string {
  return formatSlackError(error, fallback);
}
