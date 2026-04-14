import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { resolveEmbeddedAgentRuntime } from "../agents/pi-embedded-runner/runtime.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import { scheduleSubagentOrphanRecovery } from "../agents/subagent-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

async function prewarmConfiguredPrimaryModel(params: {
  cfg: OpenClawConfig;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (isCliProvider(provider, params.cfg)) {
    return;
  }
  const runtime = resolveEmbeddedAgentRuntime();
  if (runtime !== "auto" && runtime !== "pi") {
    return;
  }
  if (selectAgentHarness({ provider, modelId: model, config: params.cfg }).id !== "pi") {
    return;
  }
  const agentDir = resolveOpenClawAgentDir();
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir);
    const resolved = resolveModel(provider, model, agentDir, params.cfg, {
      skipProviderRuntimeHooks: true,
    });
    if (!resolved.model) {
      throw new Error(
        resolved.error ??
          `Unknown model: ${provider}/${model} (startup warmup only checks static model resolution)`,
      );
    }
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
}) {
  try {
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    for (const sessionsDir of sessionDirs) {
      await cleanStaleLockFiles({
        sessionsDir,
        staleMs: SESSION_LOCK_STALE_MS,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
    }
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  await startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: resolvedDefaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider: resolvedDefaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  try {
    setInternalHooksEnabled(params.cfg.hooks?.internal?.enabled !== false);
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await prewarmConfiguredPrimaryModel({
        cfg: params.cfg,
        log: params.log,
      });
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled !== false) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (params.cfg.acp?.enabled) {
    void getAcpSessionManager()
      .reconcilePendingSessionIdentities({ cfg: params.cfg })
      .then((result) => {
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      })
      .catch((err) => {
        params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
      });
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  scheduleSubagentOrphanRecovery();

  return { pluginServices };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: typeof getGlobalHookRunner;
  logGatewayStartup: typeof logGatewayStartup;
  scheduleGatewayUpdateCheck: typeof scheduleGatewayUpdateCheck;
  startGatewaySidecars: typeof startGatewaySidecars;
  startGatewayTailscaleExposure: typeof startGatewayTailscaleExposure;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner,
  logGatewayStartup,
  scheduleGatewayUpdateCheck,
  startGatewaySidecars,
  startGatewayTailscaleExposure,
};

export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    cfgAtStart: OpenClawConfig;
    bindHost: string;
    bindHosts: string[];
    port: number;
    tlsEnabled: boolean;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    };
    isNixMode: boolean;
    startupStartedAt?: number;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    tailscaleMode: GatewayTailscaleMode;
    resetOnExit: boolean;
    controlUiBasePath: string;
    logTailscale: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    gatewayPluginConfigAtStart: OpenClawConfig;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    logHooks: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    logChannels: { info: (msg: string) => void; error: (msg: string) => void };
    unavailableGatewayMethods: Set<string>;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  runtimeDeps.logGatewayStartup({
    cfg: params.cfgAtStart,
    bindHost: params.bindHost,
    bindHosts: params.bindHosts,
    port: params.port,
    tlsEnabled: params.tlsEnabled,
    loadedPluginIds: params.pluginRegistry.plugins
      .filter((plugin) => plugin.status === "loaded")
      .map((plugin) => plugin.id),
    log: params.log,
    isNixMode: params.isNixMode,
    startupStartedAt: params.startupStartedAt,
  });

  const stopGatewayUpdateCheck = params.minimalTestGateway
    ? () => {}
    : runtimeDeps.scheduleGatewayUpdateCheck({
        cfg: params.cfgAtStart,
        log: params.log,
        isNixMode: params.isNixMode,
        onUpdateAvailableChange: (updateAvailable) => {
          const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
          params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
        },
      });

  const tailscaleCleanup = params.minimalTestGateway
    ? null
    : await runtimeDeps.startGatewayTailscaleExposure({
        tailscaleMode: params.tailscaleMode,
        resetOnExit: params.resetOnExit,
        port: params.port,
        controlUiBasePath: params.controlUiBasePath,
        logTailscale: params.logTailscale,
      });

  let pluginServices: PluginServicesHandle | null = null;
  if (!params.minimalTestGateway) {
    params.log.info("starting channels and sidecars...");
    ({ pluginServices } = await runtimeDeps.startGatewaySidecars({
      cfg: params.gatewayPluginConfigAtStart,
      pluginRegistry: params.pluginRegistry,
      defaultWorkspaceDir: params.defaultWorkspaceDir,
      deps: params.deps,
      startChannels: params.startChannels,
      log: params.log,
      logHooks: params.logHooks,
      logChannels: params.logChannels,
    }));
    for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
      params.unavailableGatewayMethods.delete(method);
    }
  }

  if (!params.minimalTestGateway) {
    const hookRunner = runtimeDeps.getGlobalHookRunner();
    if (hookRunner?.hasHooks("gateway_start")) {
      void hookRunner.runGatewayStart({ port: params.port }, { port: params.port }).catch((err) => {
        params.log.warn(`gateway_start hook failed: ${String(err)}`);
      });
    }
  }

  return { stopGatewayUpdateCheck, tailscaleCleanup, pluginServices };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
};
