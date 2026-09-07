// Mattermost plugin module implements monitor websocket behavior.
import { randomUUID } from "node:crypto";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type { ClientOptions, RawData } from "ws";
import { z } from "zod";
import { MattermostPostSchema, type MattermostPost } from "./client.js";
import { rawDataToString } from "./monitor-helpers.js";
import type { ChannelAccountSnapshot, RuntimeEnv } from "./runtime-api.js";
import { WebSocket } from "./ws-runtime.js";

export type MattermostEventPayload = z.infer<typeof MattermostEventPayloadSchema>;

type MattermostWebSocketLike = {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: RawData) => void | Promise<void>): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  ping(): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

type MattermostWebSocketClientOptions = Pick<ClientOptions, "handshakeTimeout" | "maxPayload">;

export type MattermostWebSocketFactory = (
  url: string,
  options: MattermostWebSocketClientOptions,
) => MattermostWebSocketLike;
// Mattermost events can include double-encoded post props plus server/plugin metadata.
// Keep channel-compatible headroom while bounding ws's 100 MiB default before parsing.
const MATTERMOST_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A TCP peer can accept without completing the HTTP upgrade; ws has no default deadline.
const MATTERMOST_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;
// After the challenge the server contract is reply-OK or close; this bounds a
// peer that does neither so the channel cannot sit unauthenticated forever.
const MATTERMOST_WEBSOCKET_AUTH_TIMEOUT_MS = 30_000;
const MattermostEventPayloadSchema = z.object({
  event: z.string().optional(),
  status: z.string().optional(),
  seq_reply: z.number().optional(),
  data: z
    .object({
      // Durable ingress validates the post only after claiming the raw envelope.
      post: z.unknown().optional(),
      reaction: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      channel_id: z.string().optional(),
      channel_name: z.string().optional(),
      channel_display_name: z.string().optional(),
      channel_type: z.string().optional(),
      sender_name: z.string().optional(),
      team_id: z.string().optional(),
    })
    .optional(),
  broadcast: z
    .object({
      channel_id: z.string().optional(),
      team_id: z.string().optional(),
      user_id: z.string().optional(),
    })
    .optional(),
});

export function parseMattermostEventPayload(raw: string): MattermostEventPayload | null {
  return safeParseJsonWithSchema(MattermostEventPayloadSchema, raw);
}

export function parseMattermostPost(value: unknown): MattermostPost | null {
  if (typeof value === "string") {
    return safeParseJsonWithSchema(MattermostPostSchema, value);
  }
  return safeParseWithSchema(MattermostPostSchema, value);
}

class WebSocketClosedBeforeOpenError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason?: string,
  ) {
    super(`websocket closed before open (code ${code})`);
    this.name = "WebSocketClosedBeforeOpenError";
  }
}

class WebSocketClosedBeforeAuthenticationError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason?: string,
  ) {
    // A rejected token and a transient drop (server restart, proxy reset) close
    // with the same pre-auth shape; the message must not assert a single cause.
    super(
      `websocket closed before authentication completed (code ${code}) — either the bot token was rejected or the connection dropped (server restart, proxy reset); check the Mattermost bot token if this repeats`,
    );
    this.name = "WebSocketClosedBeforeAuthenticationError";
  }
}

type CreateMattermostConnectOnceOpts = {
  wsUrl: string;
  botToken: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  runtime: RuntimeEnv;
  nextSeq: () => number;
  onPosted: (rawEvent: string) => Promise<void>;
  onReaction?: (payload: MattermostEventPayload) => Promise<void>;
  webSocketFactory?: MattermostWebSocketFactory;
  /**
   * Called periodically to check whether the bot account has been modified
   * (e.g. disabled then re-enabled) since the WebSocket was opened.
   * Returns the bot's current `update_at` timestamp.  When it differs from
   * the value recorded at connect time, the connection is terminated so the
   * reconnect loop can establish a fresh one.
   */
  getBotUpdateAt?: () => Promise<number>;
  healthCheckIntervalMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
};

const defaultMattermostWebSocketFactory: MattermostWebSocketFactory = (url, options) => {
  const agent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
  return new WebSocket(url, {
    ...options,
    ...(agent ? { agent } : {}),
  }) as MattermostWebSocketLike;
};

