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
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL } from "../agents/defaults.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../auto-reply/thinking.js";
import {
  startBrowserControlServerFromConfig,
  stopBrowserControlServer,
} from "../browser/server.js";
import {
  type CanvasHostServer,
  startCanvasHost,
} from "../canvas-host/server.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import { getStatusSummary } from "../commands/status.js";
import { type ClawdisConfig, loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import {
  appendCronRunLog,
  readCronRunLogEntries,
  resolveCronRunLogPath,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJobCreate, CronJobPatch } from "../cron/types.js";
import { isVerbose } from "../globals.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
} from "../infra/heartbeat-events.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  requestNodePairing,
  verifyNodeToken,
} from "../infra/node-pairing.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  listSystemPresence,
  updateSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import {
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "../infra/tailnet.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "../infra/voicewake.js";
import {
  WIDE_AREA_DISCOVERY_DOMAIN,
  writeWideAreaBridgeZone,
} from "../infra/widearea-dns.js";
import { logError, logInfo, logWarn } from "../logger.js";
import {
  getChildLogger,
  getResolvedLoggerSettings,
} from "../logging.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import { defaultRuntime } from "../runtime.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { normalizeE164 } from "../utils.js";
import { setHeartbeatsEnabled } from "../web/auto-reply.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import { requestReplyHeartbeatNow } from "../web/reply-heartbeat-wake.js";
import { buildMessageWithAttachments } from "./chat-attachments.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  type RequestFrame,
  type SessionsListParams,
  type SessionsPatchParams,
  type Snapshot,
  validateAgentParams,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
  validateConnectParams,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateNodeDescribeParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateRequestFrame,
  validateSendParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateWakeParams,
} from "./protocol/index.js";

type Client = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
};

function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) return "Clawdis";
  if (/clawdis/i.test(trimmed)) return trimmed;
  return `${trimmed} (Clawdis)`;
}

type GatewaySessionsDefaults = {
  model: string | null;
  contextTokens: number | null;
};

type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
  syncing?: boolean | string;
};

type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
};

const METHODS = [
  "health",
  "status",
  "voicewake.get",
  "voicewake.set",
  "sessions.list",
  "sessions.patch",
  "last-heartbeat",
  "set-heartbeats",
  "wake",
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "node.list",
  "node.describe",
  "node.invoke",
  "cron.list",
  "cron.status",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "system-presence",
  "system-event",
  "send",
  "agent",
  // WebChat WebSocket-native chat methods
  "chat.history",
  "chat.abort",
  "chat.send",
];

const EVENTS = [
  "agent",
  "chat",
  "presence",
  "tick",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "voicewake.changed",
];

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
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

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
const MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
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

function normalizeVoiceWakeTriggers(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = raw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, 32)
    .map((v) => v.slice(0, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
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

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) return { items, bytes: 2 };
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1); // [] + commas
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1; // item + comma
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.inbound?.session;
  const storePath = sessionCfg?.store
    ? resolveStorePath(sessionCfg.store)
    : resolveStorePath(undefined);
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { cfg, storePath, store, entry };
}

function classifySessionKey(key: string): GatewaySessionRow["kind"] {
  if (key === "global") return "global";
  if (key.startsWith("group:")) return "group";
  if (key === "unknown") return "unknown";
  return "direct";
}

function getSessionDefaults(cfg: ClawdisConfig): GatewaySessionsDefaults {
  const model = cfg.inbound?.agent?.model ?? DEFAULT_MODEL;
  const contextTokens =
    cfg.inbound?.agent?.contextTokens ??
    lookupContextTokens(model) ??
    DEFAULT_CONTEXT_TOKENS;
  return { model: model ?? null, contextTokens: contextTokens ?? null };
}

function listSessionsFromStore(params: {
  cfg: ClawdisConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const activeMinutes =
    typeof opts.activeMinutes === "number" &&
    Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let sessions = Object.entries(store)
    .filter(([key]) => {
      if (!includeGlobal && key === "global") return false;
      if (!includeUnknown && key === "unknown") return false;
      return true;
    })
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const input = entry?.inputTokens ?? 0;
      const output = entry?.outputTokens ?? 0;
      const total = entry?.totalTokens ?? input + output;
      return {
        key,
        kind: classifySessionKey(key),
        updatedAt,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
        syncing: entry?.syncing,
      } satisfies GatewaySessionRow;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
  }

  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const limit = Math.max(1, Math.floor(opts.limit));
    sessions = sessions.slice(0, limit);
  }

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    defaults: getSessionDefaults(cfg),
    sessions,
  };
}

