import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import os from "node:os";
import chalk from "chalk";
import { type WebSocket, WebSocketServer } from "ws";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import {
  type CanvasHostHandler,
  type CanvasHostServer,
  createCanvasHostHandler,
  startCanvasHost,
} from "../canvas-host/server.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import {
  CONFIG_PATH_CLAWDBOT,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  STATE_DIR_CLAWDBOT,
  writeConfigFile,
} from "../config/config.js";
import {
  deriveDefaultBridgePort,
  deriveDefaultCanvasHostPort,
} from "../config/port-defaults.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
  resolveStorePath,
} from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { startGmailWatcher, stopGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import {
  runHeartbeatOnce,
  startHeartbeatRunner,
} from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { ensureClawdbotCliOnPath } from "../infra/path-env.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { normalizeProviderId } from "../providers/plugins/index.js";
import {
  listSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import {
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "../infra/tailnet.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
} from "../infra/tailscale.js";
import { loadVoiceWakeConfig } from "../infra/voicewake.js";
import {
  WIDE_AREA_DISCOVERY_DOMAIN,
  writeWideAreaBridgeZone,
} from "../infra/widearea-dns.js";
import { rawDataToString } from "../infra/ws.js";
import {
  createSubsystemLogger,
  getChildLogger,
  getResolvedLoggerSettings,
  runtimeForLogger,
} from "../logging.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { defaultRuntime } from "../runtime.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import type { WizardSession } from "../wizard/session.js";
import {
  assertGatewayAuthConfigured,
  authorizeGatewayConnect,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import {
  type GatewayReloadPlan,
  type ProviderKind,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { normalizeControlUiBasePath } from "./control-ui.js";
import { type HookMessageProvider, resolveHooksConfig } from "./hooks.js";
import {
  isLoopbackAddress,
  isLoopbackHost,
  resolveGatewayBindHost,
} from "./net.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  type RequestFrame,
  type Snapshot,
  validateConnectParams,
  validateRequestFrame,
} from "./protocol/index.js";
import { createBridgeHandlers } from "./server-bridge.js";
import {
  type BridgeListConnectedFn,
  type BridgeSendEventFn,
  createBridgeSubscriptionManager,
} from "./server-bridge-subscriptions.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createAgentEventHandler, createChatRunState } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HANDSHAKE_TIMEOUT_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";
import {
  attachGatewayUpgradeHandler,
  createGatewayHttpServer,
  createHooksRequestHandler,
} from "./server-http.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createProviderManager } from "./server-providers.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog, logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

ensureClawdbotCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logBridge = log.child("bridge");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logProviders = log.child("providers");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logWsControl = log.child("ws");
const logWhatsApp = logProviders.child("whatsapp");
const logTelegram = logProviders.child("telegram");
const logDiscord = logProviders.child("discord");
const logSlack = logProviders.child("slack");
const logSignal = logProviders.child("signal");
const logIMessage = logProviders.child("imessage");
const logMSTeams = logProviders.child("msteams");
const canvasRuntime = runtimeForLogger(logCanvas);
const whatsappRuntimeEnv = runtimeForLogger(logWhatsApp);
const telegramRuntimeEnv = runtimeForLogger(logTelegram);
const discordRuntimeEnv = runtimeForLogger(logDiscord);
const slackRuntimeEnv = runtimeForLogger(logSlack);
const signalRuntimeEnv = runtimeForLogger(logSignal);
const imessageRuntimeEnv = runtimeForLogger(logIMessage);
const msteamsRuntimeEnv = runtimeForLogger(logMSTeams);

type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

async function loadGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: loadConfig() });
}

type Client = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
};

const METHODS = [
  "health",
  "logs.tail",
  "providers.status",
  "status",
  "usage.status",
  "config.get",
  "config.set",
  "config.apply",
  "config.schema",
  "wizard.start",
  "wizard.next",
  "wizard.cancel",
  "wizard.status",
  "talk.mode",
  "models.list",
  "agents.list",
  "skills.status",
  "skills.install",
  "skills.update",
  "update.run",
  "voicewake.get",
  "voicewake.set",
  "sessions.list",
  "sessions.patch",
  "sessions.reset",
  "sessions.delete",
  "sessions.compact",
  "last-heartbeat",
  "set-heartbeats",
  "wake",
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "node.rename",
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
  "agent.wait",
  "web.login.start",
  "web.login.wait",
  "web.logout",
  "telegram.logout",
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
  "talk.mode",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "voicewake.changed",
];

