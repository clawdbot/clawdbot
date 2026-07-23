// Slack plugin module implements reconnect policy behavior.
import { channel } from "node:diagnostics_channel";
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

/** Throttle status-store writes for transport keepalive frames. */
export const SLACK_SOCKET_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS = 30_000;

/**
 * Upper bound for the reconnect supervisor's disconnect waiter when Socket Mode
 * stops emitting disconnect/error events (zombie WSS). Keepalive frames reset
 * this idle window so quiet-but-alive workspaces do not false-reconnect.
 */
export const SLACK_SOCKET_DISCONNECT_IDLE_TIMEOUT_MS = 120_000;

type SlackSocketDisconnectEvent =
  | "disconnect"
  | "unable_to_socket_mode_start"
  | "error"
  | "transport_idle";

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type DiagnosticsChannelLike = {
  subscribe: (listener: (message: unknown) => void) => void;
  unsubscribe: (listener: (message: unknown) => void) => void;
};

const SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL =
  "https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections";
const SLACK_SOCKET_HELLO_MARKER = Buffer.from('"hello"');
const UNDICI_WEBSOCKET_PING_CHANNEL = "undici:websocket:ping";
const UNDICI_WEBSOCKET_PONG_CHANNEL = "undici:websocket:pong";

function getSocketClient(app: unknown): object | null {
  const receiver = (app as { receiver?: unknown }).receiver;
  const client =
    receiver && typeof receiver === "object"
      ? (receiver as { client?: unknown }).client
      : undefined;
  if (!client || typeof client !== "object") {
    return null;
  }
  return client;
}

function getSocketEmitter(app: unknown): EmitterLike | null {
  const client = getSocketClient(app);
  if (!client) {
    return null;
  }
  const on = Reflect.get(client, "on");
  const off = Reflect.get(client, "off");
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

function resolveUndiciWebSocket(app: unknown): object | null {
  const client = getSocketClient(app);
  if (!client) {
    return null;
  }
  const slackWebSocket = Reflect.get(client, "websocket");
  if (!slackWebSocket || typeof slackWebSocket !== "object") {
    return null;
  }
  const undiciWebSocket = Reflect.get(slackWebSocket, "websocket");
  return undiciWebSocket && typeof undiciWebSocket === "object" ? undiciWebSocket : null;
}

function isUndiciPingPongMessage(
  message: unknown,
): message is { websocket: object; payload: Buffer } {
  if (!message || typeof message !== "object") {
    return false;
  }
  const websocket = Reflect.get(message, "websocket");
  const payload = Reflect.get(message, "payload");
  return Boolean(websocket && typeof websocket === "object" && Buffer.isBuffer(payload));
}

function getDiagnosticsChannel(name: string): DiagnosticsChannelLike | null {
  try {
    const diagnosticsChannel = channel(name) as DiagnosticsChannelLike;
    if (
      typeof diagnosticsChannel.subscribe !== "function" ||
      typeof diagnosticsChannel.unsubscribe !== "function"
    ) {
      return null;
    }
    return diagnosticsChannel;
  } catch {
    return null;
  }
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

/**
 * Observe Socket Mode transport liveness (connect/hello/ws frames + undici ping/pong).
 * App inbound events are intentionally excluded — those update lastEventAt/lastInboundAt.
 */
export function registerSlackSocketModeTransportActivity(params: {
  app: unknown;
  onTransportActivity: (at: number) => void;
}): () => void {
  const emitter = getSocketEmitter(params.app);
  if (!emitter) {
    return () => {};
  }

  const noteActivity = () => {
    params.onTransportActivity(Date.now());
  };

  const wsMessageListener = (_message: unknown, isBinary?: unknown) => {
    if (isBinary === true) {
      return;
    }
    noteActivity();
  };
  const connectedListener = () => {
    noteActivity();
  };

  const pingChannel = getDiagnosticsChannel(UNDICI_WEBSOCKET_PING_CHANNEL);
  const pongChannel = getDiagnosticsChannel(UNDICI_WEBSOCKET_PONG_CHANNEL);
  const pingPongListener = (message: unknown) => {
    if (!isUndiciPingPongMessage(message)) {
      return;
    }
    const ownedWebSocket = resolveUndiciWebSocket(params.app);
    if (ownedWebSocket && message.websocket !== ownedWebSocket) {
      return;
    }
    // When the undici socket handle is not yet exposed, still accept ping/pong
    // while this Socket Mode client exists (single-socket and test harnesses).
    noteActivity();
  };

  emitter.on("ws_message", wsMessageListener);
  emitter.on("connected", connectedListener);
  pingChannel?.subscribe(pingPongListener);
  pongChannel?.subscribe(pingPongListener);

  return () => {
    emitter.off("ws_message", wsMessageListener);
    emitter.off("connected", connectedListener);
    pingChannel?.unsubscribe(pingPongListener);
    pongChannel?.unsubscribe(pingPongListener);
  };
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
  options?: {
    idleTimeoutMs?: number;
  },
): Promise<{
  event: SlackSocketDisconnectEvent;
  error?: unknown;
}> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? SLACK_SOCKET_DISCONNECT_IDLE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const emitter = getSocketEmitter(app);
    if (!emitter) {
      abortSignal?.addEventListener("abort", () => resolve({ event: "disconnect" }), {
        once: true,
      });
      return;
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let unregisterTransportActivity: (() => void) | undefined;

    const disconnectListener = () => resolveOnce({ event: "disconnect" });
    const startFailListener = (error?: unknown) =>
      resolveOnce({ event: "unable_to_socket_mode_start", error });
    const errorListener = (error: unknown) => resolveOnce({ event: "error", error });
    const abortListener = () => resolveOnce({ event: "disconnect" });

    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      if (!(idleTimeoutMs > 0) || abortSignal?.aborted) {
        return;
      }
      idleTimer = setTimeout(() => {
        resolveOnce({
          event: "transport_idle",
          error: new Error(
            `Slack Socket Mode transport idle for ${idleTimeoutMs}ms without disconnect event`,
          ),
        });
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    const cleanup = () => {
      clearIdleTimer();
      unregisterTransportActivity?.();
      unregisterTransportActivity = undefined;
      emitter.off("disconnected", disconnectListener);
      emitter.off("unable_to_socket_mode_start", startFailListener);
      emitter.off("error", errorListener);
      abortSignal?.removeEventListener("abort", abortListener);
    };

    const resolveOnce = (value: { event: SlackSocketDisconnectEvent; error?: unknown }) => {
      cleanup();
      resolve(value);
    };

    unregisterTransportActivity = registerSlackSocketModeTransportActivity({
      app,
      onTransportActivity: () => {
        armIdleTimer();
      },
    });

    emitter.on("disconnected", disconnectListener);
    emitter.on("unable_to_socket_mode_start", startFailListener);
    emitter.on("error", errorListener);
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    armIdleTimer();
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
