/**
 * GatewayConnection — WebSocket lifecycle, heartbeat, reconnect, and session persistence.
 *
 * Encapsulates all connection state as class fields (replaces 11 closure variables).
 * Event handling and message processing are delegated to injected handlers.
 */

import WebSocket from "ws";
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
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { ReconnectState } from "./reconnect.js";
import type { GatewayAccount, EngineLogger, GatewayPluginRuntime, WSPayload } from "./types.js";

// ============ Connection context ============

interface GatewayConnectionContext {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  log?: EngineLogger;
  runtime: GatewayPluginRuntime;
  onReady?: (data: unknown) => void;
  /** Called when a RESUMED event is received (reconnect success). */
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  /** Process a queued message (inbound pipeline → outbound dispatch). */
  handleMessage: (event: QueuedMessage) => Promise<void>;
  /** Called when an INTERACTION_CREATE event is received (e.g. approval button clicks). */
  onInteraction?: (event: InteractionEvent) => void;
}

// ============ GatewayConnection ============

export class GatewayConnection {
  // ---- Connection state ----
  private isAborted = false;
  private currentWs: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRefreshToken = false;

  private readonly reconnect: ReconnectState;
  private readonly msgQueue;
  private readonly ctx: GatewayConnectionContext;

  constructor(ctx: GatewayConnectionContext) {
    this.ctx = ctx;
    this.reconnect = new ReconnectState(ctx.account.accountId, ctx.log);
    this.msgQueue = createMessageQueue({
      accountId: ctx.account.accountId,
      log: ctx.log,
      isAborted: () => this.isAborted,
    });
  }

  /** Start the connection loop. Resolves when abortSignal fires. */
  async start(): Promise<void> {
    this.restoreSession();
    this.registerAbortHandler();
    await this.connect();
    return new Promise<void>((resolve) => {
      this.ctx.abortSignal.addEventListener("abort", () => resolve());
    });
  }

  // ============ Session persistence ============

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

  // ============ Abort + cleanup ============

  private registerAbortHandler(): void {
    const { account, abortSignal, log: _log } = this.ctx;
    abortSignal.addEventListener("abort", () => {
      this.isAborted = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.cleanup();
      stopBackgroundTokenRefresh(account.appId);
      flushKnownUsers();
      flushRefIndex();
    });
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

  // ============ Reconnect ============

  private scheduleReconnect(customDelay?: number): void {
    const { account: _account, log } = this.ctx;
    if (this.isAborted || this.reconnect.isExhausted()) {
      log?.error(`Max reconnect attempts reached or aborted`);
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

  // ============ Connect ============

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

      const ws = new WebSocket(gatewayUrl, {
        headers: { "User-Agent": getPluginUserAgent() },
      });
      this.currentWs = ws;

      // ---- Slash command interception ----
      const slashCtx: SlashCommandHandlerContext = {
        account,
        log,
        getMessagePeerId: (msg) => this.msgQueue.getMessagePeerId(msg),
        getQueueSnapshot: (peerId) => this.msgQueue.getSnapshot(peerId),
      };

      const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
        const result = await trySlashCommand(msg, slashCtx);
        if (result === "enqueue") {
          this.msgQueue.enqueue(msg);
        } else if (result === "urgent") {
          const peerId = this.msgQueue.getMessagePeerId(msg);
          this.msgQueue.clearUserQueue(peerId);
          this.msgQueue.executeImmediate(msg);
        }
        // "handled" — command executed, nothing to queue.
      };

      // ---- WebSocket: open ----
      ws.on("open", () => {
        log?.info(`WebSocket connected`);
        this.isConnecting = false;
        this.reconnect.onConnected();
        this.msgQueue.startProcessor(this.ctx.handleMessage);
        startBackgroundTokenRefresh(account.appId, account.clientSecret, { log });
      });

      // ---- WebSocket: message ----
      ws.on("message", async (data) => {
        try {
          const rawData = decodeGatewayMessageData(data);
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            this.lastSeq = s;
            this.saveCurrentSession();
          }

          switch (op) {
            case GatewayOp.HELLO:
              this.handleHello(ws, d, accessToken);
              break;

            case GatewayOp.DISPATCH: {
              log?.debug?.(`Dispatch event: t=${t}, d=${JSON.stringify(d)}`);
              const result = dispatchEvent(t ?? "", d, account.accountId, log);
              if (result.action === "ready") {
                this.sessionId = result.sessionId;
                this.saveCurrentSession();
                this.ctx.onReady?.(result.data);
              } else if (result.action === "resumed") {
                (this.ctx.onResumed ?? this.ctx.onReady)?.(result.data);
                this.saveCurrentSession();
              } else if (result.action === "interaction") {
                this.ctx.onInteraction?.(result.event);
              } else if (result.action === "message") {
                void trySlashCommandOrEnqueue(result.msg);
              }
              break;
            }

            case GatewayOp.HEARTBEAT_ACK:
              break;

            case GatewayOp.RECONNECT:
              this.cleanup();
              this.scheduleReconnect();
              break;

            case GatewayOp.INVALID_SESSION: {
              const canResume = d as boolean;
              if (!canResume) {
                this.sessionId = null;
                this.lastSeq = null;
                clearSession(account.accountId);
                this.shouldRefreshToken = true;
              }
              this.cleanup();
              this.scheduleReconnect(3000);
              break;
            }
          }
        } catch (err) {
          log?.error(`Message parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      // ---- WebSocket: close ----
      ws.on("close", (code, reason) => {
        log?.info(`WebSocket closed: ${code} ${reason.toString()}`);
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

    if (action.fatal) {
      return;
    }
    if (action.shouldReconnect) {
      this.scheduleReconnect(action.reconnectDelay);
    }
  }
}
