import { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { info } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  registerWhatsAppConnectionController,
  unregisterWhatsAppConnectionController,
} from "./connection-controller-registry.js";
import type { ActiveWebListener, WebListenerCloseReason } from "./inbound/types.js";
import { computeBackoff, sleepWithAbort, type ReconnectPolicy } from "./reconnect.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  waitForWaConnection,
} from "./session.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const WHATSAPP_LOGIN_RESTART_MESSAGE =
  "WhatsApp asked for a restart after pairing (code 515); waiting for creds to save…";
export const WHATSAPP_LOGGED_OUT_RELINK_MESSAGE =
  "WhatsApp reported the session is logged out. Cleared cached web session; please rerun openclaw channels login and scan the QR again.";
export const WHATSAPP_LOGGED_OUT_QR_MESSAGE =
  "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";

type TimerHandle = ReturnType<typeof setInterval>;
type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;

export type ManagedWhatsAppListener = ActiveWebListener & {
  close?: () => Promise<void>;
  onClose?: Promise<WebListenerCloseReason>;
  signalClose?: (reason?: WebListenerCloseReason) => void;
};

export type WhatsAppLiveConnection = {
  connectionId: string;
  startedAt: number;
  sock: WASocket;
  listener: ManagedWhatsAppListener;
  heartbeat: TimerHandle | null;
  watchdogTimer: TimerHandle | null;
  lastInboundAt: number | null;
  handledMessages: number;
  unregisterUnhandled: (() => void) | null;
  backgroundTasks: Set<Promise<unknown>>;
  closePromise: Promise<WebListenerCloseReason>;
  resolveClose: (reason: WebListenerCloseReason) => void;
};

export type WhatsAppConnectionSnapshot = {
  connectionId: string;
  startedAt: number;
  lastInboundAt: number | null;
  handledMessages: number;
  reconnectAttempts: number;
  uptimeMs: number;
};

export type NormalizedConnectionCloseReason = {
  statusCode?: number;
  statusLabel: number | "unknown";
  isLoggedOut: boolean;
  error?: unknown;
  errorText: string;
};

export type WhatsAppConnectionCloseDecision = {
  action: "stop" | "retry";
  delayMs?: number;
  reconnectAttempts: number;
  healthState: "logged-out" | "conflict" | "stopped" | "reconnecting";
  normalized: NormalizedConnectionCloseReason;
};

export type WhatsAppReconnectAttemptDecision = {
  action: "stop" | "retry";
  delayMs?: number;
  reconnectAttempts: number;
  healthState: "stopped" | "reconnecting";
};

function createNeverResolvePromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function createLiveConnection(params: {
  connectionId: string;
  sock: WASocket;
  listener: ManagedWhatsAppListener;
}): WhatsAppLiveConnection {
  let closeResolved = false;
  let resolveClosePromise = (_reason: WebListenerCloseReason) => {};
  const closePromise = new Promise<WebListenerCloseReason>((resolve) => {
    resolveClosePromise = (reason: WebListenerCloseReason) => {
      if (closeResolved) {
        return;
      }
      closeResolved = true;
      resolve(reason);
    };
  });

  return {
    connectionId: params.connectionId,
    startedAt: Date.now(),
    sock: params.sock,
    listener: params.listener,
    heartbeat: null,
    watchdogTimer: null,
    lastInboundAt: null,
    handledMessages: 0,
    unregisterUnhandled: null,
    backgroundTasks: new Set<Promise<unknown>>(),
    closePromise,
    resolveClose: resolveClosePromise,
  };
}

export function closeWaSocket(sock: { ws?: { close?: () => void } } | null | undefined): void {
  try {
    sock?.ws?.close?.();
  } catch {
    // ignore best-effort shutdown failures
  }
}

export function closeWaSocketSoon(
  sock: { ws?: { close?: () => void } } | null | undefined,
  delayMs = 500,
): void {
  setTimeout(() => {
    closeWaSocket(sock);
  }, delayMs);
}

export type WhatsAppLoginWaitResult =
  | {
      outcome: "connected";
      restarted: boolean;
      sock: WaSocket;
    }
  | {
      outcome: "logged-out";
      message: string;
      statusCode: number;
      error: unknown;
    }
  | {
      outcome: "failed";
      message: string;
      statusCode?: number;
      error: unknown;
    };

