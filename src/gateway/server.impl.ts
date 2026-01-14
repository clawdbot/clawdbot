import type { Server as HttpServer } from "node:http";
import chalk from "chalk";
import { WebSocketServer } from "ws";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
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
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import {
  type CanvasHostHandler,
  type CanvasHostServer,
  createCanvasHostHandler,
  startCanvasHost,
} from "../canvas-host/server.js";
import {
  type ChannelId,
  listChannelPlugins,
  normalizeChannelId,
} from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { HealthSummary } from "../commands/health.js";
import {
  CONFIG_PATH_CLAWDBOT,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import {
  deriveDefaultBridgePort,
  deriveDefaultCanvasHostPort,
} from "../config/port-defaults.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveMainSessionKeyFromConfig,
  resolveStorePath,
} from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { startGmailWatcher, stopGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
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
import {
  createSubsystemLogger,
  getChildLogger,
  getResolvedLoggerSettings,
  runtimeForLogger,
} from "../logging.js";
import { loadClawdbotPlugins } from "../plugins/loader.js";
import {
  type PluginServicesHandle,
  startPluginServices,
} from "../plugins/services.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import type { WizardSession } from "../wizard/session.js";
import {
  assertGatewayAuthConfigured,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import {
  type ChannelKind,
  type GatewayReloadPlan,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { normalizeControlUiBasePath } from "./control-ui.js";
import { resolveHooksConfig } from "./hooks.js";
import {
  isLoopbackAddress,
  isLoopbackHost,
  resolveGatewayBindHost,
} from "./net.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
  setBroadcastHealthUpdate,
} from "./server/health-state.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createBridgeHandlers } from "./server-bridge.js";
import {
  type BridgeListConnectedFn,
  type BridgeSendEventFn,
  createBridgeSubscriptionManager,
} from "./server-bridge-subscriptions.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createChannelManager } from "./server-channels.js";
import { createAgentEventHandler, createChatRunState } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
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
} from "./server-http.js";
import { coreGatewayHandlers } from "./server-methods.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { loadSessionEntry } from "./session-utils.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

ensureClawdbotCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logBridge = log.child("bridge");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logWsControl = log.child("ws");
const canvasRuntime = runtimeForLogger(logCanvas);
const channelLogs = Object.fromEntries(
  listChannelPlugins().map((plugin) => [
    plugin.id,
    logChannels.child(plugin.id),
  ]),
) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
const channelRuntimeEnvs = Object.fromEntries(
  Object.entries(channelLogs).map(([id, logger]) => [
    id,
    runtimeForLogger(logger),
  ]),
) as Record<ChannelId, RuntimeEnv>;

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

type Client = GatewayWsClient;

const BASE_METHODS = [
  "health",
  "logs.tail",
  "channels.status",
  "channels.logout",
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
  // WebChat WebSocket-native chat methods
  "chat.history",
  "chat.abort",
  "chat.send",
];

const CHANNEL_METHODS = listChannelPlugins().flatMap(
  (plugin) => plugin.gatewayMethods ?? [],
);

const METHODS = Array.from(new Set([...BASE_METHODS, ...CHANNEL_METHODS]));

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
  initSubagentRegistry();
  await autoMigrateLegacyState({ cfg: cfgAtStart, log });
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(
    cfgAtStart,
    defaultAgentId,
  );
  const pluginRegistry = loadClawdbotPlugins({
    config: cfgAtStart,
    workspaceDir: defaultWorkspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
    coreGatewayHandlers,
  });
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...METHODS, ...pluginMethods]));
  if (pluginRegistry.diagnostics.length > 0) {
    for (const diag of pluginRegistry.diagnostics) {
      if (diag.level === "error") {
        log.warn(`[plugins] ${diag.message}`);
      } else {
        log.info(`[plugins] ${diag.message}`);
      }
    }
  }
  let pluginServices: PluginServicesHandle | null = null;
  const bindMode = opts.bind ?? cfgAtStart.gateway?.bind ?? "loopback";
  const customBindHost = cfgAtStart.gateway?.customBindHost;
  const bindHost =
    opts.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
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

  const deps = createDefaultDeps();
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

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps,
    getHooksConfig: () => hooksConfig,
    bindHost,
    port,
    logHooks,
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
  await listenGatewayHttpServer({ httpServer, bindHost, port });

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
  const buildCronService = (cfg: ReturnType<typeof loadConfig>) => {
    const storePath = resolveCronStorePath(cfg.cron?.store);
    const cronEnabled =
      process.env.CLAWDBOT_SKIP_CRON !== "1" && cfg.cron?.enabled !== false;
    const resolveCronAgent = (requested?: string | null) => {
      const runtimeConfig = loadConfig();
      const normalized =
        typeof requested === "string" && requested.trim()
          ? normalizeAgentId(requested)
          : undefined;
      const hasAgent =
        normalized !== undefined &&
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.some(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            normalizeAgentId(entry.id) === normalized,
        );
      const agentId = hasAgent
        ? normalized
        : resolveDefaultAgentId(runtimeConfig);
      return { agentId, cfg: runtimeConfig };
    };
    const cron = new CronService({
      storePath,
      cronEnabled,
      enqueueSystemEvent: (text, opts) => {
        const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
        const sessionKey = resolveAgentMainSessionKey({
          cfg: runtimeConfig,
          agentId,
        });
        enqueueSystemEvent(text, { sessionKey });
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
        const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps,
          job,
          message,
          agentId,
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

  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
  });
  const {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
  } = channelManager;

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
      cfgAtStart.bridge?.bind ?? (wideAreaDiscoveryEnabled ? "auto" : "lan");
    if (bind === "loopback") return "127.0.0.1";
    if (bind === "lan") return "0.0.0.0";

    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    const tailnetIPv6 = pickPrimaryTailnetIPv6();
    if (bind === "auto") {
      return tailnetIPv4 ?? tailnetIPv6 ?? "0.0.0.0";
    }
    if (bind === "custom") {
      // For bridge, customBindHost is not currently supported on GatewayConfig.
      // This will fall back to "0.0.0.0" until we add customBindHost to BridgeConfig.
      return "0.0.0.0";
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
    getHealthCache,
    refreshHealthSnapshot: refreshGatewayHealthSnapshot,
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
    incrementPresenceVersion();
    broadcast(
      "presence",
      { presence: listSystemPresence() },
      {
        dropIfSlow: true,
        stateVersion: {
          presence: getPresenceVersion(),
          health: getHealthVersion(),
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

  setBroadcastHealthUpdate((snap: HealthSummary) => {
    broadcast("health", snap, {
      stateVersion: {
        presence: getPresenceVersion(),
        health: getHealthVersion(),
      },
    });
    bridgeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    broadcast("tick", payload, { dropIfSlow: true });
    bridgeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void refreshGatewayHealthSnapshot({ probe: true }).catch((err) =>
      logHealth.error(`refresh failed: ${formatError(err)}`),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void refreshGatewayHealthSnapshot({ probe: true }).catch((err) =>
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

  attachGatewayWsConnectionHandler({
    wss,
    clients,
    port,
    bridgeHost,
    canvasHostEnabled: Boolean(canvasHost),
    canvasHostServerPort: canvasHostServer?.port ?? undefined,
    resolvedAuth,
    gatewayMethods,
    events: EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: pluginRegistry.gatewayHandlers,
    broadcast,
    buildRequestContext: () => ({
      deps,
      cron,
      cronStorePath,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshot,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
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
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
    }),
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

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via CLAWDBOT_SKIP_CHANNELS (or legacy CLAWDBOT_SKIP_PROVIDERS).
  const skipChannels =
    process.env.CLAWDBOT_SKIP_CHANNELS === "1" ||
    process.env.CLAWDBOT_SKIP_PROVIDERS === "1";
  if (!skipChannels) {
    try {
      await startChannels();
    } catch (err) {
      logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    logChannels.info(
      "skipping channel start (CLAWDBOT_SKIP_CHANNELS=1 or CLAWDBOT_SKIP_PROVIDERS=1)",
    );
  }

  try {
    pluginServices = await startPluginServices({
      registry: pluginRegistry,
      config: cfgAtStart,
      workspaceDir: defaultWorkspaceDir,
    });
  } catch (err) {
    log.warn(`plugin services failed to start: ${String(err)}`);
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
    const lastChannel = entry?.lastChannel;
    const lastTo = entry?.lastTo?.trim();
    const parsedTarget = resolveAnnounceTargetFromKey(sessionKey);
    const channelRaw = lastChannel ?? parsedTarget?.channel;
    const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
    const to = lastTo || parsedTarget?.to;
    if (!channel || !to) {
      enqueueSystemEvent(message, { sessionKey });
      return;
    }

    const resolved = resolveOutboundTarget({
      channel,
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
          channel,
          deliver: true,
          bestEffortDeliver: true,
          messageChannel: channel,
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

    if (plan.restartChannels.size > 0) {
      if (
        process.env.CLAWDBOT_SKIP_CHANNELS === "1" ||
        process.env.CLAWDBOT_SKIP_PROVIDERS === "1"
      ) {
        logChannels.info(
          "skipping channel reload (CLAWDBOT_SKIP_CHANNELS=1 or CLAWDBOT_SKIP_PROVIDERS=1)",
        );
      } else {
        const restartChannel = async (name: ChannelKind) => {
          logChannels.info(`restarting ${name} channel`);
          await stopChannel(name);
          await startChannel(name);
        };
        for (const channel of plan.restartChannels) {
          await restartChannel(channel);
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
      for (const plugin of listChannelPlugins()) {
        await stopChannel(plugin.id);
      }
      if (pluginServices) {
        await pluginServices.stop().catch(() => {});
      }
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
