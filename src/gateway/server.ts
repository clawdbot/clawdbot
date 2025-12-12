import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { type WebSocket, WebSocketServer } from "ws";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import { getStatusSummary } from "../commands/status.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { isVerbose } from "../globals.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  listSystemPresence,
  updateSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { getLogger, getResolvedLoggerSettings } from "../logging.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import { defaultRuntime } from "../runtime.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { normalizeE164 } from "../utils.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import { ensureWebChatServerFromConfig } from "../webchat/server.js";
import { buildMessageWithAttachments } from "./chat-attachments.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  type Hello,
  PROTOCOL_VERSION,
  type RequestFrame,
  type Snapshot,
  validateAgentParams,
  validateChatHistoryParams,
  validateChatSendParams,
  validateHello,
  validateRequestFrame,
  validateSendParams,
} from "./protocol/index.js";

type Client = {
  socket: WebSocket;
  hello: Hello;
  connId: string;
  presenceKey?: string;
};

const METHODS = [
  "health",
  "status",
  "system-presence",
  "system-event",
  "send",
  "agent",
  // WebChat WebSocket-native chat methods
  "chat.history",
  "chat.send",
];

const EVENTS = ["agent", "chat", "presence", "tick", "shutdown", "health"];

export type GatewayServer = {
  close: () => Promise<void>;
};

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

let presenceVersion = 1;
let healthVersion = 1;
let seq = 0;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;
// Track per-run sequence to detect out-of-order/lost agent events.
const agentRunSeq = new Map<string, number>();

function buildSnapshot(): Snapshot {
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
  };
}

const MAX_PAYLOAD_BYTES = 512 * 1024; // cap incoming frame size
const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024; // per-connection send buffer limit
const HANDSHAKE_TIMEOUT_MS = 10_000;
const TICK_INTERVAL_MS = 30_000;
const HEALTH_REFRESH_INTERVAL_MS = 60_000;
const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_MAX = 1000;
const LOG_VALUE_LIMIT = 240;

type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};
const dedupe = new Map<string, DedupeEntry>();
// Map runId -> sessionKey for chat events (WS WebChat clients).
const chatRunSessions = new Map<string, string>();
const chatRunBuffers = new Map<string, string[]>();

const getGatewayToken = () => process.env.CLAWDIS_GATEWAY_TOKEN;

function formatForLog(value: unknown): string {
  try {
    const str =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
    if (!str) return "";
    return str.length > LOG_VALUE_LIMIT
      ? `${str.slice(0, LOG_VALUE_LIMIT)}...`
      : str;
  } catch {
    return String(value);
  }
}

function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
): unknown[] {
  const candidates: string[] = [];
  if (storePath) {
    const dir = path.dirname(storePath);
    candidates.push(path.join(dir, `${sessionId}.jsonl`));
  }
  candidates.push(
    path.join(os.homedir(), ".clawdis", "sessions", `${sessionId}.jsonl`),
  );
  candidates.push(
    path.join(os.homedir(), ".pi", "agent", "sessions", `${sessionId}.jsonl`),
  );
  candidates.push(
    path.join(
      os.homedir(),
      ".tau",
      "agent",
      "sessions",
      "clawdis",
      `${sessionId}.jsonl`,
    ),
  );

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // pi/tau logs either raw message or wrapper { message }
      if (parsed?.message) {
        messages.push(parsed.message);
      } else if (parsed?.role && parsed?.content) {
        messages.push(parsed);
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.inbound?.reply?.session;
  const storePath = sessionCfg?.store
    ? resolveStorePath(sessionCfg.store)
    : resolveStorePath(undefined);
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { cfg, storePath, store, entry };
}

function logWs(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  if (!isVerbose()) return;
  const parts = [`gateway/ws ${direction} ${kind}`];
  if (meta) {
    for (const [key, raw] of Object.entries(meta)) {
      if (raw === undefined) continue;
      parts.push(`${key}=${formatForLog(raw)}`);
    }
  }
  const raw = parts.join(" ");
  getLogger().debug(raw);

  const dirColor = direction === "in" ? chalk.greenBright : chalk.cyanBright;
  const prefix = `${chalk.gray("gateway/ws")} ${dirColor(direction)} ${chalk.bold(kind)}`;
  const coloredMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      coloredMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }
  const line = coloredMeta.length
    ? `${prefix} ${coloredMeta.join(" ")}`
    : prefix;
  console.log(line);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const status = (err as { status?: unknown })?.status;
  const code = (err as { code?: unknown })?.code;
  if (status || code)
    return `status=${status ?? "unknown"} code=${code ?? "unknown"}`;
  return JSON.stringify(err, null, 2);
}