export async function waitForWhatsAppLoginResult(params: {
  sock: WaSocket;
  authDir: string;
  isLegacyAuthDir: boolean;
  verbose: boolean;
  runtime: RuntimeEnv;
  waitForConnection?: typeof waitForWaConnection;
  createSocket?: typeof createWaSocket;
  onQr?: (qr: string) => void;
  onSocketReplaced?: (sock: WaSocket) => void;
}): Promise<WhatsAppLoginWaitResult> {
  const wait = params.waitForConnection ?? waitForWaConnection;
  const createSocket = params.createSocket ?? createWaSocket;
  let currentSock = params.sock;
  let restarted = false;

  while (true) {
    try {
      await wait(currentSock);
      return {
        outcome: "connected",
        restarted,
        sock: currentSock,
      };
    } catch (err) {
      const statusCode = getStatusCode(err);
      if (statusCode === 515 && !restarted) {
        restarted = true;
        params.runtime.log(info(WHATSAPP_LOGIN_RESTART_MESSAGE));
        closeWaSocket(currentSock);
        try {
          currentSock = await createSocket(false, params.verbose, {
            authDir: params.authDir,
            onQr: params.onQr,
          });
          params.onSocketReplaced?.(currentSock);
          continue;
        } catch (createErr) {
          return {
            outcome: "failed",
            message: formatError(createErr),
            statusCode: getStatusCode(createErr),
            error: createErr,
          };
        }
      }

      if (statusCode === LOGGED_OUT_STATUS) {
        await logoutWeb({
          authDir: params.authDir,
          isLegacyAuthDir: params.isLegacyAuthDir,
          runtime: params.runtime,
        });
        return {
          outcome: "logged-out",
          message: WHATSAPP_LOGGED_OUT_RELINK_MESSAGE,
          statusCode: LOGGED_OUT_STATUS,
          error: err,
        };
      }

      return {
        outcome: "failed",
        message: formatError(err),
        statusCode,
        error: err,
      };
    }
  }
}

export class WhatsAppConnectionController {
  readonly accountId: string;
  readonly authDir: string;
  readonly socketRef: { current: WASocket | null };

  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly heartbeatSeconds: number;
  private readonly keepAlive: boolean;
  private readonly messageTimeoutMs: number;
  private readonly watchdogCheckMs: number;
  private readonly verbose: boolean;
  private readonly abortSignal?: AbortSignal;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly isNonRetryableStatus: (statusCode: unknown) => boolean;
  private readonly abortPromise?: Promise<"aborted">;
  private readonly disconnectRetryController = new AbortController();

  private current: WhatsAppLiveConnection | null = null;
  private reconnectAttempts = 0;

  constructor(params: {
    accountId: string;
    authDir: string;
    verbose: boolean;
    keepAlive: boolean;
    heartbeatSeconds: number;
    messageTimeoutMs: number;
    watchdogCheckMs: number;
    reconnectPolicy: ReconnectPolicy;
    abortSignal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    isNonRetryableStatus?: (statusCode: unknown) => boolean;
  }) {
    this.accountId = params.accountId;
    this.authDir = params.authDir;
    this.verbose = params.verbose;
    this.keepAlive = params.keepAlive;
    this.heartbeatSeconds = params.heartbeatSeconds;
    this.messageTimeoutMs = params.messageTimeoutMs;
    this.watchdogCheckMs = params.watchdogCheckMs;
    this.reconnectPolicy = params.reconnectPolicy;
    this.abortSignal = params.abortSignal;
    this.sleep = params.sleep ?? ((ms: number, signal?: AbortSignal) => sleepWithAbort(ms, signal));
    this.isNonRetryableStatus = params.isNonRetryableStatus ?? (() => false);
    this.socketRef = { current: null };
    this.abortPromise =
      params.abortSignal &&
      new Promise<"aborted">((resolve) => {
        params.abortSignal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      });

    if (params.abortSignal?.aborted) {
      this.stopDisconnectRetries();
    } else {
      params.abortSignal?.addEventListener("abort", () => this.stopDisconnectRetries(), {
        once: true,
      });
    }
  }