export type GatewayServer = {
  close: (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
  }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer tailnet, else LAN
   */
  bind?: import("../config/config.js").BridgeBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the onboarding wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

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
    // Surface resolved paths so UIs can display the true config location.
    configPath: CONFIG_PATH_CLAWDBOT,
    stateDir: STATE_DIR_CLAWDBOT,
  };
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
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // Ensure all default port derivations (browser/bridge/canvas) see the actual runtime port.
  process.env.CLAWDBOT_GATEWAY_PORT = String(port);

  const configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(
      configSnapshot.parsed,
    );
    if (!migrated) {
      throw new Error(
        'Legacy config entries detected but auto-migration failed. Run "clawdbot doctor" to migrate.',
      );
    }
    await writeConfigFile(migrated);
    if (changes.length > 0) {
      log.info(
        `gateway: migrated legacy config entries:\n${changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    }
  }

  const cfgAtStart = loadConfig();
  await autoMigrateLegacyState({ cfg: cfgAtStart, log });
  const bindMode = opts.bind ?? cfgAtStart.gateway?.bind ?? "loopback";
  const bindHost = opts.host ?? resolveGatewayBindHost(bindMode);
  if (!bindHost) {
    throw new Error(
      "gateway bind is tailnet, but no tailnet interface was found; refusing to start gateway",
    );
  }
  const controlUiEnabled =
    opts.controlUiEnabled ?? cfgAtStart.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsEnabled =
    opts.openAiChatCompletionsEnabled ??
    cfgAtStart.gateway?.http?.endpoints?.chatCompletions?.enabled ??
    false;
  const controlUiBasePath = normalizeControlUiBasePath(
    cfgAtStart.gateway?.controlUi?.basePath,
  );
  const authBase = cfgAtStart.gateway?.auth ?? {};
  const authOverrides = opts.auth ?? {};
  const authConfig = {
    ...authBase,
    ...authOverrides,
  };
  const tailscaleBase = cfgAtStart.gateway?.tailscale ?? {};
  const tailscaleOverrides = opts.tailscale ?? {};
  const tailscaleConfig = {
    ...tailscaleBase,
    ...tailscaleOverrides,
  };
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  let hooksConfig = resolveHooksConfig(cfgAtStart);
  const canvasHostEnabled =
    process.env.CLAWDBOT_SKIP_CANVAS_HOST !== "1" &&
    cfgAtStart.canvasHost?.enabled !== false;
  assertGatewayAuthConfigured(resolvedAuth);
  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or CLAWDBOT_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error(
      "tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)",
    );
  }
  if (!isLoopbackHost(bindHost) && authMode === "none") {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${port} without auth (set gateway.auth.token or CLAWDBOT_GATEWAY_TOKEN, or pass --token)`,
    );
  }

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const wizardSessions = new Map<string, WizardSession>();

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() === "running") return id;
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) return;
    if (session.getStatus() === "running") return;
    wizardSessions.delete(id);
  };

  const dispatchWakeHook = (value: {
    text: string;
    mode: "now" | "next-heartbeat";
  }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    provider: HookMessageProvider;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  }) => {
    const sessionKey = value.sessionKey.trim()
      ? value.sessionKey.trim()
      : `hook:${randomUUID()}`;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        provider: value.provider,
        to: value.to,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary =
          result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok"
            ? `Hook ${value.name}`
            : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };
  let canvasHost: CanvasHostHandler | null = null;
  let canvasHostServer: CanvasHostServer | null = null;
  if (canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: opts.allowCanvasHostInTests,
        liveReload: cfgAtStart.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        logCanvas.info(
          `canvas host mounted at http://${bindHost}:${port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const handleHooksRequest = createHooksRequestHandler({
    getHooksConfig: () => hooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });

  const httpServer: HttpServer = createGatewayHttpServer({
    canvasHost,
    controlUiEnabled,
    controlUiBasePath,
    openAiChatCompletionsEnabled,
    handleHooksRequest,
    resolvedAuth,
  });
  let bonjourStop: (() => Promise<void>) | null = null;
  let bridge: Awaited<ReturnType<typeof startNodeBridgeServer>> | null = null;
  const bridgeSubscriptions = createBridgeSubscriptionManager();

  const isMobilePlatform = (platform: unknown): boolean => {
    const p = typeof platform === "string" ? platform.trim().toLowerCase() : "";
    if (!p) return false;
    return (
      p.startsWith("ios") || p.startsWith("ipados") || p.startsWith("android")
    );
  };

  const hasConnectedMobileNode = (): boolean => {
    const connected = bridge?.listConnected?.() ?? [];
    return connected.some((n) => isMobilePlatform(n.platform));
  };
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
      httpServer.listen(port, bindHost);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new GatewayLockError(
        `another gateway instance is already listening on ws://${bindHost}:${port}`,
        err,
      );
    }
    throw new GatewayLockError(
      `failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`,
      err,
    );
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  attachGatewayUpgradeHandler({ httpServer, wss, canvasHost });
  const clients = new Set<Client>();
  let seq = 0;
  // Track per-run sequence to detect out-of-order/lost agent events.
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const resolveSessionKeyForRun = (runId: string) => {
    const cached = getAgentRunContext(runId)?.sessionKey;
    if (cached) return cached;
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const found = Object.entries(store).find(
      ([, entry]) => entry?.sessionId === runId,
    );
    const sessionKey = found?.[0];
    if (sessionKey) {
      registerAgentRunContext(runId, { sessionKey });
    }
    return sessionKey;
  };
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  setCommandLaneConcurrency("cron", cfgAtStart.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(
    "main",
    cfgAtStart.agents?.defaults?.maxConcurrent ?? 1,
  );
  setCommandLaneConcurrency(
    "subagent",
    cfgAtStart.agents?.defaults?.subagents?.maxConcurrent ?? 1,
  );

  const cronLogger = getChildLogger({
    module: "cron",
  });
  const deps = createDefaultDeps();
  const buildCronService = (cfg: ReturnType<typeof loadConfig>) => {
    const storePath = resolveCronStorePath(cfg.cron?.store);
    const cronEnabled =
      process.env.CLAWDBOT_SKIP_CRON !== "1" && cfg.cron?.enabled !== false;
    const cron = new CronService({
      storePath,
      cronEnabled,
      enqueueSystemEvent: (text) => {
        enqueueSystemEvent(text, { sessionKey: resolveMainSessionKey(cfg) });
      },
      requestHeartbeatNow,
      runHeartbeatOnce: async (opts) => {
        const runtimeConfig = loadConfig();
        return await runHeartbeatOnce({
          cfg: runtimeConfig,
          reason: opts?.reason,
          deps: { ...deps, runtime: defaultRuntime },
        });
      },
      runIsolatedAgentJob: async ({ job, message }) => {
        const runtimeConfig = loadConfig();
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps,
          job,
          message,
          sessionKey: `cron:${job.id}`,
          lane: "cron",
        });
      },
      log: getChildLogger({ module: "cron", storePath }),
      onEvent: (evt) => {
        broadcast("cron", evt, { dropIfSlow: true });
        if (evt.action === "finished") {
          const logPath = resolveCronRunLogPath({
            storePath,
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
    return { cron, storePath, cronEnabled };
  };

  let { cron, storePath: cronStorePath } = buildCronService(cfgAtStart);

  const providerManager = createProviderManager({
    loadConfig,
    logWhatsApp,
    logTelegram,
    logDiscord,
    logSlack,
    logSignal,
    logIMessage,
    logMSTeams,
    whatsappRuntimeEnv,
    telegramRuntimeEnv,
    discordRuntimeEnv,
    slackRuntimeEnv,
    signalRuntimeEnv,
    imessageRuntimeEnv,
    msteamsRuntimeEnv,
  });
  const {
    getRuntimeSnapshot,
    startProviders,
    startProvider,
    stopProvider,
    startWhatsAppProvider,
    startTelegramProvider,
    startDiscordProvider,
    startSlackProvider,
    startSignalProvider,
    startIMessageProvider,
    stopWhatsAppProvider,
    stopTelegramProvider,
    stopDiscordProvider,
    stopSlackProvider,
    stopSignalProvider,
    stopIMessageProvider,
    stopMSTeamsProvider,
    markProviderLoggedOut,
  } = providerManager;

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
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);
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
    return process.env.CLAWDBOT_BRIDGE_ENABLED !== "0";
  })();

  const bridgePort = (() => {
    if (
      typeof cfgAtStart.bridge?.port === "number" &&
      cfgAtStart.bridge.port > 0
    ) {
      return cfgAtStart.bridge.port;
    }
    if (process.env.CLAWDBOT_BRIDGE_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDBOT_BRIDGE_PORT, 10);
      return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : deriveDefaultBridgePort(port);
    }
    return deriveDefaultBridgePort(port);
  })();

  const bridgeHost = (() => {
    // Back-compat: allow an env var override when no bind policy is configured.
    if (cfgAtStart.bridge?.bind === undefined) {
      const env = process.env.CLAWDBOT_BRIDGE_HOST?.trim();
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

  const canvasHostPort = (() => {
    if (process.env.CLAWDBOT_CANVAS_HOST_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDBOT_CANVAS_HOST_PORT, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return deriveDefaultCanvasHostPort(port);
    }
    const configured = cfgAtStart.canvasHost?.port;
    if (typeof configured === "number" && configured > 0) return configured;
    return deriveDefaultCanvasHostPort(port);
  })();

  if (canvasHostEnabled && bridgeEnabled && bridgeHost) {
    try {
      const started = await startCanvasHost({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        port: canvasHostPort,
        listenHost: bridgeHost,
        allowInTests: opts.allowCanvasHostInTests,
        liveReload: cfgAtStart.canvasHost?.liveReload,
        handler: canvasHost ?? undefined,
        ownsHandler: canvasHost ? false : undefined,
      });
      if (started.port > 0) {
        canvasHostServer = started;
      }
    } catch (err) {
      logCanvas.warn(
        `failed to start on ${bridgeHost}:${canvasHostPort}: ${String(err)}`,
      );
    }
  }

  const bridgeSubscribe = bridgeSubscriptions.subscribe;
  const bridgeUnsubscribe = bridgeSubscriptions.unsubscribe;
  const bridgeUnsubscribeAll = bridgeSubscriptions.unsubscribeAll;
  const bridgeSendEvent: BridgeSendEventFn = (opts) => {
    bridge?.sendEvent(opts);
  };
  const bridgeListConnected: BridgeListConnectedFn = () =>
    bridge?.listConnected() ?? [];
  const bridgeSendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
  ) =>
    bridgeSubscriptions.sendToSession(
      sessionKey,
      event,
      payload,
      bridgeSendEvent,
    );
  const bridgeSendToAllSubscribed = (event: string, payload: unknown) =>
    bridgeSubscriptions.sendToAllSubscribed(event, payload, bridgeSendEvent);
  const bridgeSendToAllConnected = (event: string, payload: unknown) =>
    bridgeSubscriptions.sendToAllConnected(
      event,
      payload,
      bridgeListConnected,
      bridgeSendEvent,
    );

  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    const payload = { triggers };
    broadcast("voicewake.changed", payload, { dropIfSlow: true });
    bridgeSendToAllConnected("voicewake.changed", payload);
  };

  const { handleBridgeRequest, handleBridgeEvent } = createBridgeHandlers({
    deps,
    broadcast,
    bridgeSendToSession,
    bridgeSubscribe,
    bridgeUnsubscribe,
    broadcastVoiceWakeChanged,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    chatAbortedRuns: chatRunState.abortedRuns,
    chatRunBuffers,
    chatDeltaSentAt,
    dedupe,
    agentRunSeq,
    getHealthCache: () => healthCache,
    refreshHealthSnapshot,
    loadGatewayModelCatalog,
    logBridge,
  });

  const machineDisplayName = await getMachineDisplayName();
  const canvasHostPortForBridge = canvasHostServer?.port;
  const canvasHostHostForBridge =
    canvasHostServer &&
    bridgeHost &&
    bridgeHost !== "0.0.0.0" &&
    bridgeHost !== "::"
      ? bridgeHost
      : undefined;

  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();

  const stopNodePresenceTimer = (nodeId: string) => {
    const timer = nodePresenceTimers.get(nodeId);
    if (timer) {
      clearInterval(timer);
    }
    nodePresenceTimers.delete(nodeId);
  };

  const beaconNodePresence = (
    node: {
      nodeId: string;
      displayName?: string;
      remoteIp?: string;
      version?: string;
      platform?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
    },
    reason: string,
  ) => {
    const host = node.displayName?.trim() || node.nodeId;
    const rawIp = node.remoteIp?.trim();
    const ip = rawIp && !isLoopbackAddress(rawIp) ? rawIp : undefined;
    const version = node.version?.trim() || "unknown";
    const platform = node.platform?.trim() || undefined;
    const deviceFamily = node.deviceFamily?.trim() || undefined;
    const modelIdentifier = node.modelIdentifier?.trim() || undefined;
    const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason ${reason}`;
    upsertPresence(node.nodeId, {
      host,
      ip,
      version,
      platform,
      deviceFamily,
      modelIdentifier,
      mode: "remote",
      reason,
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
  };

  const startNodePresenceTimer = (node: { nodeId: string }) => {
    stopNodePresenceTimer(node.nodeId);
    nodePresenceTimers.set(
      node.nodeId,
      setInterval(() => {
        beaconNodePresence(node, "periodic");
      }, 180_000),
    );
  };

  if (bridgeEnabled && bridgePort > 0 && bridgeHost) {
    try {
      const started = await startNodeBridgeServer({
        host: bridgeHost,
        port: bridgePort,
        serverName: machineDisplayName,
        canvasHostPort: canvasHostPortForBridge,
        canvasHostHost: canvasHostHostForBridge,
        onRequest: (nodeId, req) => handleBridgeRequest(nodeId, req),
        onAuthenticated: async (node) => {
          beaconNodePresence(node, "node-connected");
          startNodePresenceTimer(node);

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
          stopNodePresenceTimer(node.nodeId);
          beaconNodePresence(node, "node-disconnected");
        },
        onEvent: handleBridgeEvent,
        onPairRequested: (request) => {
          broadcast("node.pair.requested", request, { dropIfSlow: true });
        },
      });
      if (started.port > 0) {
        bridge = started;
        logBridge.info(
          `listening on tcp://${bridgeHost}:${bridge.port} (node)`,
        );
      }
    } catch (err) {
      logBridge.warn(`failed to start: ${String(err)}`);
    }
  } else if (bridgeEnabled && bridgePort > 0 && !bridgeHost) {
    logBridge.warn(
      "bind policy requested tailnet IP, but no tailnet interface was found; refusing to start bridge",
    );
  }

  const tailnetDns = await resolveTailnetDnsHint();
  const sshPortEnv = process.env.CLAWDBOT_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
  const sshPort =
    Number.isFinite(sshPortParsed) && sshPortParsed > 0
      ? sshPortParsed
      : undefined;

  try {
    const bonjour = await startGatewayBonjourAdvertiser({
      instanceName: formatBonjourInstanceName(machineDisplayName),
      gatewayPort: port,
      bridgePort: bridge?.port,
      canvasPort: canvasHostPortForBridge,
      sshPort,
      tailnetDns,
      cliPath: resolveBonjourCliPath(),
    });
    bonjourStop = bonjour.stop;
  } catch (err) {
    logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
  }

  if (wideAreaDiscoveryEnabled && bridge?.port) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaBridgeZone({
          bridgePort: bridge.port,
          gatewayPort: port,
          displayName: formatBonjourInstanceName(machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          tailnetDns,
          sshPort,
          cliPath: resolveBonjourCliPath(),
        });
        logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${WIDE_AREA_DISCOVERY_DOMAIN} → ${result.zonePath})`,
        );
      } catch (err) {
        logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
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
      logHealth.error(`refresh failed: ${formatError(err)}`),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void refreshHealthSnapshot({ probe: true }).catch((err) =>
    logHealth.error(`initial refresh failed: ${formatError(err)}`),
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

    for (const [runId, entry] of chatAbortControllers) {
      if (now <= entry.expiresAtMs) continue;
      abortChatRunById(
        {
          chatAbortControllers,
          chatRunBuffers,
          chatDeltaSentAt,
          chatAbortedRuns: chatRunState.abortedRuns,
          removeChatRun,
          agentRunSeq,
          broadcast,
          bridgeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "timeout" },
      );
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortedAt] of chatRunState.abortedRuns) {
      if (now - abortedAt <= ABORTED_RUN_TTL_MS) continue;
      chatRunState.abortedRuns.delete(runId);
      chatRunBuffers.delete(runId);
      chatDeltaSentAt.delete(runId);
    }
  }, 60_000);

  const agentUnsub = onAgentEvent(
    createAgentEventHandler({
      broadcast,
      bridgeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun,
      clearAgentRunContext,
    }),
  );

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  let heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  void cron
    .start()
    .catch((err) => logCron.error(`failed to start: ${String(err)}`));

  wss.on("connection", (socket, upgradeReq) => {
    let client: Client | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const requestHost = headerValue(upgradeReq.headers.host);
    const requestOrigin = headerValue(upgradeReq.headers.origin);
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
    const canvasHostPortForWs =
      canvasHostServer?.port ?? (canvasHost ? port : undefined);
    const canvasHostOverride =
      bridgeHost && bridgeHost !== "0.0.0.0" && bridgeHost !== "::"
        ? bridgeHost
        : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServer ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });
    logWs("in", "open", { connId, remoteAddr });
    const isWebchatConnect = (params: ConnectParams | null | undefined) =>
      params?.client?.mode === "webchat" ||
      params?.client?.name === "webchat-ui";
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) closeCause = cause;
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

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
      logWsControl.warn(
        `error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`,
      );
      close();
    });
    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        durationMs,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        host: requestHost,
        origin: requestOrigin,
        userAgent: requestUserAgent,
        forwardedFor,
        ...closeMeta,
      };
      if (!client) {
        logWsControl.warn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
          closeContext,
        );
      }
      if (client && isWebchatConnect(client.connect)) {
        logWsControl.info(
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
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
      });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
        });
        logWsControl.warn(
          `handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`,
        );
        close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", async (data) => {
      if (closed) return;
      const text = rawDataToString(data);
      try {
        const parsed = JSON.parse(text);
        const frameType =
          parsed && typeof parsed === "object" && "type" in parsed
            ? typeof (parsed as { type?: unknown }).type === "string"
              ? String((parsed as { type?: unknown }).type)
              : undefined
            : undefined;
        const frameMethod =
          parsed && typeof parsed === "object" && "method" in parsed
            ? typeof (parsed as { method?: unknown }).method === "string"
              ? String((parsed as { method?: unknown }).method)
              : undefined
            : undefined;
        const frameId =
          parsed && typeof parsed === "object" && "id" in parsed
            ? typeof (parsed as { id?: unknown }).id === "string"
              ? String((parsed as { id?: unknown }).id)
              : undefined
            : undefined;
        if (frameType || frameMethod || frameId) {
          lastFrameType = frameType;
          lastFrameMethod = frameMethod;
          lastFrameId = frameId;
        }
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
              logWsControl.warn(
                `invalid handshake conn=${connId} remote=${remoteAddr ?? "?"}`,
              );
            }
            handshakeState = "failed";
            const handshakeError = validateRequestFrame(parsed)
              ? (parsed as RequestFrame).method === "connect"
                ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
                : "invalid handshake: first request must be connect"
              : "invalid request frame";
            setCloseCause("invalid-handshake", {
              frameType,
              frameMethod,
              frameId,
              handshakeError,
            });
            socket.close(1008, "invalid handshake");
            close();
            return;
          }

          const frame = parsed as RequestFrame;
          const connectParams = frame.params as ConnectParams;

          // protocol negotiation
          const { minProtocol, maxProtocol } = connectParams;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            handshakeState = "failed";
            logWsControl.warn(
              `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            setCloseCause("protocol-mismatch", {
              minProtocol,
              maxProtocol,
              expectedProtocol: PROTOCOL_VERSION,
              client: connectParams.client.name,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
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

          const authResult = await authorizeGatewayConnect({
            auth: resolvedAuth,
            connectAuth: connectParams.auth,
            req: upgradeReq,
          });
          if (!authResult.ok) {
            handshakeState = "failed";
            logWsControl.warn(
              `unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            const authProvided = connectParams.auth?.token
              ? "token"
              : connectParams.auth?.password
                ? "password"
                : "none";
            setCloseCause("unauthorized", {
              authMode: resolvedAuth.mode,
              authProvided,
              authReason: authResult.reason,
              allowTailscale: resolvedAuth.allowTailscale,
              client: connectParams.client.name,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }
          const authMethod = authResult.method ?? "none";

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
            auth: authMethod,
          });

          if (isWebchatConnect(connectParams)) {
            logWsControl.info(
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
                process.env.CLAWDBOT_VERSION ??
                process.env.npm_package_version ??
                "dev",
              commit: process.env.GIT_COMMIT,
              host: os.hostname(),
              connId,
            },
            features: { methods: METHODS, events: EVENTS },
            snapshot,
            canvasHostUrl,
            policy: {
              maxPayload: MAX_PAYLOAD_BYTES,
              maxBufferedBytes: MAX_BUFFERED_BYTES,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          };

          clearTimeout(handshakeTimer);
          client = { socket, connect: connectParams, connId, presenceKey };
          handshakeState = "connected";

          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });

          send({ type: "res", id: frame.id, ok: true, payload: helloOk });

          clients.add(client);
          void refreshHealthSnapshot({ probe: true }).catch((err) =>
            logHealth.error(
              `post-connect health refresh failed: ${formatError(err)}`,
            ),
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
            errorCode: error?.code,
            errorMessage: error?.message,
            ...meta,
          });
        };

        void (async () => {
          await handleGatewayRequest({
            req,
            respond,
            client,
            isWebchatConnect,
            context: {
              deps,
              cron,
              cronStorePath,
              loadGatewayModelCatalog,
              getHealthCache: () => healthCache,
              refreshHealthSnapshot,
              logHealth,
              logGateway: log,
              incrementPresenceVersion: () => {
                presenceVersion += 1;
                return presenceVersion;
              },
              getHealthVersion: () => healthVersion,
              broadcast,
              bridge,
              bridgeSendToSession,
              hasConnectedMobileNode,
              agentRunSeq,
              chatAbortControllers,
              chatAbortedRuns: chatRunState.abortedRuns,
              chatRunBuffers,
              chatDeltaSentAt,
              addChatRun,
              removeChatRun,
              dedupe,
              wizardSessions,
              findRunningWizard,
              purgeWizardSession,
              getRuntimeSnapshot,
              startWhatsAppProvider,
              stopWhatsAppProvider,
              startTelegramProvider,
              stopTelegramProvider,
              startDiscordProvider,
              stopDiscordProvider,
              startSlackProvider,
              stopSlackProvider,
              startSignalProvider,
              stopSignalProvider,
              startIMessageProvider,
              stopIMessageProvider,
              markProviderLoggedOut,
              wizardRunner,
              broadcastVoiceWakeChanged,
            },
          });
        })().catch((err) => {
          log.error(`request handler failed: ${formatForLog(err)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
          );
        });
      } catch (err) {
        log.error(`parse/handle error: ${String(err)}`);
        logWs("out", "parse-error", { connId, error: formatForLog(err) });
        // If still in handshake, close; otherwise respond error
        if (!client) {
          close();
        }
      }
    });
  });

  const { provider: agentProvider, model: agentModel } =
    resolveConfiguredModelRef({
      cfg: cfgAtStart,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  const modelRef = `${agentProvider}/${agentModel}`;
  log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  log.info(`listening on ws://${bindHost}:${port} (PID ${process.pid})`);
  log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (isNixMode) {
    log.info("gateway: running in Nix mode (config managed externally)");
  }
  let tailscaleCleanup: (() => Promise<void>) | null = null;
  if (tailscaleMode !== "off") {
    try {
      if (tailscaleMode === "serve") {
        await enableTailscaleServe(port);
      } else {
        await enableTailscaleFunnel(port);
      }
      const host = await getTailnetHostname().catch(() => null);
      if (host) {
        const uiPath = controlUiBasePath ? `${controlUiBasePath}/` : "/";
        logTailscale.info(
          `${tailscaleMode} enabled: https://${host}${uiPath} (WS via wss://${host})`,
        );
      } else {
        logTailscale.info(`${tailscaleMode} enabled`);
      }
    } catch (err) {
      logTailscale.warn(
        `${tailscaleMode} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (tailscaleConfig.resetOnExit) {
      tailscaleCleanup = async () => {
        try {
          if (tailscaleMode === "serve") {
            await disableTailscaleServe();
          } else {
            await disableTailscaleFunnel();
          }
        } catch (err) {
          logTailscale.warn(
            `${tailscaleMode} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
    }
  }

  // Start clawd browser control server (unless disabled via config).
  let browserControl: Awaited<
    ReturnType<typeof startBrowserControlServerIfEnabled>
  > = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (process.env.CLAWDBOT_SKIP_GMAIL_WATCHER !== "1") {
    try {
      const gmailResult = await startGmailWatcher(cfgAtStart);
      if (gmailResult.started) {
        logHooks.info("gmail watcher started");
      } else if (
        gmailResult.reason &&
        gmailResult.reason !== "hooks not enabled" &&
        gmailResult.reason !== "no gmail account configured"
      ) {
        logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Validate hooks.gmail.model if configured.
  if (cfgAtStart.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: cfgAtStart,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } =
        resolveConfiguredModelRef({
          cfg: cfgAtStart,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
      const catalog = await loadModelCatalog({ config: cfgAtStart });
      const status = getModelRefStatus({
        cfg: cfgAtStart,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Launch configured providers (WhatsApp Web, Discord, Slack, Telegram) so gateway replies via the
  // surface the message came from. Tests can opt out via CLAWDBOT_SKIP_PROVIDERS.
  if (process.env.CLAWDBOT_SKIP_PROVIDERS !== "1") {
    try {
      await startProviders();
    } catch (err) {
      logProviders.error(`provider startup failed: ${String(err)}`);
    }
  } else {
    logProviders.info("skipping provider start (CLAWDBOT_SKIP_PROVIDERS=1)");
  }

  const scheduleRestartSentinelWake = async () => {
    const sentinel = await consumeRestartSentinel();
    if (!sentinel) return;
    const payload = sentinel.payload;
    const sessionKey = payload.sessionKey?.trim();
    const message = formatRestartSentinelMessage(payload);
    const summary = summarizeRestartSentinel(payload);

    if (!sessionKey) {
      const mainSessionKey = resolveMainSessionKeyFromConfig();
      enqueueSystemEvent(message, { sessionKey: mainSessionKey });
      return;
    }

    const { cfg, entry } = loadSessionEntry(sessionKey);
    const lastProvider =
      entry?.lastProvider && entry.lastProvider !== "webchat"
        ? entry.lastProvider
        : undefined;
    const lastTo = entry?.lastTo?.trim();
    const parsedTarget = resolveAnnounceTargetFromKey(sessionKey);
    const providerRaw = lastProvider ?? parsedTarget?.provider;
    const provider =
      providerRaw && providerRaw !== "webchat"
        ? normalizeProviderId(providerRaw) ?? providerRaw
        : undefined;
    const to = lastTo || parsedTarget?.to;
    if (!provider || !to) {
      enqueueSystemEvent(message, { sessionKey });
      return;
    }

    const resolved = resolveOutboundTarget({
      provider,
      to,
      cfg,
      accountId: parsedTarget?.accountId ?? entry?.lastAccountId,
      mode: "implicit",
    });
    if (!resolved.ok) {
      enqueueSystemEvent(message, { sessionKey });
      return;
    }

    try {
      await agentCommand(
        {
          message,
          sessionKey,
          to: resolved.to,
          provider,
          deliver: true,
          bestEffortDeliver: true,
          messageProvider: provider,
        },
        defaultRuntime,
        deps,
      );
    } catch (err) {
      enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
    }
  };

  const shouldWakeFromSentinel =
    !process.env.VITEST && process.env.NODE_ENV !== "test";
  if (shouldWakeFromSentinel) {
    setTimeout(() => {
      void scheduleRestartSentinelWake();
    }, 750);
  }

  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    if (plan.reloadHooks) {
      try {
        hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        logHooks.warn(`hooks config reload failed: ${String(err)}`);
      }
    }

    if (plan.restartHeartbeat) {
      heartbeatRunner.stop();
      heartbeatRunner = startHeartbeatRunner({ cfg: nextConfig });
    }

    if (plan.restartCron) {
      cron.stop();
      const next = buildCronService(nextConfig);
      cron = next.cron;
      cronStorePath = next.storePath;
      void cron
        .start()
        .catch((err) => logCron.error(`failed to start: ${String(err)}`));
    }

    if (plan.restartBrowserControl) {
      if (browserControl) {
        await browserControl.stop().catch(() => {});
      }
      try {
        browserControl = await startBrowserControlServerIfEnabled();
      } catch (err) {
        logBrowser.error(`server failed to start: ${String(err)}`);
      }
    }

    if (plan.restartGmailWatcher) {
      await stopGmailWatcher().catch(() => {});
      if (process.env.CLAWDBOT_SKIP_GMAIL_WATCHER !== "1") {
        try {
          const gmailResult = await startGmailWatcher(nextConfig);
          if (gmailResult.started) {
            logHooks.info("gmail watcher started");
          } else if (
            gmailResult.reason &&
            gmailResult.reason !== "hooks not enabled" &&
            gmailResult.reason !== "no gmail account configured"
          ) {
            logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
          }
        } catch (err) {
          logHooks.error(`gmail watcher failed to start: ${String(err)}`);
        }
      } else {
        logHooks.info(
          "skipping gmail watcher restart (CLAWDBOT_SKIP_GMAIL_WATCHER=1)",
        );
      }
    }

    if (plan.restartProviders.size > 0) {
      if (process.env.CLAWDBOT_SKIP_PROVIDERS === "1") {
        logProviders.info(
          "skipping provider reload (CLAWDBOT_SKIP_PROVIDERS=1)",
        );
      } else {
        const restartProvider = async (name: ProviderKind) => {
          logProviders.info(`restarting ${name} provider`);
          await stopProvider(name);
          await startProvider(name);
        };
        for (const provider of plan.restartProviders) {
          await restartProvider(provider);
        }
      }
    }

    setCommandLaneConcurrency("cron", nextConfig.cron?.maxConcurrentRuns ?? 1);
    setCommandLaneConcurrency(
      "main",
      nextConfig.agents?.defaults?.maxConcurrent ?? 1,
    );
    setCommandLaneConcurrency(
      "subagent",
      nextConfig.agents?.defaults?.subagents?.maxConcurrent ?? 1,
    );

    if (plan.hotReasons.length > 0) {
      logReload.info(
        `config hot reload applied (${plan.hotReasons.join(", ")})`,
      );
    } else if (plan.noopPaths.length > 0) {
      logReload.info(
        `config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`,
      );
    }
  };

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    _nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    logReload.warn(`config change requires gateway restart (${reasons})`);
    if (process.listenerCount("SIGUSR1") === 0) {
      logReload.warn("no SIGUSR1 listener found; restart skipped");
      return;
    }
    process.emit("SIGUSR1");
  };

  const configReloader = startGatewayConfigReloader({
    initialConfig: cfgAtStart,
    readSnapshot: readConfigFileSnapshot,
    onHotReload: applyHotReload,
    onRestart: requestGatewayRestart,
    log: {
      info: (msg) => logReload.info(msg),
      warn: (msg) => logReload.warn(msg),
      error: (msg) => logReload.error(msg),
    },
    watchPath: CONFIG_PATH_CLAWDBOT,
  });

  return {
    close: async (opts) => {
      const reasonRaw =
        typeof opts?.reason === "string" ? opts.reason.trim() : "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" &&
        Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      if (bonjourStop) {
        try {
          await bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (tailscaleCleanup) {
        await tailscaleCleanup();
      }
      if (canvasHost) {
        try {
          await canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (canvasHostServer) {
        try {
          await canvasHostServer.close();
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
      await stopWhatsAppProvider();
      await stopTelegramProvider();
      await stopDiscordProvider();
      await stopSlackProvider();
      await stopSignalProvider();
      await stopIMessageProvider();
      await stopMSTeamsProvider();
      await stopGmailWatcher();
      cron.stop();
      heartbeatRunner.stop();
      for (const timer of nodePresenceTimers.values()) {
        clearInterval(timer);
      }
      nodePresenceTimers.clear();
      broadcast("shutdown", {
        reason,
        restartExpectedMs,
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
      chatRunState.clear();
      for (const c of clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await configReloader.stop().catch(() => {});
      if (browserControl) {
        await browserControl.stop().catch(() => {});
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