function logWs(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  if (!isVerbose()) return;
  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const event = typeof meta?.event === "string" ? meta.event : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;
  if (direction === "in" && kind === "req" && inflightKey) {
    wsInflightSince.set(inflightKey, now);
  }
  const durationMs =
    direction === "out" && kind === "res" && inflightKey
      ? (() => {
          const startedAt = wsInflightSince.get(inflightKey);
          if (startedAt === undefined) return undefined;
          wsInflightSince.delete(inflightKey);
          return now - startedAt;
        })()
      : undefined;

  const dirArrow = direction === "in" ? "←" : "→";
  const dirColor = direction === "in" ? chalk.greenBright : chalk.cyanBright;
  const prefix = `${chalk.gray("gateway/ws")} ${dirColor(dirArrow)} ${chalk.bold(kind)}`;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && event
        ? chalk.bold(event)
        : undefined;

  const statusToken =
    kind === "res" && ok !== undefined
      ? ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗")
      : undefined;

  const durationToken =
    typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      if (key === "event") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const trailing: string[] = [];
  if (connId) trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  const tokens = [
    prefix,
    statusToken,
    headline,
    durationToken,
    ...restMeta,
    ...trailing,
  ].filter((t): t is string => Boolean(t));

  console.log(tokens.join(" "));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(value: string): string {
  const s = value.trim();
  if (UUID_RE.test(s)) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  if (s.length <= 24) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

const wsInflightSince = new Map<string, number>();

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

export async function startGatewayServer(port = 18789): Promise<GatewayServer> {
  const host = "127.0.0.1";
  const httpServer: HttpServer = createHttpServer();
  let bonjourStop: (() => Promise<void>) | null = null;
  let bridge: Awaited<ReturnType<typeof startNodeBridgeServer>> | null = null;
  let canvasHost: CanvasHostServer | null = null;
  const bridgeNodeSubscriptions = new Map<string, Set<string>>();
  const bridgeSessionSubscribers = new Map<string, Set<string>>();
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
  let seq = 0;
  // Track per-run sequence to detect out-of-order/lost agent events.
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  // Map agent sessionId -> {sessionKey, clientRunId} for chat events (WS WebChat clients).
  const chatRunSessions = new Map<
    string,
    { sessionKey: string; clientRunId: string }
  >();
  const chatRunBuffers = new Map<string, string>();
  const chatAbortControllers = new Map<
    string,
    { controller: AbortController; sessionId: string; sessionKey: string }
  >();
  const cfgAtStart = loadConfig();
  setCommandLaneConcurrency("cron", cfgAtStart.cron?.maxConcurrentRuns ?? 1);

  if (cfgAtStart.canvasHost?.enabled === true) {
    try {
      canvasHost = await startCanvasHost({
        runtime: defaultRuntime,
        rootDir: cfgAtStart.canvasHost.root,
        port: cfgAtStart.canvasHost.port ?? 18793,
        bind: cfgAtStart.canvasHost.bind ?? "lan",
      });
    } catch (err) {
      logWarn(`gateway: canvas host failed to start: ${String(err)}`);
    }
  }

  const cronStorePath = resolveCronStorePath(cfgAtStart.cron?.store);
  const cronLogger = getChildLogger({
    module: "cron",
    storePath: cronStorePath,
  });
  const deps = createDefaultDeps();
  const cronEnabled =
    process.env.CLAWDIS_SKIP_CRON !== "1" && cfgAtStart.cron?.enabled !== false;
  const cron = new CronService({
    storePath: cronStorePath,
    cronEnabled,
    enqueueSystemEvent,
    requestReplyHeartbeatNow,
    runIsolatedAgentJob: async ({ job, message }) => {
      const cfg = loadConfig();
      return await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: cronLogger,
    onEvent: (evt) => {
      broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath: cronStorePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn(
            { err: String(err), logPath },
            "cron: run log append failed",
          );
        });
      }
    },
  });

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

  const wideAreaDiscoveryEnabled =
    cfgAtStart.discovery?.wideArea?.enabled === true;

  const bridgeEnabled = (() => {
    if (cfgAtStart.bridge?.enabled !== undefined)
      return cfgAtStart.bridge.enabled === true;
    return process.env.CLAWDIS_BRIDGE_ENABLED !== "0";
  })();

  const bridgePort = (() => {
    if (
      typeof cfgAtStart.bridge?.port === "number" &&
      cfgAtStart.bridge.port > 0
    ) {
      return cfgAtStart.bridge.port;
    }
    if (process.env.CLAWDIS_BRIDGE_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDIS_BRIDGE_PORT, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 18790;
    }
    return 18790;
  })();

  const bridgeHost = (() => {
    // Back-compat: allow an env var override when no bind policy is configured.
    if (cfgAtStart.bridge?.bind === undefined) {
      const env = process.env.CLAWDIS_BRIDGE_HOST?.trim();
      if (env) return env;
    }

    const bind =
      cfgAtStart.bridge?.bind ?? (wideAreaDiscoveryEnabled ? "tailnet" : "lan");
    if (bind === "loopback") return "127.0.0.1";
    if (bind === "lan") return "0.0.0.0";

    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    const tailnetIPv6 = pickPrimaryTailnetIPv6();
    if (bind === "tailnet") {
      return tailnetIPv4 ?? tailnetIPv6 ?? null;
    }
    if (bind === "auto") {
      return tailnetIPv4 ?? tailnetIPv6 ?? "0.0.0.0";
    }
    return "0.0.0.0";
  })();

  const bridgeSubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    let nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      bridgeNodeSubscriptions.set(normalizedNodeId, nodeSet);
    }
    if (nodeSet.has(normalizedSessionKey)) return;
    nodeSet.add(normalizedSessionKey);

    let sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      bridgeSessionSubscribers.set(normalizedSessionKey, sessionSet);
    }
    sessionSet.add(normalizedNodeId);
  };

  const bridgeUnsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    nodeSet?.delete(normalizedSessionKey);
    if (nodeSet?.size === 0) bridgeNodeSubscriptions.delete(normalizedNodeId);

    const sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    sessionSet?.delete(normalizedNodeId);
    if (sessionSet?.size === 0)
      bridgeSessionSubscribers.delete(normalizedSessionKey);
  };

  const bridgeUnsubscribeAll = (nodeId: string) => {
    const normalizedNodeId = nodeId.trim();
    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) return;
    for (const sessionKey of nodeSet) {
      const sessionSet = bridgeSessionSubscribers.get(sessionKey);
      sessionSet?.delete(normalizedNodeId);
      if (sessionSet?.size === 0) bridgeSessionSubscribers.delete(sessionKey);
    }
    bridgeNodeSubscriptions.delete(normalizedNodeId);
  };

  const bridgeSendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    const subs = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!subs || subs.size === 0) return;
    if (!bridge) return;

    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of subs) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllSubscribed = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of bridgeNodeSubscriptions.keys()) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllConnected = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const node of bridge.listConnected()) {
      bridge.sendEvent({ nodeId: node.nodeId, event, payloadJSON });
    }
  };

  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    const payload = { triggers };
    broadcast("voicewake.changed", payload, { dropIfSlow: true });
    bridgeSendToAllConnected("voicewake.changed", payload);
  };

  const handleBridgeRequest = async (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ): Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  > => {
    const method = req.method.trim();

    const parseParams = (): Record<string, unknown> => {
      const raw = typeof req.paramsJSON === "string" ? req.paramsJSON : "";
      const trimmed = raw.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    };

    try {
      switch (method) {
        case "voicewake.get": {
          const cfg = await loadVoiceWakeConfig();
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "voicewake.set": {
          const params = parseParams();
          const triggers = normalizeVoiceWakeTriggers(params.triggers);
          const cfg = await setVoiceWakeTriggers(triggers);
          broadcastVoiceWakeChanged(cfg.triggers);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "health": {
          const now = Date.now();
          const cached = healthCache;
          if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
            return { ok: true, payloadJSON: JSON.stringify(cached) };
          }
          const snap = await refreshHealthSnapshot({ probe: false });
          return { ok: true, payloadJSON: JSON.stringify(snap) };
        }
        case "sessions.list": {
          const params = parseParams();
          if (!validateSessionsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
              },
            };
          }
          const p = params as SessionsListParams;
          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.inbound?.session?.store);
          const store = loadSessionStore(storePath);
          const result = listSessionsFromStore({
            cfg,
            storePath,
            store,
            opts: p,
          });
          return { ok: true, payloadJSON: JSON.stringify(result) };
        }
        case "sessions.patch": {
          const params = parseParams();
          if (!validateSessionsPatchParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
              },
            };
          }

          const p = params as SessionsPatchParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.inbound?.session?.store);
          const store = loadSessionStore(storePath);
          const now = Date.now();

          const existing = store[key];
          const next: SessionEntry = existing
            ? {
                ...existing,
                updatedAt: Math.max(existing.updatedAt ?? 0, now),
              }
            : { sessionId: randomUUID(), updatedAt: now };

          if ("thinkingLevel" in p) {
            const raw = p.thinkingLevel;
            if (raw === null) {
              delete next.thinkingLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeThinkLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid thinkingLevel: ${String(raw)}`,
                  },
                };
              }
              next.thinkingLevel = normalized;
            }
          }

          if ("verboseLevel" in p) {
            const raw = p.verboseLevel;
            if (raw === null) {
              delete next.verboseLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeVerboseLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid verboseLevel: ${String(raw)}`,
                  },
                };
              }
              next.verboseLevel = normalized;
            }
          }

          if ("syncing" in p) {
            const raw = p.syncing;
            if (raw === null) {
              delete next.syncing;
            } else if (raw !== undefined) {
              next.syncing = raw as boolean | string;
            }
          }

          store[key] = next;
          await saveSessionStore(storePath, store);
          const payload: SessionsPatchResult = {
            ok: true,
            path: storePath,
            key,
            entry: next,
          };
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "chat.history": {
          const params = parseParams();
          if (!validateChatHistoryParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
              },
            };
          }
          const { sessionKey, limit } = params as {
            sessionKey: string;
            limit?: number;
          };
          const { storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId;
          const rawMessages =
            sessionId && storePath
              ? readSessionMessages(sessionId, storePath)
              : [];
          const max = typeof limit === "number" ? limit : 200;
          const sliced =
            rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
          const capped = capArrayByJsonBytes(
            sliced,
            MAX_CHAT_HISTORY_MESSAGES_BYTES,
          ).items;
          const thinkingLevel =
            entry?.thinkingLevel ??
            loadConfig().inbound?.agent?.thinkingDefault ??
            "off";
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              sessionKey,
              sessionId,
              messages: capped,
              thinkingLevel,
            }),
          };
        }
        case "chat.abort": {
          const params = parseParams();
          if (!validateChatAbortParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
              },
            };
          }

          const { sessionKey, runId } = params as {
            sessionKey: string;
            runId: string;
          };
          const active = chatAbortControllers.get(runId);
          if (!active) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({ ok: true, aborted: false }),
            };
          }
          if (active.sessionKey !== sessionKey) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "runId does not match sessionKey",
              },
            };
          }

          active.controller.abort();
          chatAbortControllers.delete(runId);
          chatRunBuffers.delete(runId);
          const current = chatRunSessions.get(active.sessionId);
          if (
            current?.clientRunId === runId &&
            current.sessionKey === sessionKey
          ) {
            chatRunSessions.delete(active.sessionId);
          }

          const payload = {
            runId,
            sessionKey,
            seq: (agentRunSeq.get(active.sessionId) ?? 0) + 1,
            state: "aborted" as const,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, aborted: true }),
          };
        }
        case "chat.send": {
          const params = parseParams();
          if (!validateChatSendParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
              },
            };
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
              return {
                ok: false,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: String(err),
                },
              };
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
          const clientRunId = p.idempotencyKey;

          const cached = dedupe.get(`chat:${clientRunId}`);
          if (cached) {
            if (cached.ok) {
              return { ok: true, payloadJSON: JSON.stringify(cached.payload) };
            }
            return {
              ok: false,
              error: cached.error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: "request failed",
              },
            };
          }

          try {
            const abortController = new AbortController();
            chatAbortControllers.set(clientRunId, {
              controller: abortController,
              sessionId,
              sessionKey: p.sessionKey,
            });
            chatRunSessions.set(sessionId, {
              sessionKey: p.sessionKey,
              clientRunId,
            });

            if (store) {
              store[p.sessionKey] = sessionEntry;
              if (storePath) {
                await saveSessionStore(storePath, store);
              }
            }

            await agentCommand(
              {
                message: messageWithAttachments,
                sessionId,
                thinking: p.thinking,
                deliver: p.deliver,
                timeout: Math.ceil(timeoutMs / 1000).toString(),
                surface: `Node(${nodeId})`,
                abortSignal: abortController.signal,
              },
              defaultRuntime,
              deps,
            );
            const payload = {
              runId: clientRunId,
              status: "ok" as const,
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload,
            });
            return { ok: true, payloadJSON: JSON.stringify(payload) };
          } catch (err) {
            const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
            const payload = {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: false,
              payload,
              error,
            });
            return {
              ok: false,
              error: error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: String(err),
              },
            };
          } finally {
            chatAbortControllers.delete(clientRunId);
          }
        }
        default:
          return {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "Method not allowed",
              details: { method },
            },
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: String(err) },
      };
    }
  };

  const handleBridgeEvent = async (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => {
    switch (evt.event) {
      case "voice.transcript": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!text) return;
        if (text.length > 20_000) return;
        const sessionKeyRaw =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message: text,
            sessionId,
            thinking: "low",
            deliver: false,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logWarn(`bridge: agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "agent.request": {
        if (!evt.payloadJSON) return;
        type AgentDeepLink = {
          message?: string;
          sessionKey?: string | null;
          thinking?: string | null;
          deliver?: boolean;
          to?: string | null;
          channel?: string | null;
          timeoutSeconds?: number | null;
          key?: string | null;
        };
        let link: AgentDeepLink | null = null;
        try {
          link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
        } catch {
          return;
        }
        const message = (link?.message ?? "").trim();
        if (!message) return;
        if (message.length > 20_000) return;

        const channelRaw =
          typeof link?.channel === "string" ? link.channel.trim() : "";
        const channel = channelRaw.toLowerCase();
        const provider =
          channel === "whatsapp" || channel === "telegram"
            ? channel
            : undefined;
        const to =
          typeof link?.to === "string" && link.to.trim()
            ? link.to.trim()
            : undefined;
        const deliver = Boolean(link?.deliver) && Boolean(provider);

        const sessionKeyRaw = (link?.sessionKey ?? "").trim();
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message,
            sessionId,
            thinking: link?.thinking ?? undefined,
            deliver,
            to,
            provider,
            timeout:
              typeof link?.timeoutSeconds === "number"
                ? link.timeoutSeconds.toString()
                : undefined,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logWarn(`bridge: agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "chat.subscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeSubscribe(nodeId, sessionKey);
        return;
      }
      case "chat.unsubscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeUnsubscribe(nodeId, sessionKey);
        return;
      }
      default:
        return;
    }
  };

  const machineDisplayName = await getMachineDisplayName();

  if (bridgeEnabled && bridgePort > 0 && bridgeHost) {
    try {
      const started = await startNodeBridgeServer({
        host: bridgeHost,
        port: bridgePort,
        serverName: machineDisplayName,
        onRequest: (nodeId, req) => handleBridgeRequest(nodeId, req),
        onAuthenticated: async (node) => {
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-connected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-connected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
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

          try {
            const cfg = await loadVoiceWakeConfig();
            started.sendEvent({
              nodeId: node.nodeId,
              event: "voicewake.changed",
              payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
            });
          } catch {
            // Best-effort only.
          }
        },
        onDisconnected: (node) => {
          bridgeUnsubscribeAll(node.nodeId);
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-disconnected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-disconnected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
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
        },
        onEvent: handleBridgeEvent,
        onPairRequested: (request) => {
          broadcast("node.pair.requested", request, { dropIfSlow: true });
        },
      });
      if (started.port > 0) {
        bridge = started;
        defaultRuntime.log(
          `bridge listening on tcp://${bridgeHost}:${bridge.port} (node)`,
        );
      }
    } catch (err) {
      logWarn(`gateway: bridge failed to start: ${String(err)}`);
    }
  } else if (bridgeEnabled && bridgePort > 0 && !bridgeHost) {
    logWarn(
      "gateway: bridge bind policy requested tailnet IP, but no tailnet interface was found; refusing to start bridge",
    );
  }

  try {
    const sshPortEnv = process.env.CLAWDIS_SSH_PORT?.trim();
    const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
    const sshPort =
      Number.isFinite(sshPortParsed) && sshPortParsed > 0
        ? sshPortParsed
        : undefined;

    const tailnetDnsEnv = process.env.CLAWDIS_TAILNET_DNS?.trim();
    const tailnetDns = wideAreaDiscoveryEnabled
      ? WIDE_AREA_DISCOVERY_DOMAIN
      : tailnetDnsEnv && tailnetDnsEnv.length > 0
        ? tailnetDnsEnv
        : undefined;

    const bonjour = await startGatewayBonjourAdvertiser({
      instanceName: formatBonjourInstanceName(machineDisplayName),
      gatewayPort: port,
      bridgePort: bridge?.port,
      canvasPort: canvasHost?.port,
      sshPort,
      tailnetDns,
    });
    bonjourStop = bonjour.stop;
  } catch (err) {
    logWarn(`gateway: bonjour advertising failed: ${String(err)}`);
  }

  if (wideAreaDiscoveryEnabled && bridge?.port) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      logWarn(
        "gateway: discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaBridgeZone({
          bridgePort: bridge.port,
          displayName: formatBonjourInstanceName(machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
        });
        defaultRuntime.log(
          `discovery: wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${WIDE_AREA_DISCOVERY_DOMAIN} → ${result.zonePath})`,
        );
      } catch (err) {
        logWarn(`gateway: wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  broadcastHealthUpdate = (snap: HealthSummary) => {
    broadcast("health", snap, {
      stateVersion: { presence: presenceVersion, health: healthVersion },
    });
    bridgeSendToAllSubscribed("health", snap);
  };

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    broadcast("tick", payload, { dropIfSlow: true });
    bridgeSendToAllSubscribed("tick", payload);
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

    const chatLink = chatRunSessions.get(evt.runId);
    if (chatLink) {
      // Map agent bus events to chat events for WS WebChat clients.
      // Use clientRunId so the webchat can correlate with its pending promise.
      const { sessionKey, clientRunId } = chatLink;
      bridgeSendToSession(sessionKey, "agent", evt);
      const base = {
        runId: clientRunId,
        sessionKey,
        seq: evt.seq,
      };
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        chatRunBuffers.set(clientRunId, evt.data.text);
      } else if (
        evt.stream === "job" &&
        typeof evt.data?.state === "string" &&
        (evt.data.state === "done" || evt.data.state === "error")
      ) {
        const text = chatRunBuffers.get(clientRunId)?.trim() ?? "";
        chatRunBuffers.delete(clientRunId);
        if (evt.data.state === "done") {
          const payload = {
            ...base,
            state: "final",
            message: text
              ? {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                }
              : undefined,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
        } else {
          const payload = {
            ...base,
            state: "error",
            errorMessage: evt.data.error ? String(evt.data.error) : undefined,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
        }
        chatRunSessions.delete(evt.runId);
      }
    }
  });

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  void cron
    .start()
    .catch((err) => logError(`cron failed to start: ${String(err)}`));

  wss.on("connection", (socket) => {
    let client: Client | null = null;
    let closed = false;
    const connId = randomUUID();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    logWs("in", "open", { connId, remoteAddr });
    const isWebchatConnect = (params: ConnectParams | null | undefined) =>
      params?.client?.mode === "webchat" ||
      params?.client?.name === "webchat-ui";

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
          `gateway/ws closed before connect conn=${connId} remote=${remoteAddr ?? "?"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
        );
      }
      if (client && isWebchatConnect(client.connect)) {
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
          // Handshake must be a normal request:
          // { type:"req", method:"connect", params: ConnectParams }.
          if (
            !validateRequestFrame(parsed) ||
            (parsed as RequestFrame).method !== "connect" ||
            !validateConnectParams((parsed as RequestFrame).params)
          ) {
            if (validateRequestFrame(parsed)) {
              const req = parsed as RequestFrame;
              send({
                type: "res",
                id: req.id,
                ok: false,
                error: errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  req.method === "connect"
                    ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
                    : "invalid handshake: first request must be connect",
                ),
              });
            } else {
              logWarn(
                `gateway/ws invalid handshake conn=${connId} remote=${remoteAddr ?? "?"}`,
              );
            }
            socket.close(1008, "invalid handshake");
            close();
            return;
          }

          const req = parsed as RequestFrame;
          const connectParams = req.params as ConnectParams;

          // protocol negotiation
          const { minProtocol, maxProtocol } = connectParams;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            logWarn(
              `gateway/ws protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: req.id,
              ok: false,
              error: errorShape(
                ErrorCodes.INVALID_REQUEST,
                "protocol mismatch",
                {
                  details: { expectedProtocol: PROTOCOL_VERSION },
                },
              ),
            });
            socket.close(1002, "protocol mismatch");
            close();
            return;
          }

          // token auth if required
          const token = getGatewayToken();
          if (token && connectParams.auth?.token !== token) {
            logWarn(
              `gateway/ws unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: req.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }

          const shouldTrackPresence = connectParams.client.mode !== "cli";
          const presenceKey = shouldTrackPresence
            ? connectParams.client.instanceId || connId
            : undefined;

          logWs("in", "connect", {
            connId,
            client: connectParams.client.name,
            version: connectParams.client.version,
            mode: connectParams.client.mode,
            instanceId: connectParams.client.instanceId,
            platform: connectParams.client.platform,
            token: connectParams.auth?.token ? "set" : "none",
          });

          if (isWebchatConnect(connectParams)) {
            logInfo(
              `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
          }

          if (presenceKey) {
            upsertPresence(presenceKey, {
              host: connectParams.client.name || os.hostname(),
              ip: isLoopbackAddress(remoteAddr) ? undefined : remoteAddr,
              version: connectParams.client.version,
              platform: connectParams.client.platform,
              deviceFamily: connectParams.client.deviceFamily,
              modelIdentifier: connectParams.client.modelIdentifier,
              mode: connectParams.client.mode,
              instanceId: connectParams.client.instanceId,
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
          client = { socket, connect: connectParams, connId, presenceKey };

          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });

          send({ type: "res", id: req.id, ok: true, payload: helloOk });

          clients.add(client);
          void refreshHealthSnapshot({ probe: true }).catch((err) =>
            logError(`post-connect health refresh failed: ${formatError(err)}`),
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

        void (async () => {
          switch (req.method) {
            case "connect": {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "connect is only valid as the first request",
                ),
              );
              break;
            }
            case "voicewake.get": {
              try {
                const cfg = await loadVoiceWakeConfig();
                respond(true, { triggers: cfg.triggers });
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "voicewake.set": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!Array.isArray(params.triggers)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "voicewake.set requires triggers: string[]",
                  ),
                );
                break;
              }
              try {
                const triggers = normalizeVoiceWakeTriggers(params.triggers);
                const cfg = await setVoiceWakeTriggers(triggers);
                broadcastVoiceWakeChanged(cfg.triggers);
                respond(true, { triggers: cfg.triggers });
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
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
              const { sessionKey, limit } = params as {
                sessionKey: string;
                limit?: number;
              };
              const { storePath, entry } = loadSessionEntry(sessionKey);
              const sessionId = entry?.sessionId;
              const rawMessages =
                sessionId && storePath
                  ? readSessionMessages(sessionId, storePath)
                  : [];
              const hardMax = 1000;
              const defaultLimit = 200;
              const requested =
                typeof limit === "number" ? limit : defaultLimit;
              const max = Math.min(hardMax, requested);
              const sliced =
                rawMessages.length > max
                  ? rawMessages.slice(-max)
                  : rawMessages;
              const capped = capArrayByJsonBytes(
                sliced,
                MAX_CHAT_HISTORY_MESSAGES_BYTES,
              ).items;
              const thinkingLevel =
                entry?.thinkingLevel ??
                loadConfig().inbound?.agent?.thinkingDefault ??
                "off";
              respond(true, {
                sessionKey,
                sessionId,
                messages: capped,
                thinkingLevel,
              });
              break;
            }
            case "chat.abort": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateChatAbortParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
                  ),
                );
                break;
              }
              const { sessionKey, runId } = params as {
                sessionKey: string;
                runId: string;
              };
              const active = chatAbortControllers.get(runId);
              if (!active) {
                respond(true, { ok: true, aborted: false });
                break;
              }
              if (active.sessionKey !== sessionKey) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "runId does not match sessionKey",
                  ),
                );
                break;
              }

              active.controller.abort();
              chatAbortControllers.delete(runId);
              chatRunBuffers.delete(runId);
              const current = chatRunSessions.get(active.sessionId);
              if (
                current?.clientRunId === runId &&
                current.sessionKey === sessionKey
              ) {
                chatRunSessions.delete(active.sessionId);
              }

              const payload = {
                runId,
                sessionKey,
                seq: (agentRunSeq.get(active.sessionId) ?? 0) + 1,
                state: "aborted" as const,
              };
              broadcast("chat", payload);
              bridgeSendToSession(sessionKey, "chat", payload);
              respond(true, { ok: true, aborted: true });
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
              const { storePath, store, entry } = loadSessionEntry(
                p.sessionKey,
              );
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
              const clientRunId = p.idempotencyKey;

              const cached = dedupe.get(`chat:${clientRunId}`);
              if (cached) {
                respond(cached.ok, cached.payload, cached.error, {
                  cached: true,
                });
                break;
              }

              try {
                const abortController = new AbortController();
                chatAbortControllers.set(clientRunId, {
                  controller: abortController,
                  sessionId,
                  sessionKey: p.sessionKey,
                });
                chatRunSessions.set(sessionId, {
                  sessionKey: p.sessionKey,
                  clientRunId,
                });

                if (store) {
                  store[p.sessionKey] = sessionEntry;
                  if (storePath) {
                    await saveSessionStore(storePath, store);
                  }
                }

                await agentCommand(
                  {
                    message: messageWithAttachments,
                    sessionId,
                    thinking: p.thinking,
                    deliver: p.deliver,
                    timeout: Math.ceil(timeoutMs / 1000).toString(),
                    surface: "WebChat",
                    abortSignal: abortController.signal,
                  },
                  defaultRuntime,
                  deps,
                );
                const payload = {
                  runId: clientRunId,
                  status: "ok" as const,
                };
                dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { runId: clientRunId });
              } catch (err) {
                const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                const payload = {
                  runId: clientRunId,
                  status: "error" as const,
                  summary: String(err),
                };
                dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: false,
                  payload,
                  error,
                });
                respond(false, payload, error, {
                  runId: clientRunId,
                  error: formatForLog(err),
                });
              } finally {
                chatAbortControllers.delete(clientRunId);
              }
              break;
            }
            case "wake": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateWakeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                mode: "now" | "next-heartbeat";
                text: string;
              };
              const result = cron.wake({ mode: p.mode, text: p.text });
              respond(true, result, undefined);
              break;
            }
            case "cron.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { includeDisabled?: boolean };
              const jobs = await cron.list({
                includeDisabled: p.includeDisabled,
              });
              respond(true, { jobs }, undefined);
              break;
            }
            case "cron.status": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronStatusParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
                  ),
                );
                break;
              }
              const status = await cron.status();
              respond(true, status, undefined);
              break;
            }
            case "cron.add": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronAddParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
                  ),
                );
                break;
              }
              const job = await cron.add(params as unknown as CronJobCreate);
              respond(true, job, undefined);
              break;
            }
            case "cron.update": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronUpdateParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                id: string;
                patch: Record<string, unknown>;
              };
              const job = await cron.update(
                p.id,
                p.patch as unknown as CronJobPatch,
              );
              respond(true, job, undefined);
              break;
            }
            case "cron.remove": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRemoveParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string };
              const result = await cron.remove(p.id);
              respond(true, result, undefined);
              break;
            }
            case "cron.run": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRunParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string; mode?: "due" | "force" };
              const result = await cron.run(p.id, p.mode);
              respond(true, result, undefined);
              break;
            }
            case "cron.runs": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateCronRunsParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as { id: string; limit?: number };
              const logPath = resolveCronRunLogPath({
                storePath: cronStorePath,
                jobId: p.id,
              });
              const entries = await readCronRunLogEntries(logPath, {
                limit: p.limit,
                jobId: p.id,
              });
              respond(true, { entries }, undefined);
              break;
            }
            case "status": {
              const status = await getStatusSummary();
              respond(true, status, undefined);
              break;
            }
            case "sessions.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsListParams;
              const cfg = loadConfig();
              const storePath = resolveStorePath(cfg.inbound?.session?.store);
              const store = loadSessionStore(storePath);
              const result = listSessionsFromStore({
                cfg,
                storePath,
                store,
                opts: p,
              });
              respond(true, result, undefined);
              break;
            }
            case "sessions.patch": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateSessionsPatchParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as SessionsPatchParams;
              const key = String(p.key ?? "").trim();
              if (!key) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
                );
                break;
              }

              const cfg = loadConfig();
              const storePath = resolveStorePath(cfg.inbound?.session?.store);
              const store = loadSessionStore(storePath);
              const now = Date.now();

              const existing = store[key];
              const next: SessionEntry = existing
                ? {
                    ...existing,
                    updatedAt: Math.max(existing.updatedAt ?? 0, now),
                  }
                : { sessionId: randomUUID(), updatedAt: now };

              if ("thinkingLevel" in p) {
                const raw = p.thinkingLevel;
                if (raw === null) {
                  delete next.thinkingLevel;
                } else if (raw !== undefined) {
                  const normalized = normalizeThinkLevel(String(raw));
                  if (!normalized) {
                    respond(
                      false,
                      undefined,
                      errorShape(
                        ErrorCodes.INVALID_REQUEST,
                        "invalid thinkingLevel (use off|minimal|low|medium|high)",
                      ),
                    );
                    break;
                  }
                  if (normalized === "off") delete next.thinkingLevel;
                  else next.thinkingLevel = normalized;
                }
              }

              if ("verboseLevel" in p) {
                const raw = p.verboseLevel;
                if (raw === null) {
                  delete next.verboseLevel;
                } else if (raw !== undefined) {
                  const normalized = normalizeVerboseLevel(String(raw));
                  if (!normalized) {
                    respond(
                      false,
                      undefined,
                      errorShape(
                        ErrorCodes.INVALID_REQUEST,
                        'invalid verboseLevel (use "on"|"off")',
                      ),
                    );
                    break;
                  }
                  if (normalized === "off") delete next.verboseLevel;
                  else next.verboseLevel = normalized;
                }
              }

              store[key] = next;
              await saveSessionStore(storePath, store);
              const result: SessionsPatchResult = {
                ok: true,
                path: storePath,
                key,
                entry: next,
              };
              respond(true, result, undefined);
              break;
            }
            case "last-heartbeat": {
              respond(true, getLastHeartbeatEvent(), undefined);
              break;
            }
            case "set-heartbeats": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              const enabled = params.enabled;
              if (typeof enabled !== "boolean") {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "invalid set-heartbeats params: enabled (boolean) required",
                  ),
                );
                break;
              }
              setHeartbeatsEnabled(enabled);
              respond(true, { ok: true, enabled }, undefined);
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
              const platform =
                typeof params.platform === "string"
                  ? params.platform
                  : undefined;
              const deviceFamily =
                typeof params.deviceFamily === "string"
                  ? params.deviceFamily
                  : undefined;
              const modelIdentifier =
                typeof params.modelIdentifier === "string"
                  ? params.modelIdentifier
                  : undefined;
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
                platform,
                deviceFamily,
                modelIdentifier,
                lastInputSeconds,
                reason,
                tags,
              });
              const isNodePresenceLine = text.startsWith("Node:");
              const normalizedReason = (reason ?? "").toLowerCase();
              const looksPeriodic =
                normalizedReason.startsWith("periodic") ||
                normalizedReason === "heartbeat";
              if (!(isNodePresenceLine && looksPeriodic)) {
                const compactNodeText =
                  isNodePresenceLine &&
                  (host || ip || version || mode || reason)
                    ? `Node: ${host?.trim() || "Unknown"}${ip ? ` (${ip})` : ""} · app ${version?.trim() || "unknown"} · mode ${mode?.trim() || "unknown"} · reason ${reason?.trim() || "event"}`
                    : text;
                enqueueSystemEvent(compactNodeText);
              }
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
            case "node.pair.request": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairRequestParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.request params: ${formatValidationErrors(validateNodePairRequestParams.errors)}`,
                  ),
                );
                break;
              }
              const p = params as {
                nodeId: string;
                displayName?: string;
                platform?: string;
                version?: string;
                deviceFamily?: string;
                modelIdentifier?: string;
                caps?: string[];
                commands?: string[];
                remoteIp?: string;
              };
              try {
                const result = await requestNodePairing({
                  nodeId: p.nodeId,
                  displayName: p.displayName,
                  platform: p.platform,
                  version: p.version,
                  deviceFamily: p.deviceFamily,
                  modelIdentifier: p.modelIdentifier,
                  caps: p.caps,
                  commands: p.commands,
                  remoteIp: p.remoteIp,
                });
                if (result.status === "pending" && result.created) {
                  broadcast("node.pair.requested", result.request, {
                    dropIfSlow: true,
                  });
                }
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.list params: ${formatValidationErrors(validateNodePairListParams.errors)}`,
                  ),
                );
                break;
              }
              try {
                const list = await listNodePairing();
                respond(true, list, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.approve": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairApproveParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.approve params: ${formatValidationErrors(validateNodePairApproveParams.errors)}`,
                  ),
                );
                break;
              }
              const { requestId } = params as { requestId: string };
              try {
                const approved = await approveNodePairing(requestId);
                if (!approved) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
                  );
                  break;
                }
                broadcast(
                  "node.pair.resolved",
                  {
                    requestId,
                    nodeId: approved.node.nodeId,
                    decision: "approved",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
                respond(true, approved, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.reject": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairRejectParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.reject params: ${formatValidationErrors(validateNodePairRejectParams.errors)}`,
                  ),
                );
                break;
              }
              const { requestId } = params as { requestId: string };
              try {
                const rejected = await rejectNodePairing(requestId);
                if (!rejected) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
                  );
                  break;
                }
                broadcast(
                  "node.pair.resolved",
                  {
                    requestId,
                    nodeId: rejected.nodeId,
                    decision: "rejected",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
                respond(true, rejected, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.pair.verify": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodePairVerifyParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.pair.verify params: ${formatValidationErrors(validateNodePairVerifyParams.errors)}`,
                  ),
                );
                break;
              }
              const { nodeId, token } = params as {
                nodeId: string;
                token: string;
              };
              try {
                const result = await verifyNodeToken(nodeId, token);
                respond(true, result, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.list": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeListParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.list params: ${formatValidationErrors(validateNodeListParams.errors)}`,
                  ),
                );
                break;
              }

              try {
                const list = await listNodePairing();
                const pairedById = new Map(
                  list.paired.map((n) => [n.nodeId, n]),
                );

                const connected = bridge?.listConnected?.() ?? [];
                const connectedById = new Map(
                  connected.map((n) => [n.nodeId, n]),
                );

                const nodeIds = new Set<string>([
                  ...pairedById.keys(),
                  ...connectedById.keys(),
                ]);

                const nodes = [...nodeIds].map((nodeId) => {
                  const paired = pairedById.get(nodeId);
                  const live = connectedById.get(nodeId);

                  const caps = [
                    ...new Set(
                      (live?.caps ?? paired?.caps ?? [])
                        .map((c) => String(c).trim())
                        .filter(Boolean),
                    ),
                  ].sort();

                  const commands = [
                    ...new Set(
                      (live?.commands ?? paired?.commands ?? [])
                        .map((c) => String(c).trim())
                        .filter(Boolean),
                    ),
                  ].sort();

                  return {
                    nodeId,
                    displayName: live?.displayName ?? paired?.displayName,
                    platform: live?.platform ?? paired?.platform,
                    version: live?.version ?? paired?.version,
                    deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
                    modelIdentifier:
                      live?.modelIdentifier ?? paired?.modelIdentifier,
                    remoteIp: live?.remoteIp ?? paired?.remoteIp,
                    caps,
                    commands,
                    paired: Boolean(paired),
                    connected: Boolean(live),
                  };
                });

                nodes.sort((a, b) => {
                  if (a.connected !== b.connected) return a.connected ? -1 : 1;
                  const an = (a.displayName ?? a.nodeId).toLowerCase();
                  const bn = (b.displayName ?? b.nodeId).toLowerCase();
                  if (an < bn) return -1;
                  if (an > bn) return 1;
                  return a.nodeId.localeCompare(b.nodeId);
                });

                respond(true, { ts: Date.now(), nodes }, undefined);
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.describe": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeDescribeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.describe params: ${formatValidationErrors(validateNodeDescribeParams.errors)}`,
                  ),
                );
                break;
              }
              const { nodeId } = params as { nodeId: string };
              const id = String(nodeId ?? "").trim();
              if (!id) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"),
                );
                break;
              }

              try {
                const list = await listNodePairing();
                const paired = list.paired.find((n) => n.nodeId === id);
                const connected = bridge?.listConnected?.() ?? [];
                const live = connected.find((n) => n.nodeId === id);

                if (!paired && !live) {
                  respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"),
                  );
                  break;
                }

                const caps = [
                  ...new Set(
                    (live?.caps ?? paired?.caps ?? [])
                      .map((c) => String(c).trim())
                      .filter(Boolean),
                  ),
                ].sort();

                const commands = [
                  ...new Set(
                    (live?.commands ?? paired?.commands ?? [])
                      .map((c) => String(c).trim())
                      .filter(Boolean),
                  ),
                ].sort();

                respond(
                  true,
                  {
                    ts: Date.now(),
                    nodeId: id,
                    displayName: live?.displayName ?? paired?.displayName,
                    platform: live?.platform ?? paired?.platform,
                    version: live?.version ?? paired?.version,
                    deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
                    modelIdentifier:
                      live?.modelIdentifier ?? paired?.modelIdentifier,
                    remoteIp: live?.remoteIp ?? paired?.remoteIp,
                    caps,
                    commands,
                    paired: Boolean(paired),
                    connected: Boolean(live),
                  },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
              break;
            }
            case "node.invoke": {
              const params = (req.params ?? {}) as Record<string, unknown>;
              if (!validateNodeInvokeParams(params)) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `invalid node.invoke params: ${formatValidationErrors(validateNodeInvokeParams.errors)}`,
                  ),
                );
                break;
              }
              if (!bridge) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, "bridge not running"),
                );
                break;
              }
              const p = params as {
                nodeId: string;
                command: string;
                params?: unknown;
                timeoutMs?: number;
                idempotencyKey: string;
              };
              const nodeId = String(p.nodeId ?? "").trim();
              const command = String(p.command ?? "").trim();
              if (!nodeId || !command) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    "nodeId and command required",
                  ),
                );
                break;
              }

              try {
                const paramsJSON =
                  "params" in p && p.params !== undefined
                    ? JSON.stringify(p.params)
                    : null;
                const res = await bridge.invoke({
                  nodeId,
                  command,
                  paramsJSON,
                  timeoutMs: p.timeoutMs,
                });
                if (!res.ok) {
                  respond(
                    false,
                    undefined,
                    errorShape(
                      ErrorCodes.UNAVAILABLE,
                      res.error?.message ?? "node invoke failed",
                      { details: { nodeError: res.error ?? null } },
                    ),
                  );
                  break;
                }
                const payload =
                  typeof res.payloadJSON === "string" && res.payloadJSON.trim()
                    ? (() => {
                        try {
                          return JSON.parse(res.payloadJSON) as unknown;
                        } catch {
                          return { payloadJSON: res.payloadJSON };
                        }
                      })()
                    : undefined;
                respond(
                  true,
                  {
                    ok: true,
                    nodeId,
                    command,
                    payload,
                    payloadJSON: res.payloadJSON ?? null,
                  },
                  undefined,
                );
              } catch (err) {
                respond(
                  false,
                  undefined,
                  errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
                );
              }
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
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: false,
                  error,
                });
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
                typeof params.sessionKey === "string" &&
                params.sessionKey.trim()
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
                  (cfg.inbound?.session?.mainKey ?? "main").trim() || "main";
                if (requestedSessionKey === mainKey) {
                  chatRunSessions.set(sessionId, {
                    sessionKey: requestedSessionKey,
                    clientRunId: idem,
                  });
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
                  // WebChat is not a deliverable surface. Treat it as "unset" for routing,
                  // so VoiceWake and CLI callers don't get stuck with deliver=false.
                  return lastChannel && lastChannel !== "webchat"
                    ? lastChannel
                    : "whatsapp";
                }
                if (
                  requestedChannel === "whatsapp" ||
                  requestedChannel === "telegram" ||
                  requestedChannel === "webchat"
                ) {
                  return requestedChannel;
                }
                return lastChannel && lastChannel !== "webchat"
                  ? lastChannel
                  : "whatsapp";
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
        })().catch((err) => {
          logError(`gateway: request handler failed: ${formatForLog(err)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
          );
        });
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

  // Start clawd browser control server (unless disabled via config).
  void startBrowserControlServerFromConfig(defaultRuntime).catch((err) => {
    logError(`gateway: clawd browser server failed to start: ${String(err)}`);
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
      if (bonjourStop) {
        try {
          await bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (canvasHost) {
        try {
          await canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (bridge) {
        try {
          await bridge.close();
        } catch {
          /* ignore */
        }
      }
      providerAbort.abort();
      cron.stop();
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
      if (heartbeatUnsub) {
        try {
          heartbeatUnsub();
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
      await stopBrowserControlServer().catch(() => {});
      await Promise.allSettled(providerTasks);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