  getActiveListener(): ActiveWebListener | null {
    return this.current?.listener ?? null;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  isStopRequested(): boolean {
    return this.abortSignal?.aborted === true;
  }

  shouldRetryDisconnect(): boolean {
    return (
      this.keepAlive && !this.isStopRequested() && !this.disconnectRetryController.signal.aborted
    );
  }

  getDisconnectRetryAbortSignal(): AbortSignal {
    return this.disconnectRetryController.signal;
  }

  noteInbound(timestamp = Date.now()): void {
    if (!this.current) {
      return;
    }
    this.current.handledMessages += 1;
    this.current.lastInboundAt = timestamp;
  }

  getCurrentSnapshot(
    connection: WhatsAppLiveConnection | null = this.current,
  ): WhatsAppConnectionSnapshot | null {
    if (!connection) {
      return null;
    }
    return {
      connectionId: connection.connectionId,
      startedAt: connection.startedAt,
      lastInboundAt: connection.lastInboundAt,
      handledMessages: connection.handledMessages,
      reconnectAttempts: this.reconnectAttempts,
      uptimeMs: Date.now() - connection.startedAt,
    };
  }

  setUnhandledRejectionCleanup(unregister: (() => void) | null): void {
    if (!this.current) {
      unregister?.();
      return;
    }
    this.current.unregisterUnhandled?.();
    this.current.unregisterUnhandled = unregister;
  }

  async openConnection(params: {
    connectionId: string;
    createListener: (context: {
      sock: WASocket;
      connection: WhatsAppLiveConnection;
    }) => Promise<ManagedWhatsAppListener>;
    onHeartbeat?: (snapshot: WhatsAppConnectionSnapshot) => void;
    onWatchdogTimeout?: (snapshot: WhatsAppConnectionSnapshot) => void;
  }): Promise<WhatsAppLiveConnection> {
    if (this.current) {
      await this.closeCurrentConnection();
    }

    let sock: WaSocket | null = null;
    let connection: WhatsAppLiveConnection | null = null;
    try {
      sock = await createWaSocket(false, this.verbose, {
        authDir: this.authDir,
      });
      await waitForWaConnection(sock);

      this.socketRef.current = sock;
      const placeholderListener = {} as ManagedWhatsAppListener;
      connection = createLiveConnection({
        connectionId: params.connectionId,
        sock,
        listener: placeholderListener,
      });
      const listener = await params.createListener({ sock, connection });
      connection.listener = listener;
      this.current = connection;
      registerWhatsAppConnectionController(this.accountId, this);
      this.startTimers(connection, {
        onHeartbeat: params.onHeartbeat,
        onWatchdogTimeout: params.onWatchdogTimeout,
      });
      return connection;
    } catch (err) {
      if (this.socketRef.current === sock) {
        this.socketRef.current = null;
      }
      closeWaSocket(sock);
      if (connection?.unregisterUnhandled) {
        connection.unregisterUnhandled();
      }
      throw err;
    }
  }

  async waitForClose(): Promise<WebListenerCloseReason | "aborted"> {
    const connection = this.current;
    if (!connection) {
      return "aborted";
    }
    const listenerClose =
      connection.listener.onClose?.catch((err) => ({
        status: 500,
        isLoggedOut: false,
        error: err,
      })) ?? createNeverResolvePromise<WebListenerCloseReason>();

    return await Promise.race([
      connection.closePromise,
      listenerClose,
      this.abortPromise ?? createNeverResolvePromise<"aborted">(),
    ]);
  }

  normalizeCloseReason(reason: WebListenerCloseReason): NormalizedConnectionCloseReason {
    const statusCode =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? undefined;
    return {
      statusCode,
      statusLabel: typeof statusCode === "number" ? statusCode : "unknown",
      isLoggedOut:
        typeof reason === "object" &&
        reason !== null &&
        "isLoggedOut" in reason &&
        (reason as { isLoggedOut?: boolean }).isLoggedOut === true,
      error: reason?.error,
      errorText: formatError(reason),
    };
  }

  resolveCloseDecision(
    reason: WebListenerCloseReason | "aborted",
  ): WhatsAppConnectionCloseDecision | "aborted" {
    if (reason === "aborted" || this.isStopRequested()) {
      return "aborted";
    }

    const current = this.current;
    if (current && Date.now() - current.startedAt > this.heartbeatSeconds * 1000) {
      this.reconnectAttempts = 0;
    }

    const normalized = this.normalizeCloseReason(reason);
    if (normalized.isLoggedOut) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "logged-out",
        normalized,
      };
    }

