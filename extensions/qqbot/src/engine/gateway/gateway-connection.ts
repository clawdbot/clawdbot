// Qqbot plugin module implements gateway connection behavior.
import WebSocket from "ws";
import type { EngineAdapters } from "../adapter/index.js";
import {
  trySlashCommand,
  type SlashCommandHandlerContext,
} from "../commands/slash-command-handler.js";
import {
  clearTokenCache,
  getAccessToken,
  getGatewayUrl,
  getPluginUserAgent,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from "../messaging/sender.js";
import { flushRefIndex } from "../ref/store.js";
import { flushKnownUsers } from "../session/known-users.js";
import { clearSession, loadSession, saveSession } from "../session/session-store.js";
import type { InteractionEvent } from "../types.js";
import { decodeGatewayMessageData } from "./codec.js";
import { FULL_INTENTS, RATE_LIMIT_DELAY, GatewayOp } from "./constants.js";
import { dispatchEvent } from "./event-dispatcher.js";
import { createQQBotIngressEffectOnce } from "./ingress-effects.js";
import { isQQBotTurnEventType } from "./ingress-envelope.js";
import {
  createQQBotIngressMonitor,
  QQBotIngressAdmissionError,
  type QQBotIngressDispatchResult,
  type QQBotIngressMonitor,
} from "./ingress.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { ReconnectState } from "./reconnect.js";
import type {
  GatewayAccount,
  EngineLogger,
  GatewayPluginRuntime,
  QQBotIngressLifecycle,
  WSPayload,
} from "./types.js";
import { createQQWSClient } from "./ws-client.js";

interface GatewayConnectionContext {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  log?: EngineLogger;
  runtime: GatewayPluginRuntime;
  adapters: EngineAdapters;
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  onDisconnected?: (info: { reason?: string; fatal?: boolean }) => void;
  handleMessage: (event: QueuedMessage) => Promise<void>;
  onInteraction?: (event: InteractionEvent) => void;
  createIngressMonitor?: typeof createQQBotIngressMonitor;
}

export class GatewayConnection {
  private isAborted = false;
  private currentWs: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRefreshToken = false;
  private ingress: QQBotIngressMonitor | undefined;
  private socketMessageTail: Promise<void> = Promise.resolve();
  private shutdownTask: Promise<void> | undefined;
  private readonly failedIngressSockets = new WeakSet<WebSocket>();

  private readonly reconnect: ReconnectState;
  private readonly msgQueue;
  private readonly ingressEffectOnce;
  private readonly ctx: GatewayConnectionContext;

  constructor(ctx: GatewayConnectionContext) {
    this.ctx = ctx;
    this.reconnect = new ReconnectState(ctx.account.accountId, ctx.log);
    this.msgQueue = createMessageQueue({
      accountId: ctx.account.accountId,
      log: ctx.log,
      isAborted: () => this.isAborted,
    });
    this.ingressEffectOnce = createQQBotIngressEffectOnce({
      accountId: ctx.account.accountId,
      log: ctx.log,
    });
  }

  async start(): Promise<void> {
    this.restoreSession();
    this.msgQueue.startProcessor(this.ctx.handleMessage);
    const slashCtx = this.createSlashCommandContext();
    const createIngressMonitor = this.ctx.createIngressMonitor ?? createQQBotIngressMonitor;
    this.ingress = createIngressMonitor({
      accountId: this.ctx.account.accountId,
      runtime: this.ctx.runtime,
      log: this.ctx.log,
      dispatch: (message, lifecycle, eventId) =>
        this.dispatchIngressMessage(message, lifecycle, eventId, slashCtx),
    });
    const stopped = new Promise<void>((resolve, reject) => {
      const stop = () => void this.shutdown().then(resolve, reject);
      if (this.ctx.abortSignal.aborted) {
        stop();
        return;
      }
      this.ctx.abortSignal.addEventListener("abort", stop, { once: true });
    });
    // Observe shutdown immediately: abort can reject while the initial connection is still pending.
    const stoppedResult = stopped.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!this.isAborted) {
      await this.connect();
    }
    const result = await stoppedResult;
    if (!result.ok) {
      throw result.error;
    }
  }

  private restoreSession(): void {
    const { account, log } = this.ctx;
    const saved = loadSession(account.accountId, account.appId);
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastSeq = saved.lastSeq;
      log?.info(`Restored session: sessionId=${this.sessionId}, lastSeq=${this.lastSeq}`);
    }
  }

  private saveCurrentSession(): void {
    const { account } = this.ctx;
    if (!this.sessionId) {
      return;
    }
    saveSession({
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      lastConnectedAt: Date.now(),
      intentLevelIndex: 0,
      accountId: account.accountId,
      savedAt: Date.now(),
      appId: account.appId,
    });
  }

  private shutdown(): Promise<void> {
    this.shutdownTask ??= (async () => {
      const { account } = this.ctx;
      const errors: unknown[] = [];
      const runCleanup = async (
        label: string,
        cleanup: () => void | Promise<void>,
      ): Promise<void> => {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
          this.ctx.log?.error(`QQBot gateway shutdown ${label} failed: ${String(error)}`);
        }
      };
      this.isAborted = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      await runCleanup("socket cleanup", () => this.cleanup());
      await runCleanup("ingress stop", () => this.ingress?.stop());
      await runCleanup("socket drain", () => this.socketMessageTail);
      await runCleanup("message queue stop", () => this.msgQueue.stop());
      await runCleanup("token refresh stop", () => stopBackgroundTokenRefresh(account.appId));
      await runCleanup("known-user flush", () => flushKnownUsers());
      await runCleanup("reference-index flush", () => flushRefIndex());
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "QQBot gateway shutdown failed.");
      }
    })();
    return this.shutdownTask;
  }

  private createSlashCommandContext(): SlashCommandHandlerContext {
    const { account, cfg, log, adapters } = this.ctx;
    return {
      account,
      cfg,
      log,
      getMessagePeerId: (msg) => this.msgQueue.getMessagePeerId(msg),
      getQueueSnapshot: (peerId) => this.msgQueue.getSnapshot(peerId),
      resolveCommandAuthorized: (params) =>
        adapters.access.resolveSlashCommandAuthorization({
          cfg,
          accountId: account.accountId,
          ...params,
        }),
    };
  }

  private async dispatchIngressMessage(
    msg: QueuedMessage,
    lifecycle: QQBotIngressLifecycle,
    eventId: string,
    slashCtx: SlashCommandHandlerContext,
  ): Promise<QQBotIngressDispatchResult> {
    if (this.isAborted || lifecycle.abortSignal.aborted) {
      return {
        kind: "failed-retryable",
        error:
          lifecycle.abortSignal.reason ?? this.ctx.abortSignal.reason ?? new Error("QQBot stopped"),
      };
    }
    msg.turnAdoptionLifecycle = lifecycle;
    // Fleet at-least-once contract: a pre-tombstone crash can replay slash commands.
    // Non-idempotent handlers opt into createIngressEffectOnce through this dispatch context.
    const result = await trySlashCommand(msg, slashCtx, {
      eventId,
      effectOnce: this.ingressEffectOnce,
    });
    if (result === "handled") {
      return { kind: "completed" };
    }
    if (this.isAborted || lifecycle.abortSignal.aborted) {
      return {
        kind: "failed-retryable",
        error:
          lifecycle.abortSignal.reason ?? this.ctx.abortSignal.reason ?? new Error("QQBot stopped"),
      };
    }
    if (result === "urgent") {
      const peerId = this.msgQueue.getMessagePeerId(msg);
      this.msgQueue.clearUserQueue(peerId);
      this.msgQueue.executeImmediate(msg);
    } else {
      this.msgQueue.enqueue(msg);
    }
    return { kind: "deferred" };
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (
      this.currentWs &&
      (this.currentWs.readyState === WebSocket.OPEN ||
        this.currentWs.readyState === WebSocket.CONNECTING)
    ) {
      this.currentWs.close();
    }
    this.currentWs = null;
  }

  private scheduleReconnect(customDelay?: number): void {
    const { account: _account, log } = this.ctx;
    if (this.isAborted || this.reconnect.isExhausted()) {
      log?.error(`Max reconnect attempts reached or aborted`);
      // Exhaustion is a permanent give-up: report it as fatal so the
      // channel status does not keep claiming a live connection.
      if (!this.isAborted) {
        this.ctx.onDisconnected?.({ reason: "reconnect attempts exhausted", fatal: true });
      }
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const delay = this.reconnect.getNextDelay(customDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isAborted) {
        void this.connect();
      }
    }, delay);
  }

  private async connect(): Promise<void> {
    const { account, log } = this.ctx;

    if (this.isConnecting) {
      log?.debug?.(`Already connecting, skip`);
      return;
    }
    this.isConnecting = true;

    try {
      this.cleanup();
      if (this.shouldRefreshToken) {
        log?.debug?.(`Refreshing token...`);
        clearTokenCache(account.appId);
        this.shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken, account.appId);
      log?.info(`Connecting to ${gatewayUrl}`);
      const ws = await createQQWSClient({
        gatewayUrl,
        userAgent: getPluginUserAgent(),
      });
      this.currentWs = ws;

      // ---- WebSocket: open ----
      ws.on("open", () => {
        log?.info(`WebSocket connected`);
        this.isConnecting = false;
        this.reconnect.onConnected();
        startBackgroundTokenRefresh(account.appId, account.clientSecret, { log });
      });

      // ---- WebSocket: message ----
      ws.on("message", (data) => {
        this.socketMessageTail = this.socketMessageTail
          .then(() => this.handleSocketMessage(ws, data, accessToken))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof QQBotIngressAdmissionError) {
              log?.error(`Durable ingress failed; terminating gateway socket: ${message}`);
              this.ctx.onError?.(error);
              if (this.currentWs === ws) {
                // Fence callbacks already queued behind the failed append before
                // terminate emits close and starts the reconnect path.
                this.failedIngressSockets.add(ws);
                ws.terminate();
              }
              return;
            }
            log?.error(`Message parse error: ${message}`);
          });
      });

      // ---- WebSocket: close ----
      ws.on("close", (code, reason) => {
        log?.info(`WebSocket closed: ${code} ${reason.toString()}`);
        // cleanup() clears currentWs before a server-driven reconnect. Ignore
        // the old socket's delayed close both during that gap and after the
        // replacement is live, or it can reschedule reconnect handling.
        if (this.currentWs !== ws) {
          return;
        }
        this.isConnecting = false;
        this.handleClose(code);
      });

      // ---- WebSocket: error ----
      ws.on("error", (err) => {
        log?.error(`WebSocket error: ${err.message}`);
        this.ctx.onError?.(err);
      });
    } catch (err) {
      this.isConnecting = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`Connection failed: ${errMsg}`);
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        this.scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        this.scheduleReconnect();
      }
    }
  }

  private async handleSocketMessage(
    ws: WebSocket,
    data: unknown,
    accessToken: string,
  ): Promise<void> {
    if (this.isAborted || this.currentWs !== ws || this.failedIngressSockets.has(ws)) {
      return;
    }
    const rawData = decodeGatewayMessageData(data);
    const payload = JSON.parse(rawData) as WSPayload;
    const { op, d, s, t } = payload;
    let saveAfterDispatch = false;

    switch (op) {
      case GatewayOp.HELLO:
        this.handleHello(ws, d, accessToken);
        break;

      case GatewayOp.DISPATCH: {
        this.ctx.log?.debug?.(`Dispatch event: t=${t}, d=${JSON.stringify(d)}`);
        if (isQQBotTurnEventType(t)) {
          if (!this.ingress) {
            throw new Error("QQBot ingress monitor is unavailable.");
          }
          // Resume sequence advances only after the raw turn is durable.
          await this.ingress.receive(rawData);
        } else {
          const result = dispatchEvent(t ?? "", d, this.ctx.account.accountId, this.ctx.log);
          if (result.action === "ready") {
            this.sessionId = result.sessionId;
            saveAfterDispatch = true;
            this.ctx.onReady?.(result.data);
          } else if (result.action === "resumed") {
            (this.ctx.onResumed ?? this.ctx.onReady)?.(result.data);
            saveAfterDispatch = true;
          } else if (result.action === "interaction") {
            this.ctx.onInteraction?.(result.event);
          }
        }
        break;
      }

      case GatewayOp.HEARTBEAT_ACK:
        break;

      case GatewayOp.RECONNECT:
        this.ctx.onDisconnected?.({ reason: "server requested reconnect", fatal: false });
        this.cleanup();
        this.scheduleReconnect();
        break;

      case GatewayOp.INVALID_SESSION: {
        const canResume = d as boolean;
        this.ctx.onDisconnected?.({
          reason: canResume ? "session resume rejected" : "session invalidated",
          fatal: false,
        });
        if (!canResume) {
          this.sessionId = null;
          this.lastSeq = null;
          clearSession(this.ctx.account.accountId);
          this.shouldRefreshToken = true;
        }
        this.cleanup();
        this.scheduleReconnect(3000);
        break;
      }
    }

    if (typeof s === "number") {
      this.lastSeq = s;
      saveAfterDispatch = true;
    }
    if (saveAfterDispatch) {
      this.saveCurrentSession();
    }
  }

  // ============ Protocol handlers ============

  private handleHello(ws: WebSocket, d: unknown, accessToken: string): void {
    if (this.sessionId && this.lastSeq !== null) {
      ws.send(
        JSON.stringify({
          op: GatewayOp.RESUME,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          op: GatewayOp.IDENTIFY,
          d: {
            token: `QQBot ${accessToken}`,
            intents: FULL_INTENTS,
            shard: [0, 1],
          },
        }),
      );
    }

    const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this.lastSeq }));
      }
    }, interval);
  }

  private handleClose(code: number): void {
    const { account } = this.ctx;
    const action = this.reconnect.handleClose(code, this.isAborted);

    if (action.clearSession) {
      this.sessionId = null;
      this.lastSeq = null;
      clearSession(account.accountId);
    }
    if (action.refreshToken) {
      this.shouldRefreshToken = true;
    }

    this.cleanup();

    // Publish the disconnect so channel status stops claiming a live
    // connection; a fatal close (bot banned / offline) never reconnects.
    // Abort-driven closes are an intentional stop, not a status change.
    if (!this.isAborted) {
      this.ctx.onDisconnected?.({ reason: action.reason, fatal: action.fatal });
    }

    if (action.fatal) {
      return;
    }
    if (action.shouldReconnect) {
      this.scheduleReconnect(action.reconnectDelay);
    }
  }
}