async function refreshHealthSnapshot(_opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const snap = await getHealthSnapshot(undefined);
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })();
    healthRefresh.finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}

export async function startGatewayServer(
  port = 18789,
  opts?: { webchatPort?: number },
): Promise<GatewayServer> {
  const host = "127.0.0.1";
  const httpServer: HttpServer = createHttpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new GatewayLockError(
        `another gateway instance is already listening on ws://${host}:${port}`,
        err,
      );
    }
    throw new GatewayLockError(
      `failed to bind gateway socket on ws://${host}:${port}: ${String(err)}`,
      err,
    );
  }

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const providerAbort = new AbortController();
  const providerTasks: Array<Promise<unknown>> = [];
  const clients = new Set<Client>();

  const startProviders = async () => {
    const cfg = loadConfig();
    const telegramToken =
      process.env.TELEGRAM_BOT_TOKEN ?? cfg.telegram?.botToken ?? "";

    if (await webAuthExists()) {
      defaultRuntime.log("gateway: starting WhatsApp Web provider");
      providerTasks.push(
        monitorWebProvider(
          isVerbose(),
          undefined,
          true,
          undefined,
          defaultRuntime,
          providerAbort.signal,
        ).catch((err) => logError(`web provider exited: ${formatError(err)}`)),
      );
    } else {
      defaultRuntime.log(
        "gateway: skipping WhatsApp Web provider (no linked session)",
      );
    }

    if (telegramToken.trim().length > 0) {
      defaultRuntime.log("gateway: starting Telegram provider");
      providerTasks.push(
        monitorTelegramProvider({
          token: telegramToken.trim(),
          runtime: defaultRuntime,
          abortSignal: providerAbort.signal,
          useWebhook: Boolean(cfg.telegram?.webhookUrl),
          webhookUrl: cfg.telegram?.webhookUrl,
          webhookSecret: cfg.telegram?.webhookSecret,
          webhookPath: cfg.telegram?.webhookPath,
        }).catch((err) =>
          logError(`telegram provider exited: ${formatError(err)}`),
        ),
      );
    } else {
      defaultRuntime.log(
        "gateway: skipping Telegram provider (no TELEGRAM_BOT_TOKEN/config)",
      );
    }
  };

  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    logWs("out", "event", {
      event,
      seq: eventSeq,
      clients: clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    });
    for (const c of clients) {
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) continue;
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  broadcastHealthUpdate = (snap: HealthSummary) => {
    broadcast("health", snap, {
      stateVersion: { presence: presenceVersion, health: healthVersion },
    });
  };

  // periodic keepalive
  const tickInterval = setInterval(() => {
    broadcast("tick", { ts: Date.now() }, { dropIfSlow: true });
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void refreshHealthSnapshot({ probe: true }).catch((err) =>
      logError(`health refresh failed: ${formatError(err)}`),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void refreshHealthSnapshot({ probe: true }).catch((err) =>
    logError(`initial health refresh failed: ${formatError(err)}`),
  );

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) dedupe.delete(k);
    }
    if (dedupe.size > DEDUPE_MAX) {
      const entries = [...dedupe.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < dedupe.size - DEDUPE_MAX; i++) {
        dedupe.delete(entries[i][0]);
      }
    }
  }, 60_000);

  const agentUnsub = onAgentEvent((evt) => {
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.seq !== last + 1) {
      // Fan out an error event so clients can refresh the stream on gaps.
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", evt);

    const sessionKey = chatRunSessions.get(evt.runId);
    if (sessionKey) {
      // Map agent bus events to chat events for WS WebChat clients.
      const base = {
        runId: evt.runId,
        sessionKey,
        seq: evt.seq,
      };
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        const buf = chatRunBuffers.get(evt.runId) ?? [];
        buf.push(evt.data.text);
        chatRunBuffers.set(evt.runId, buf);
      } else if (
        evt.stream === "job" &&
        typeof evt.data?.state === "string" &&
        (evt.data.state === "done" || evt.data.state === "error")
      ) {
        const text = chatRunBuffers.get(evt.runId)?.join("\n").trim() ?? "";
        chatRunBuffers.delete(evt.runId);
        if (evt.data.state === "done") {
          broadcast("chat", {
            ...base,
            state: "final",
            message: text
              ? {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                }
              : undefined,
          });
        } else {
          broadcast("chat", {
            ...base,
            state: "error",
            errorMessage: evt.data.error ? String(evt.data.error) : undefined,
          });
        }
        chatRunSessions.delete(evt.runId);
      }
    }
  });

  wss.on("connection", (socket) => {
    let client: Client | null = null;
    let closed = false;
    const connId = randomUUID();
    const deps = createDefaultDeps();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    logWs("in", "connect", { connId, remoteAddr });
    const describeHello = (hello: Hello | null | undefined) =>
      hello
        ? `${hello.client.name ?? "unknown"} ${hello.client.mode ?? "?"} v${hello.client.version ?? "?"}`
        : "unknown";
    const isWebchatHello = (hello: Hello | null | undefined) =>
      hello?.client?.mode === "webchat" || hello?.client?.name === "webchat-ui";

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) clients.delete(client);
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWarn(
        `gateway/ws error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`,
      );
      close();
    });
    socket.once("close", (code, reason) => {
      if (!client) {
        logWarn(
          `gateway/ws closed before hello conn=${connId} remote=${remoteAddr ?? "?"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
        );
      }
      if (client && isWebchatHello(client.hello)) {
        logInfo(
          `webchat disconnected code=${code} reason=${reason?.toString() || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        // mark presence as disconnected
        upsertPresence(client.presenceKey, {
          reason: "disconnect",
        });
        presenceVersion += 1;
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: { presence: presenceVersion, health: healthVersion },
          },
        );
      }
      logWs("out", "close", {
        connId,
        code,
        reason: reason?.toString(),
      });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) {
        logWarn(
          `gateway/ws handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`,
        );
        close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", async (data) => {
      if (closed) return;
      const text = data.toString();
      try {
        const parsed = JSON.parse(text);
        if (!client) {
          // Expect hello
          if (!validateHello(parsed)) {
            logWarn(
              `gateway/ws invalid hello conn=${connId} remote=${remoteAddr ?? "?"}`,
            );
            send({
              type: "hello-error",
              reason: `invalid hello: ${formatValidationErrors(validateHello.errors)}`,
            });
            socket.close(1008, "invalid hello");
            close();
            return;
          }
          const hello = parsed as Hello;
          // protocol negotiation
          const { minProtocol, maxProtocol } = hello;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            logWarn(
              `gateway/ws protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${describeHello(hello)}`,
            );
            logWs("out", "hello-error", {
              connId,
              reason: "protocol mismatch",
              minProtocol,
              maxProtocol,
              expected: PROTOCOL_VERSION,
            });
            send({
              type: "hello-error",
              reason: "protocol mismatch",
              expectedProtocol: PROTOCOL_VERSION,
            });
            socket.close(1002, "protocol mismatch");
            close();
            return;
          }
          // token auth if required
          const token = getGatewayToken();
          if (token && hello.auth?.token !== token) {
            logWarn(
              `gateway/ws unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${describeHello(hello)}`,
            );
            logWs("out", "hello-error", { connId, reason: "unauthorized" });
            send({
              type: "hello-error",
              reason: "unauthorized",
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }

          const shouldTrackPresence = hello.client.mode !== "cli";
          // synthesize presence entry for this connection (client fingerprint)
          const presenceKey = shouldTrackPresence
            ? hello.client.instanceId || connId
            : undefined;
          logWs("in", "hello", {
            connId,
            client: hello.client.name,
            version: hello.client.version,
            mode: hello.client.mode,
            instanceId: hello.client.instanceId,
            platform: hello.client.platform,
            token: hello.auth?.token ? "set" : "none",
          });
          if (isWebchatHello(hello)) {
            logInfo(
              `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${describeHello(hello)}`,
            );
          }
          if (presenceKey) {
            upsertPresence(presenceKey, {
              host: hello.client.name || os.hostname(),
              ip: isLoopbackAddress(remoteAddr) ? undefined : remoteAddr,
              version: hello.client.version,
              mode: hello.client.mode,
              instanceId: hello.client.instanceId,
              reason: "connect",
            });
            presenceVersion += 1;
          }
          const snapshot = buildSnapshot();
          if (healthCache) {
            snapshot.health = healthCache;
            snapshot.stateVersion.health = healthVersion;
          }
          const helloOk = {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            server: {
              version:
                process.env.CLAWDIS_VERSION ??
                process.env.npm_package_version ??
                "dev",
              commit: process.env.GIT_COMMIT,
              host: os.hostname(),
              connId,
            },
            features: { methods: METHODS, events: EVENTS },
            snapshot,
            policy: {
              maxPayload: MAX_PAYLOAD_BYTES,
              maxBufferedBytes: MAX_BUFFERED_BYTES,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          };
          clearTimeout(handshakeTimer);
          // Add the client only after the hello response is ready so no tick/presence
          // events reach it before the handshake completes.
          client = { socket, hello, connId, presenceKey };
          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });
          send(helloOk);
          clients.add(client);
          // Kick a health refresh in the background to keep cache warm.
          void refreshHealthSnapshot({ probe: true }).catch((err) =>
            logError(`post-hello health refresh failed: ${formatError(err)}`),
          );
          return;
        }

        // After handshake, accept only req frames
        if (!validateRequestFrame(parsed)) {
          send({
            type: "res",
            id: (parsed as { id?: unknown })?.id ?? "invalid",
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
            ),
          });
          return;
        }
        const req = parsed as RequestFrame;
        logWs("in", "req", {
          connId,
          id: req.id,
          method: req.method,
        });
        const respond = (
          ok: boolean,
          payload?: unknown,
          error?: ErrorShape,
          meta?: Record<string, unknown>,
        ) => {
          send({ type: "res", id: req.id, ok, payload, error });
          logWs("out", "res", {
            connId,
            id: req.id,
            ok,
            method: req.method,
            ...meta,
          });
        };

        switch (req.method) {
          case "health": {
            const now = Date.now();
            const cached = healthCache;
            if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
              respond(true, cached, undefined, { cached: true });
              void refreshHealthSnapshot({ probe: false }).catch((err) =>
                logError(
                  `background health refresh failed: ${formatError(err)}`,
                ),
              );
              break;
            }
            try {
              const snap = await refreshHealthSnapshot({ probe: false });
              respond(true, snap, undefined);
            } catch (err) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
              );
            }
            break;
          }
          case "chat.history": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            if (!validateChatHistoryParams(params)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
                ),
              );
              break;
            }
            const { sessionKey } = params as { sessionKey: string };
            const { storePath, entry } = loadSessionEntry(sessionKey);
            const sessionId = entry?.sessionId;
            const messages =
              sessionId && storePath
                ? readSessionMessages(sessionId, storePath)
                : [];
            const thinkingLevel =
              entry?.thinkingLevel ??
              loadConfig().inbound?.reply?.thinkingDefault ??
              "off";
            respond(true, { sessionKey, sessionId, messages, thinkingLevel });
            break;
          }
          case "chat.send": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            if (!validateChatSendParams(params)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
                ),
              );
              break;
            }
            const p = params as {
              sessionKey: string;
              message: string;
              thinking?: string;
              deliver?: boolean;
              attachments?: Array<{
                type?: string;
                mimeType?: string;
                fileName?: string;
                content?: unknown;
              }>;
              timeoutMs?: number;
              idempotencyKey: string;
            };
            const timeoutMs = Math.min(
              Math.max(p.timeoutMs ?? 30_000, 0),
              30_000,
            );
            const normalizedAttachments =
              p.attachments?.map((a) => ({
                type: typeof a?.type === "string" ? a.type : undefined,
                mimeType:
                  typeof a?.mimeType === "string" ? a.mimeType : undefined,
                fileName:
                  typeof a?.fileName === "string" ? a.fileName : undefined,
                content:
                  typeof a?.content === "string"
                    ? a.content
                    : ArrayBuffer.isView(a?.content)
                      ? Buffer.from(
                          a.content.buffer,
                          a.content.byteOffset,
                          a.content.byteLength,
                        ).toString("base64")
                      : undefined,
              })) ?? [];
            let messageWithAttachments = p.message;
            if (normalizedAttachments.length > 0) {
              try {
                messageWithAttachments = buildMessageWithAttachments(
                  p.message,
                  normalizedAttachments,
                  { maxBytes: 5_000_000 },
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, String(err)),
                );
                break;
              }
            }
            const { storePath, store, entry } = loadSessionEntry(p.sessionKey);
            const now = Date.now();
            const sessionId = entry?.sessionId ?? randomUUID();
            const sessionEntry: SessionEntry = {
              sessionId,
              updatedAt: now,
              thinkingLevel: entry?.thinkingLevel,
              verboseLevel: entry?.verboseLevel,
              systemSent: entry?.systemSent,
              lastChannel: entry?.lastChannel,
              lastTo: entry?.lastTo,
            };
            if (store) {
              store[p.sessionKey] = sessionEntry;
              if (storePath) {
                await saveSessionStore(storePath, store);
              }
            }
            chatRunSessions.set(sessionId, p.sessionKey);

            const idem = p.idempotencyKey;
            const cached = dedupe.get(`chat:${idem}`);
            if (cached) {
              respond(cached.ok, cached.payload, cached.error, {
                cached: true,
              });
              break;
            }

            try {
              await agentCommand(
                {
                  message: messageWithAttachments,
                  sessionId,
                  thinking: p.thinking,
                  deliver: p.deliver,
                  timeout: Math.ceil(timeoutMs / 1000).toString(),
                  surface: "WebChat",
                },
                defaultRuntime,
                deps,
              );
              const payload = {
                runId: sessionId,
                status: "ok" as const,
              };
              dedupe.set(`chat:${idem}`, { ts: Date.now(), ok: true, payload });
              respond(true, payload, undefined, { runId: sessionId });
            } catch (err) {
              const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
              const payload = {
                runId: sessionId,
                status: "error" as const,
                summary: String(err),
              };
              dedupe.set(`chat:${idem}`, {
                ts: Date.now(),
                ok: false,
                payload,
                error,
              });
              respond(false, payload, error, {
                runId: sessionId,
                error: formatForLog(err),
              });
            }
            break;
          }
          case "status": {
            const status = await getStatusSummary();
            respond(true, status, undefined);
            break;
          }
          case "system-presence": {
            const presence = listSystemPresence();
            respond(true, presence, undefined);
            break;
          }
          case "system-event": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            const text = String(params.text ?? "").trim();
            if (!text) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, "text required"),
              );
              break;
            }
            const instanceId =
              typeof params.instanceId === "string"
                ? params.instanceId
                : undefined;
            const host =
              typeof params.host === "string" ? params.host : undefined;
            const ip = typeof params.ip === "string" ? params.ip : undefined;
            const mode =
              typeof params.mode === "string" ? params.mode : undefined;
            const version =
              typeof params.version === "string" ? params.version : undefined;
            const lastInputSeconds =
              typeof params.lastInputSeconds === "number" &&
              Number.isFinite(params.lastInputSeconds)
                ? params.lastInputSeconds
                : undefined;
            const reason =
              typeof params.reason === "string" ? params.reason : undefined;
            const tags =
              Array.isArray(params.tags) &&
              params.tags.every((t) => typeof t === "string")
                ? (params.tags as string[])
                : undefined;
            updateSystemPresence({
              text,
              instanceId,
              host,
              ip,
              mode,
              version,
              lastInputSeconds,
              reason,
              tags,
            });
            enqueueSystemEvent(text);
            presenceVersion += 1;
            broadcast(
              "presence",
              { presence: listSystemPresence() },
              {
                dropIfSlow: true,
                stateVersion: {
                  presence: presenceVersion,
                  health: healthVersion,
                },
              },
            );
            respond(true, { ok: true }, undefined);
            break;
          }
          case "send": {
            const p = (req.params ?? {}) as Record<string, unknown>;
            if (!validateSendParams(p)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
                ),
              );
              break;
            }
            const params = p as {
              to: string;
              message: string;
              mediaUrl?: string;
              provider?: string;
              idempotencyKey: string;
            };
            const idem = params.idempotencyKey;
            const cached = dedupe.get(`send:${idem}`);
            if (cached) {
              respond(cached.ok, cached.payload, cached.error, {
                cached: true,
              });
              break;
            }
            const to = params.to.trim();
            const message = params.message.trim();
            const provider = (params.provider ?? "whatsapp").toLowerCase();
            try {
              if (provider === "telegram") {
                const result = await sendMessageTelegram(to, message, {
                  mediaUrl: params.mediaUrl,
                  verbose: isVerbose(),
                });
                const payload = {
                  runId: idem,
                  messageId: result.messageId,
                  chatId: result.chatId,
                  provider,
                };
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { provider });
              } else {
                const result = await sendMessageWhatsApp(to, message, {
                  mediaUrl: params.mediaUrl,
                  verbose: isVerbose(),
                });
                const payload = {
                  runId: idem,
                  messageId: result.messageId,
                  toJid: result.toJid ?? `${to}@s.whatsapp.net`,
                  provider,
                };
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { provider });
              }
            } catch (err) {
              const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
              dedupe.set(`send:${idem}`, { ts: Date.now(), ok: false, error });
              respond(false, undefined, error, {
                provider,
                error: formatForLog(err),
              });
            }
            break;
          }
          case "agent": {
            const p = (req.params ?? {}) as Record<string, unknown>;
            if (!validateAgentParams(p)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
                ),
              );
              break;
            }
            const params = p as {
              message: string;
              to?: string;
              sessionId?: string;
              sessionKey?: string;
              thinking?: string;
              deliver?: boolean;
              channel?: string;
              idempotencyKey: string;
              timeout?: number;
            };
            const idem = params.idempotencyKey;
            const cached = dedupe.get(`agent:${idem}`);
            if (cached) {
              respond(cached.ok, cached.payload, cached.error, {
                cached: true,
              });
              break;
            }
            const message = params.message.trim();

            const requestedSessionKey =
              typeof params.sessionKey === "string" && params.sessionKey.trim()
                ? params.sessionKey.trim()
                : undefined;
            let resolvedSessionId = params.sessionId?.trim() || undefined;
            let sessionEntry: SessionEntry | undefined;
            let bestEffortDeliver = false;
            let cfgForAgent: ReturnType<typeof loadConfig> | undefined;

            if (requestedSessionKey) {
              const { cfg, storePath, store, entry } =
                loadSessionEntry(requestedSessionKey);
              cfgForAgent = cfg;
              const now = Date.now();
              const sessionId = entry?.sessionId ?? randomUUID();
              sessionEntry = {
                sessionId,
                updatedAt: now,
                thinkingLevel: entry?.thinkingLevel,
                verboseLevel: entry?.verboseLevel,
                systemSent: entry?.systemSent,
                lastChannel: entry?.lastChannel,
                lastTo: entry?.lastTo,
              };
              if (store) {
                store[requestedSessionKey] = sessionEntry;
                if (storePath) {
                  await saveSessionStore(storePath, store);
                }
              }
              resolvedSessionId = sessionId;
              const mainKey =
                (cfg.inbound?.reply?.session?.mainKey ?? "main").trim() ||
                "main";
              if (requestedSessionKey === mainKey) {
                chatRunSessions.set(sessionId, requestedSessionKey);
                bestEffortDeliver = true;
              }
            }

            const runId = resolvedSessionId || randomUUID();

            const requestedChannelRaw =
              typeof params.channel === "string" ? params.channel.trim() : "";
            const requestedChannel = requestedChannelRaw
              ? requestedChannelRaw.toLowerCase()
              : "last";

            const lastChannel = sessionEntry?.lastChannel;
            const lastTo =
              typeof sessionEntry?.lastTo === "string"
                ? sessionEntry.lastTo.trim()
                : "";

            const resolvedChannel = (() => {
              if (requestedChannel === "last") {
                return lastChannel ?? "whatsapp";
              }
              if (
                requestedChannel === "whatsapp" ||
                requestedChannel === "telegram" ||
                requestedChannel === "webchat"
              ) {
                return requestedChannel;
              }
              return lastChannel ?? "whatsapp";
            })();

            const resolvedTo = (() => {
              const explicit =
                typeof params.to === "string" && params.to.trim()
                  ? params.to.trim()
                  : undefined;
              if (explicit) return explicit;
              if (
                resolvedChannel === "whatsapp" ||
                resolvedChannel === "telegram"
              ) {
                return lastTo || undefined;
              }
              return undefined;
            })();

            const sanitizedTo = (() => {
              // If we derived a WhatsApp recipient from session "lastTo", ensure it is still valid
              // for the configured allowlist. Otherwise, fall back to the first allowed number so
              // voice wake doesn't silently route to stale/test recipients.
              if (resolvedChannel !== "whatsapp") return resolvedTo;
              const explicit =
                typeof params.to === "string" && params.to.trim()
                  ? params.to.trim()
                  : undefined;
              if (explicit) return resolvedTo;

              const cfg = cfgForAgent ?? loadConfig();
              const rawAllow = cfg.inbound?.allowFrom ?? [];
              if (rawAllow.includes("*")) return resolvedTo;
              const allowFrom = rawAllow
                .map((val) => normalizeE164(val))
                .filter((val) => val.length > 1);
              if (allowFrom.length === 0) return resolvedTo;

              const normalizedLast =
                typeof resolvedTo === "string" && resolvedTo.trim()
                  ? normalizeE164(resolvedTo)
                  : undefined;
              if (normalizedLast && allowFrom.includes(normalizedLast)) {
                return normalizedLast;
              }
              return allowFrom[0];
            })();

            const deliver =
              params.deliver === true && resolvedChannel !== "webchat";

            const accepted = { runId, status: "accepted" as const };
            // Store an in-flight ack so retries do not spawn a second run.
            dedupe.set(`agent:${idem}`, {
              ts: Date.now(),
              ok: true,
              payload: accepted,
            });
            respond(true, accepted, undefined, { runId });

            void agentCommand(
              {
                message,
                to: sanitizedTo,
                sessionId: resolvedSessionId,
                thinking: params.thinking,
                deliver,
                provider: resolvedChannel,
                timeout: params.timeout?.toString(),
                bestEffortDeliver,
                surface: "VoiceWake",
              },
              defaultRuntime,
              deps,
            )
              .then(() => {
                const payload = {
                  runId,
                  status: "ok" as const,
                  summary: "completed",
                };
                dedupe.set(`agent:${idem}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                // Send a second res frame (same id) so TS clients with expectFinal can wait.
                // Swift clients will typically treat the first res as the result and ignore this.
                respond(true, payload, undefined, { runId });
              })
              .catch((err) => {
                const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                const payload = {
                  runId,
                  status: "error" as const,
                  summary: String(err),
                };
                dedupe.set(`agent:${idem}`, {
                  ts: Date.now(),
                  ok: false,
                  payload,
                  error,
                });
                respond(false, payload, error, {
                  runId,
                  error: formatForLog(err),
                });
              });
            break;
          }
          default: {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `unknown method: ${req.method}`,
              ),
            );
            break;
          }
        }
      } catch (err) {
        logError(`gateway: parse/handle error: ${String(err)}`);
        logWs("out", "parse-error", { connId, error: formatForLog(err) });
        // If still in handshake, close; otherwise respond error
        if (!client) {
          close();
        }
      }
    });
  });

  defaultRuntime.log(
    `gateway listening on ws://127.0.0.1:${port} (PID ${process.pid})`,
  );
  defaultRuntime.log(`gateway log file: ${getResolvedLoggerSettings().file}`);

  // Start loopback WebChat server (unless disabled via config).
  void ensureWebChatServerFromConfig(opts?.webchatPort)
    .then((webchat) => {
      if (webchat) {
        defaultRuntime.log(
          `webchat listening on http://127.0.0.1:${webchat.port}/`,
        );
      }
    })
    .catch((err) => {
      logError(`gateway: webchat failed to start: ${String(err)}`);
    });

  // Launch configured providers (WhatsApp Web, Telegram) so gateway replies via the
  // surface the message came from. Tests can opt out via CLAWDIS_SKIP_PROVIDERS.
  if (process.env.CLAWDIS_SKIP_PROVIDERS !== "1") {
    void startProviders();
  } else {
    defaultRuntime.log(
      "gateway: skipping provider start (CLAWDIS_SKIP_PROVIDERS=1)",
    );
  }

  return {
    close: async () => {
      providerAbort.abort();
      broadcast("shutdown", {
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
      if (agentUnsub) {
        try {
          agentUnsub();
        } catch {
          /* ignore */
        }
      }
      chatRunSessions.clear();
      chatRunBuffers.clear();
      for (const c of clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await Promise.allSettled(providerTasks);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