    if (this.isNonRetryableStatus(normalized.statusCode)) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "conflict",
        normalized,
      };
    }

    const retryDecision = this.consumeReconnectAttempt();
    if (retryDecision.action === "stop") {
      return {
        action: "stop",
        reconnectAttempts: retryDecision.reconnectAttempts,
        healthState: retryDecision.healthState,
        normalized,
      };
    }

    return {
      action: "retry",
      delayMs: retryDecision.delayMs,
      reconnectAttempts: retryDecision.reconnectAttempts,
      healthState: retryDecision.healthState,
      normalized,
    };
  }

  consumeReconnectAttempt(): WhatsAppReconnectAttemptDecision {
    this.reconnectAttempts += 1;
    if (
      this.reconnectPolicy.maxAttempts > 0 &&
      this.reconnectAttempts >= this.reconnectPolicy.maxAttempts
    ) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "stopped",
      };
    }

    return {
      action: "retry",
      delayMs: computeBackoff(this.reconnectPolicy, this.reconnectAttempts),
      reconnectAttempts: this.reconnectAttempts,
      healthState: "reconnecting",
    };
  }

  forceClose(reason: WebListenerCloseReason): void {
    const connection = this.current;
    if (!connection) {
      return;
    }
    connection.resolveClose(reason);
    connection.listener.signalClose?.(reason);
  }

  async closeCurrentConnection(): Promise<void> {
    const connection = this.current;
    if (!connection) {
      return;
    }
    this.current = null;

    if (this.socketRef.current === connection.sock) {
      this.socketRef.current = null;
    }
    connection.unregisterUnhandled?.();
    if (connection.heartbeat) {
      clearInterval(connection.heartbeat);
    }
    if (connection.watchdogTimer) {
      clearInterval(connection.watchdogTimer);
    }
    if (connection.backgroundTasks.size > 0) {
      await Promise.allSettled(connection.backgroundTasks);
      connection.backgroundTasks.clear();
    }
    try {
      await connection.listener.close?.();
    } catch {
      // best-effort close
    }
    closeWaSocket(connection.sock);
  }

  async waitBeforeRetry(delayMs: number): Promise<void> {
    await this.sleep(delayMs, this.abortSignal);
  }

  async shutdown(): Promise<void> {
    this.stopDisconnectRetries();
    await this.closeCurrentConnection();
    unregisterWhatsAppConnectionController(this.accountId, this);
  }

  private startTimers(
    connection: WhatsAppLiveConnection,
    hooks: {
      onHeartbeat?: (snapshot: WhatsAppConnectionSnapshot) => void;
      onWatchdogTimeout?: (snapshot: WhatsAppConnectionSnapshot) => void;
    },
  ): void {
    if (!this.keepAlive) {
      return;
    }

    connection.heartbeat = setInterval(() => {
      const snapshot = this.getCurrentSnapshot(connection);
      if (!snapshot) {
        return;
      }
      hooks.onHeartbeat?.(snapshot);
    }, this.heartbeatSeconds * 1000);

    connection.watchdogTimer = setInterval(() => {
      const baselineAt = connection.lastInboundAt ?? connection.startedAt;
      const staleForMs = Date.now() - baselineAt;
      if (staleForMs <= this.messageTimeoutMs) {
        return;
      }
      const snapshot = this.getCurrentSnapshot(connection);
      if (!snapshot) {
        return;
      }
      hooks.onWatchdogTimeout?.(snapshot);
      this.forceClose({
        status: 499,
        isLoggedOut: false,
        error: "watchdog-timeout",
      });
    }, this.watchdogCheckMs);
  }

  private stopDisconnectRetries(): void {
    if (!this.disconnectRetryController.signal.aborted) {
      this.disconnectRetryController.abort();
    }
  }
}