export function createMattermostConnectOnce(
  opts: CreateMattermostConnectOnceOpts,
): () => Promise<void> {
  const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
  const healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
  return async () => {
    const flowId = randomUUID();
    const ws = webSocketFactory(opts.wsUrl, {
      maxPayload: MATTERMOST_WEBSOCKET_MAX_PAYLOAD_BYTES,
      handshakeTimeout: MATTERMOST_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    });
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const getBotUpdateAt = opts.getBotUpdateAt;

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let authenticated = false;
        let settled = false;
        let healthCheckEnabled = getBotUpdateAt != null;
        let healthCheckInFlight = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
        let protocolKeepaliveEnabled = true;
        let protocolPingTimer: ReturnType<typeof setTimeout> | undefined;
        let protocolPongTimer: ReturnType<typeof setTimeout> | undefined;
        let initialUpdateAt: number | undefined;
        let authenticationSeq: number | undefined;
        let authTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimers = () => {
          if (healthCheckTimer !== undefined) {
            clearTimeout(healthCheckTimer);
            healthCheckTimer = undefined;
          }
          if (authTimer !== undefined) {
            clearTimeout(authTimer);
            authTimer = undefined;
          }
          if (protocolPingTimer !== undefined) {
            clearTimeout(protocolPingTimer);
            protocolPingTimer = undefined;
          }
          if (protocolPongTimer !== undefined) {
            clearTimeout(protocolPongTimer);
            protocolPongTimer = undefined;
          }
        };

        const stopHealthChecks = () => {
          healthCheckEnabled = false;
          protocolKeepaliveEnabled = false;
          clearTimers();
        };

        const sendProtocolPing = () => {
          if (!protocolKeepaliveEnabled || settled) {
            return;
          }
          if (protocolPongTimer !== undefined) {
            clearTimeout(protocolPongTimer);
          }
          protocolPongTimer = setTimeout(() => {
            protocolPongTimer = undefined;
            if (!protocolKeepaliveEnabled || settled) {
              return;
            }
            opts.runtime.error?.("mattermost websocket pong timeout — reconnecting");
            stopHealthChecks();
            ws.terminate();
          }, pongTimeoutMs);
          try {
            ws.ping();
          } catch (err) {
            if (!protocolKeepaliveEnabled || settled) {
              return;
            }
            opts.runtime.error?.(`mattermost websocket ping failed: ${String(err)}`);
            stopHealthChecks();
            ws.terminate();
          }
        };

        const scheduleProtocolPing = () => {
          if (!protocolKeepaliveEnabled || settled || protocolPingTimer !== undefined) {
            return;
          }
          protocolPingTimer = setTimeout(() => {
            protocolPingTimer = undefined;
            sendProtocolPing();
          }, pingIntervalMs);
        };

        const scheduleHealthCheck = () => {
          if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
            return;
          }
          healthCheckTimer = setTimeout(() => {
            healthCheckTimer = undefined;
            void runHealthCheck();
          }, healthCheckIntervalMs);
        };

        const runHealthCheck = async () => {
          if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
            return;
          }
          healthCheckInFlight = true;
          try {
            const current = await getBotUpdateAt();
            if (!healthCheckEnabled || settled) {
              return;
            }
            if (initialUpdateAt === undefined) {
              initialUpdateAt = current;
              return;
            }
            if (current !== initialUpdateAt) {
              opts.runtime.log?.(
                `mattermost: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`,
              );
              stopHealthChecks();
              ws.terminate();
            }
          } catch (err) {
            if (!healthCheckEnabled || settled) {
              return;
            }
            const label =
              initialUpdateAt === undefined
                ? "mattermost: failed to get initial update_at"
                : "mattermost: health check error";
            opts.runtime.error?.(`${label}: ${String(err)}`);
          } finally {
            healthCheckInFlight = false;
            scheduleHealthCheck();
          }
        };

        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          stopHealthChecks();
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          stopHealthChecks();
          reject(error);
        };

        ws.on("open", () => {
          opened = true;
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "ws-open",
            flowId,
            meta: { subsystem: "mattermost-websocket" },
          });
          opts.statusSink?.({
            connected: true,
            lifecycle: "starting",
          });
          authenticationSeq = opts.nextSeq();
          const authPayload = JSON.stringify({
            seq: authenticationSeq,
            action: "authentication_challenge",
            data: { token: opts.botToken },
          });
          captureWsEvent({
            url: opts.wsUrl,
            direction: "outbound",
            kind: "ws-frame",
            flowId,
            payload: authPayload,
            meta: { subsystem: "mattermost-websocket", eventType: "authentication_challenge" },
          });
          ws.send(authPayload);
          authTimer = setTimeout(() => {
            authTimer = undefined;
            if (settled) {
              return;
            }
            opts.runtime.error?.("mattermost websocket authentication timed out — reconnecting");
            stopHealthChecks();
            ws.terminate();
          }, MATTERMOST_WEBSOCKET_AUTH_TIMEOUT_MS);
          scheduleProtocolPing();

          // Periodically check if the bot account was modified (e.g. disable/enable).
          // After such a cycle the WebSocket silently stops delivering events even
          // though the connection itself stays alive.  Comparing update_at detects
          // this reliably regardless of how quickly the cycle happens.
          if (getBotUpdateAt) {
            // Use a recursive timeout so only one REST poll can be in flight at a time.
            void runHealthCheck();
          }
        });

        ws.on("pong", () => {
          if (protocolPongTimer !== undefined) {
            clearTimeout(protocolPongTimer);
            protocolPongTimer = undefined;
          }
          scheduleProtocolPing();
        });

        ws.on("message", async (data) => {
          const raw = rawDataToString(data);
          captureWsEvent({
            url: opts.wsUrl,
            direction: "inbound",
            kind: "ws-frame",
            flowId,
            payload: Buffer.from(raw),
            meta: { subsystem: "mattermost-websocket" },
          });
          const payload = parseMattermostEventPayload(raw);
          if (!payload) {
            return;
          }

          if (payload.status === "OK" && payload.seq_reply === authenticationSeq) {
            authenticated = true;
            if (authTimer !== undefined) {
              clearTimeout(authTimer);
              authTimer = undefined;
            }
            opts.statusSink?.(channelReadyPatch());
            return;
          }

          if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
            if (!opts.onReaction) {
              return;
            }
            try {
              await opts.onReaction(payload);
            } catch (err) {
              opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
            }
            return;
          }

          if (payload.event !== "posted") {
            return;
          }
          try {
            await opts.onPosted(raw);
          } catch (err) {
            // Durable admission failed after retries: this post is lost and the
            // websocket cannot nack or replay. Tear the connection down loudly
            // so the outage is operator-visible instead of silently dropping
            // every subsequent post against a broken store.
            opts.runtime.error?.(
              `mattermost durable admission failed; terminating websocket: ${String(err)}`,
            );
            ws.terminate();
          }
        });

        ws.on("close", (code, reason) => {
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "ws-close",
            flowId,
            closeCode: code,
            payload: reason,
            meta: { subsystem: "mattermost-websocket" },
          });
          stopHealthChecks();
          const message = reasonToString(reason);
          opts.statusSink?.({
            connected: false,
            lifecycle: "recovering",
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: message || undefined,
            },
          });
          if (opened && authenticated) {
            resolveOnce();
            return;
          }
          if (opened) {
            // Mattermost answers a failed authentication_challenge by closing the
            // socket with no challenge reply (server platform/websocket_router.go),
            // so an unauthenticated close is a failed attempt: rejecting routes it
            // through reconnect backoff and the visible connection-failed error.
            rejectOnce(new WebSocketClosedBeforeAuthenticationError(code, message || undefined));
            return;
          }
          rejectOnce(new WebSocketClosedBeforeOpenError(code, message || undefined));
        });

        ws.on("error", (err) => {
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "error",
            flowId,
            errorText: String(err),
            meta: { subsystem: "mattermost-websocket" },
          });
          opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
          opts.statusSink?.({
            connected: false,
            lifecycle: "recovering",
            lastError: String(err),
          });
          try {
            ws.close();
          } catch {}
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function reasonToString(reason: Buffer | string | undefined): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.length > 0 ? reason.toString("utf8") : "";
}
