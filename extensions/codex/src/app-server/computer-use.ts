/**
 * Computer Use plugin/MCP readiness checks and optional install flow for Codex
 * app-server sessions.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describeControlFailure } from "./capabilities.js";
import {
  isCodexAppServerConnectionClosedError,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexComputerUseConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import { resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath } from "./desktop-app-paths.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import type {
  CodexListMcpServerStatusResponse,
  CodexMcpServerStatus,
  CodexPluginDetail,
  CodexPluginListResponse,
  CodexPluginReadResponse,
  CodexRequestObject,
  CodexThreadStartResponse,
  JsonValue,
} from "./protocol.js";
import { requestCodexAppServerJson } from "./request.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  resolveCodexNativeConfigFenceKey,
} from "./shared-client.js";

/** Minimal app-server request function needed by Computer Use setup. */
export type CodexComputerUseRequest = <T = JsonValue | undefined>(
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number },
) => Promise<T>;

type CodexComputerUseStatusReason =
  | "disabled"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "remote_install_unsupported"
  | "mcp_missing"
  | "live_test_failed"
  | "ready"
  | "check_failed"
  | "auto_install_blocked";

type CodexComputerUseInstallationStatus =
  | "disabled"
  | "marketplace_missing"
  | "not_installed"
  | "installed_disabled"
  | "installed";

type CodexComputerUseExposureStatus = "skipped" | "missing" | "available";

type CodexComputerUseLiveTestState = "skipped" | "passed" | "failed";

export type CodexComputerUseStatusSection = {
  status: string;
  ok: boolean;
  message: string;
};

export type CodexComputerUseLiveTestStatus = {
  status: CodexComputerUseLiveTestState;
  ok: boolean;
  attempted: boolean;
  attempts: number;
  timeoutMs: number;
  retried: boolean;
  repaired: boolean;
  message: string;
  error?: string;
  durationMs?: number;
};

export type CodexComputerUseRepairStatus = {
  attempted: boolean;
  killedPids: number[];
  message: string;
  warnings: string[];
};

/** Readiness status for Codex Computer Use plugin and MCP server wiring. */
export type CodexComputerUseStatus = {
  enabled: boolean;
  ready: boolean;
  reason: CodexComputerUseStatusReason;
  installed: boolean;
  pluginEnabled: boolean;
  mcpServerAvailable: boolean;
  pluginName: string;
  mcpServerName: string;
  marketplaceName?: string;
  marketplacePath?: string;
  tools: string[];
  installation: CodexComputerUseStatusSection & {
    status: CodexComputerUseInstallationStatus;
  };
  exposure: CodexComputerUseStatusSection & {
    status: CodexComputerUseExposureStatus;
  };
  liveTest: CodexComputerUseLiveTestStatus;
  repair?: CodexComputerUseRepairStatus;
  warnings: string[];
  message: string;
};

class CodexComputerUseSetupError extends Error {
  readonly status: CodexComputerUseStatus;

  constructor(status: CodexComputerUseStatus) {
    super(status.message);
    this.name = "CodexComputerUseSetupError";
    this.status = status;
  }
}

/** Inputs for checking, ensuring, or installing Codex Computer Use support. */
export type CodexComputerUseSetupParams = {
  pluginConfig?: unknown;
  config?: Parameters<typeof requestCodexAppServerJson>[0]["config"];
  agentDir?: string;
  overrides?: Partial<CodexComputerUseConfig>;
  /** Caller-owned injection seam for tests; production mutation safety requires `client`. */
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  forceEnable?: boolean;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
};

type CodexComputerUseInspectionParams = {
  pluginConfig?: unknown;
  config?: CodexComputerUseSetupParams["config"];
  agentDir?: string;
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  computerUseConfig: ResolvedCodexComputerUseConfig;
  installPlugin: boolean;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
};

type MarketplaceRef =
  | {
      kind: "local";
      name?: string;
      path: string;
    }
  | {
      kind: "remote";
      name: string;
      remoteMarketplaceName: string;
    };

type MarketplaceResolution = {
  marketplace?: MarketplaceRef;
  message?: string;
};

type PluginInspection =
  | {
      ok: true;
      plugin: CodexPluginDetail;
    }
  | {
      ok: false;
      status: CodexComputerUseStatus;
    };

const CURATED_MARKETPLACE_POLL_INTERVAL_MS = 2_000;
const COMPUTER_USE_MARKETPLACE_NAME_PRIORITY = ["openai-bundled", "openai-curated", "local"];
const COMPUTER_USE_LIVE_TEST_RETRY_COUNT = 1;
const COMPUTER_USE_LIVE_TEST_THREAD_NAME = "OpenClaw Computer Use readiness probe";
const execFileAsync = promisify(execFile);

/** Reads Computer Use readiness without installing or mutating app-server state. */
export async function readCodexComputerUseStatus(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig(params);
  if (!config.enabled) {
    return disabledStatus(config);
  }
  try {
    return await inspectCodexComputerUse({
      ...params,
      computerUseConfig: config,
      installPlugin: false,
    });
  } catch (error) {
    return unavailableStatus(
      config,
      "check_failed",
      `Computer Use check failed: ${describeControlFailure(error)}`,
    );
  }
}

/**
 * Ensures Computer Use is ready when enabled, optionally installing when config
 * allows safe auto-install.
 */
export async function ensureCodexComputerUse(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig(params);
  if (!config.enabled) {
    return disabledStatus(config);
  }
  const status = await inspectCodexComputerUse({
    ...params,
    computerUseConfig: config,
    installPlugin: false,
  });
  if (status.ready) {
    return status;
  }
  if (isNonStrictLiveTestStartupAllowed(status, config)) {
    return status;
  }
  if (config.autoInstall) {
    const blockedAutoInstallStatus = blockUnsafeAutoInstallStatus(config);
    if (blockedAutoInstallStatus) {
      throw new CodexComputerUseSetupError(blockedAutoInstallStatus);
    }
    const installedStatus = await inspectCodexComputerUse({
      ...params,
      computerUseConfig: config,
      installPlugin: true,
    });
    if (isNonStrictLiveTestStartupAllowed(installedStatus, config)) {
      return installedStatus;
    }
    if (!installedStatus.ready) {
      throw new CodexComputerUseSetupError(installedStatus);
    }
    return installedStatus;
  }
  if (!status.ready) {
    throw new CodexComputerUseSetupError(status);
  }
  return status;
}

/** Forces Computer Use plugin installation and returns the ready status. */
export async function installCodexComputerUse(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig({
    ...params,
    forceEnable: true,
    overrides: { ...params.overrides, enabled: true, autoInstall: true },
  });
  const status = await inspectCodexComputerUse({
    ...params,
    computerUseConfig: config,
    installPlugin: true,
  });
  if (!status.ready) {
    throw new CodexComputerUseSetupError(status);
  }
  return status;
}

async function inspectCodexComputerUse(
  params: CodexComputerUseInspectionParams,
): Promise<CodexComputerUseStatus> {
  if (!params.installPlugin) {
    return await inspectCodexComputerUseWithoutFence(params);
  }
  const runtime = params.client
    ? undefined
    : resolveCodexAppServerRuntimeOptions({
        pluginConfig: params.pluginConfig,
        managedCommandOrder: "desktop-first",
      });
  const fenceKey = resolveCodexNativeConfigFenceKey({
    client: params.client,
    startOptions: runtime?.start,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (!fenceKey) {
    return await inspectCodexComputerUseWithoutFence(params);
  }
  const release = await acquireCodexNativeConfigFence(fenceKey, {
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? runtime?.requestTimeoutMs,
    timeoutMessage: "Codex Computer Use install timed out waiting for native config",
    abortMessage: "Codex Computer Use install aborted waiting for native config",
  });
  let releaseFenceOnReturn = true;
  let leasedClient: CodexAppServerClient | undefined;
  try {
    let client = params.client;
    if (!client && !params.request) {
      if (!runtime) {
        throw new Error("Computer Use install could not resolve its app-server runtime");
      }
      client = await getLeasedSharedCodexAppServerClient({
        startOptions: runtime.start,
        timeoutMs: params.timeoutMs ?? runtime.requestTimeoutMs,
        config: params.config,
        agentDir: params.agentDir,
        abandonSignal: params.signal,
      });
      leasedClient = client;
    }
    try {
      return await inspectCodexComputerUseWithoutFence({
        ...params,
        ...(client
          ? {
              client,
              timeoutMs: params.timeoutMs ?? runtime?.requestTimeoutMs,
            }
          : {}),
      });
    } catch (error) {
      if (
        client &&
        (isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error) ||
          isCodexAppServerConnectionClosedError(error))
      ) {
        // Codex may still commit a config mutation after local cancellation.
        // Transfer fence ownership to physical process exit before surfacing it.
        releaseFenceOnReturn = false;
        await client.closeAndRunAfterExit(release, "Computer Use config mutation");
      }
      throw error;
    } finally {
      if (leasedClient) {
        releaseLeasedSharedCodexAppServerClient(leasedClient);
      }
    }
  } finally {
    if (releaseFenceOnReturn) {
      release();
    }
  }
}

async function inspectCodexComputerUseWithoutFence(
  params: CodexComputerUseInspectionParams,
): Promise<CodexComputerUseStatus> {
  const request = createComputerUseRequest(params);
  const repairComputerUseMcpChildren =
    params.repairComputerUseMcpChildren ??
    (params.client
      ? () => killStaleComputerUseMcpChildren({ ancestorPid: params.client?.getTransportPid() })
      : undefined);
  if (params.installPlugin) {
    await request<JsonValue>("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    } satisfies CodexRequestObject);
  }

  const marketplace = await resolveMarketplaceRef({
    request,
    config: params.computerUseConfig,
    allowAdd: params.installPlugin,
    signal: params.signal,
    defaultBundledMarketplacePath: params.defaultBundledMarketplacePath,
    defaultBundledMarketplacePathCandidates: params.defaultBundledMarketplacePathCandidates,
  });
  if (!marketplace.marketplace) {
    return unavailableStatus(
      params.computerUseConfig,
      "marketplace_missing",
      marketplace.message ??
        `No Codex marketplace containing ${params.computerUseConfig.pluginName} is registered. Configure computerUse.marketplaceSource or computerUse.marketplacePath, then run /codex computer-use install.`,
    );
  }

  const pluginInspection = await ensureComputerUsePlugin({
    request,
    config: params.computerUseConfig,
    marketplace: marketplace.marketplace,
    installPlugin: params.installPlugin,
  });
  if (!pluginInspection.ok) {
    return pluginInspection.status;
  }

  return await readComputerUseTools({
    request,
    config: params.computerUseConfig,
    plugin: pluginInspection.plugin,
    installPlugin: params.installPlugin,
    repairComputerUseMcpChildren,
  });
}

async function ensureComputerUsePlugin(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  marketplace: MarketplaceRef;
  installPlugin: boolean;
}): Promise<PluginInspection> {
  let plugin = await readComputerUsePlugin(
    params.request,
    params.marketplace,
    params.config.pluginName,
  );
  if (!plugin.summary.installed || !plugin.summary.enabled) {
    if (!params.installPlugin) {
      return {
        ok: false,
        status: statusFromPlugin({
          config: params.config,
          plugin,
          tools: [],
          reason: pluginSetupReason(plugin, params.marketplace),
          message: pluginSetupMessage(params.config, plugin, params.marketplace),
        }),
      };
    }
    if (params.marketplace.kind === "remote") {
      return {
        ok: false,
        status: statusFromPlugin({
          config: params.config,
          plugin,
          tools: [],
          reason: "remote_install_unsupported",
          message: remoteInstallUnsupportedMessage(plugin, params.marketplace),
        }),
      };
    }
    await params.request<JsonValue>(
      "plugin/install",
      pluginRequestParams(params.marketplace, params.config.pluginName),
    );
    await reloadMcpServers(params.request);
    plugin = await readComputerUsePlugin(
      params.request,
      params.marketplace,
      params.config.pluginName,
    );
  }
  if (!plugin.summary.installed || !plugin.summary.enabled) {
    return {
      ok: false,
      status: statusFromPlugin({
        config: params.config,
        plugin,
        tools: [],
        reason: pluginSetupReason(plugin, params.marketplace),
        message: pluginSetupMessage(params.config, plugin, params.marketplace),
      }),
    };
  }
  return { ok: true, plugin };
}

async function readComputerUseTools(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  plugin: CodexPluginDetail;
  installPlugin: boolean;
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
}): Promise<CodexComputerUseStatus> {
  let server = await readMcpServerStatus(params.request, params.config.mcpServerName);
  if (!server && params.installPlugin) {
    await reloadMcpServers(params.request);
    server = await readMcpServerStatus(params.request, params.config.mcpServerName);
  }
  if (!server) {
    return statusFromPlugin({
      config: params.config,
      plugin: params.plugin,
      tools: [],
      reason: "mcp_missing",
      message: `Computer Use is installed, but the ${params.config.mcpServerName} MCP server is not available.`,
    });
  }

  const status = statusFromPlugin({
    config: params.config,
    plugin: params.plugin,
    tools: Object.keys(server.tools).toSorted(),
    reason: "ready",
    message: "Computer Use is ready.",
  });
  const { liveTest, repair } = await runCodexComputerUseLiveTest({
    request: params.request,
    config: params.config,
    repairComputerUseMcpChildren: params.repairComputerUseMcpChildren,
  });
  const compatibilityStartupAllowed = !liveTest.ok && !params.config.strictReadiness;
  return {
    ...status,
    ready: liveTest.ok,
    reason: liveTest.ok ? "ready" : "live_test_failed",
    liveTest,
    ...(repair ? { repair } : {}),
    warnings: [
      ...status.warnings,
      ...(repair?.warnings ?? []),
      ...(compatibilityStartupAllowed
        ? [
            "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
          ]
        : []),
    ],
    message: liveTest.ok
      ? "Computer Use is ready."
      : compatibilityStartupAllowed
        ? `${liveTest.message} Startup is allowed because computerUse.strictReadiness is false.`
        : liveTest.message,
  };
}

function isNonStrictLiveTestStartupAllowed(
  status: CodexComputerUseStatus,
  config: ResolvedCodexComputerUseConfig,
): boolean {
  return (
    !config.strictReadiness &&
    status.reason === "live_test_failed" &&
    status.installed &&
    status.pluginEnabled &&
    status.mcpServerAvailable &&
    status.installation.ok &&
    status.exposure.ok
  );
}

export async function runCodexComputerUseLiveTest(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
}): Promise<{ liveTest: CodexComputerUseLiveTestStatus; repair?: CodexComputerUseRepairStatus }> {
  const startedAt = Date.now();
  let lastError: unknown;
  let repair: CodexComputerUseRepairStatus | undefined;
  for (let attempt = 0; attempt <= COMPUTER_USE_LIVE_TEST_RETRY_COUNT; attempt += 1) {
    let threadId: string | undefined;
    try {
      const thread = await params.request<CodexThreadStartResponse>(
        "thread/start",
        {
          input: [],
          developerInstructions: COMPUTER_USE_LIVE_TEST_THREAD_NAME,
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          ephemeral: true,
        },
        {
          timeoutMs: params.config.liveTestTimeoutMs,
        },
      );
      threadId = thread.thread.id;
      await params.request(
        "mcpServer/tool/call",
        {
          threadId,
          server: params.config.mcpServerName,
          tool: "list_apps",
          arguments: {},
        },
        {
          timeoutMs: params.config.toolCallTimeoutMs,
        },
      );
      return {
        liveTest: {
          status: "passed",
          ok: true,
          attempted: true,
          attempts: attempt + 1,
          timeoutMs: params.config.liveTestTimeoutMs,
          retried: attempt > 0,
          repaired: Boolean(repair?.attempted),
          durationMs: Math.max(0, Date.now() - startedAt),
          message: "Computer Use live test passed.",
        },
        ...(repair ? { repair } : {}),
      };
    } catch (error) {
      lastError = error;
      if (attempt >= COMPUTER_USE_LIVE_TEST_RETRY_COUNT) {
        break;
      }
      if (params.config.autoRepair) {
        repair = params.repairComputerUseMcpChildren
          ? await params.repairComputerUseMcpChildren()
          : scopedRepairUnavailableStatus();
      }
    } finally {
      if (threadId) {
        await cleanupComputerUseProbeThread(params.request, threadId, params.config);
      }
    }
  }
  const errorMessage = describeControlFailure(lastError);
  return {
    liveTest: {
      status: "failed",
      ok: false,
      attempted: true,
      attempts: COMPUTER_USE_LIVE_TEST_RETRY_COUNT + 1,
      timeoutMs: params.config.liveTestTimeoutMs,
      retried: COMPUTER_USE_LIVE_TEST_RETRY_COUNT > 0,
      repaired: Boolean(repair?.attempted),
      durationMs: Math.max(0, Date.now() - startedAt),
      message: `Computer Use live test failed after ${COMPUTER_USE_LIVE_TEST_RETRY_COUNT + 1} attempts: ${errorMessage}`,
      error: errorMessage,
    },
    ...(repair ? { repair } : {}),
  };
}

async function cleanupComputerUseProbeThread(
  request: CodexComputerUseRequest,
  threadId: string,
  config: ResolvedCodexComputerUseConfig,
): Promise<void> {
  await Promise.allSettled([
    request("thread/unsubscribe", { threadId }, { timeoutMs: config.liveTestTimeoutMs }),
    request("thread/archive", { threadId }, { timeoutMs: config.liveTestTimeoutMs }),
  ]);
}

function scopedRepairUnavailableStatus(): CodexComputerUseRepairStatus {
  return {
    attempted: false,
    killedPids: [],
    warnings: [
      "Computer Use auto-repair skipped because no scoped Codex app-server process was available.",
    ],
    message: "Computer Use stale child repair requires a scoped local app-server PID.",
  };
}

async function resolveMarketplaceRef(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  signal?: AbortSignal;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
}): Promise<MarketplaceResolution> {
  let preferredMarketplaceName = params.config.marketplaceName;
  if (params.config.marketplaceSource && params.allowAdd) {
    const added = await params.request<{ marketplaceName?: string }>("marketplace/add", {
      source: params.config.marketplaceSource,
    } satisfies CodexRequestObject);
    preferredMarketplaceName ??= added.marketplaceName;
  }

  if (params.config.marketplacePath) {
    const marketplace: MarketplaceRef = preferredMarketplaceName
      ? { kind: "local", name: preferredMarketplaceName, path: params.config.marketplacePath }
      : { kind: "local", path: params.config.marketplacePath };
    return { marketplace };
  }

  let candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  const bundledMarketplacePath = resolveBundledComputerUseMarketplacePath(params);
  if (
    candidates.length === 0 &&
    bundledMarketplacePath &&
    shouldAddBundledComputerUseMarketplace(params)
  ) {
    const added = await params.request<{ marketplaceName?: string }>("marketplace/add", {
      source: bundledMarketplacePath,
    } satisfies CodexRequestObject);
    preferredMarketplaceName ??= added.marketplaceName;
    candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  }

  const waitUntil = marketplaceDiscoveryWaitUntil(params);
  while (candidates.length === 0) {
    if (Date.now() >= waitUntil) {
      break;
    }
    await delay(
      Math.min(CURATED_MARKETPLACE_POLL_INTERVAL_MS, waitUntil - Date.now()),
      params.signal,
    );
    candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  }

  if (preferredMarketplaceName) {
    const preferred = candidates.find((candidate) => candidate.name === preferredMarketplaceName);
    if (preferred) {
      return { marketplace: preferred };
    }
    return {
      message: `Configured Codex marketplace ${preferredMarketplaceName} was not found or does not contain ${params.config.pluginName}. Run /codex computer-use install with a source or path to install from a new marketplace.`,
    };
  }
  if (candidates.length > 1) {
    const preferred = chooseKnownComputerUseMarketplace(candidates);
    if (preferred) {
      return { marketplace: preferred };
    }
    return {
      message: `Multiple Codex marketplaces contain ${params.config.pluginName}. Configure computerUse.marketplaceName or computerUse.marketplacePath to choose one.`,
    };
  }
  if (params.config.marketplaceSource && !params.allowAdd && candidates.length === 0) {
    return {
      message:
        "Computer Use marketplace source is configured but has not been registered. Run /codex computer-use install to register it.",
    };
  }
  const marketplace = candidates[0];
  return marketplace ? { marketplace } : {};
}

async function listComputerUseMarketplaceCandidates(
  request: CodexComputerUseRequest,
  config: ResolvedCodexComputerUseConfig,
): Promise<MarketplaceRef[]> {
  const listed = await request<CodexPluginListResponse>("plugin/list", {
    cwds: [],
  } satisfies CodexRequestObject);
  return findComputerUseMarketplaces(listed, config.pluginName);
}

function blockUnsafeAutoInstallStatus(
  config: ResolvedCodexComputerUseConfig,
): CodexComputerUseStatus | undefined {
  if (!config.marketplaceSource) {
    return undefined;
  }
  return unavailableStatus(
    config,
    "auto_install_blocked",
    "Computer Use auto-install only uses marketplaces Codex app-server has already discovered. Run /codex computer-use install to install from a configured marketplace source.",
  );
}

function shouldAddBundledComputerUseMarketplace(params: {
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
}): boolean {
  return (
    params.allowAdd &&
    !params.config.marketplaceSource &&
    !params.config.marketplacePath &&
    !params.config.marketplaceName &&
    Boolean(resolveBundledComputerUseMarketplacePath(params))
  );
}

function resolveBundledComputerUseMarketplacePath(params: {
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
}): string | undefined {
  if (params.defaultBundledMarketplacePath) {
    return existsSync(params.defaultBundledMarketplacePath)
      ? params.defaultBundledMarketplacePath
      : undefined;
  }
  return resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath({
    candidates: params.defaultBundledMarketplacePathCandidates,
  });
}

function findComputerUseMarketplaces(
  listed: CodexPluginListResponse,
  pluginName: string,
): MarketplaceRef[] {
  return listed.marketplaces
    .filter((marketplace) =>
      marketplace.plugins.some(
        (plugin) =>
          plugin.name === pluginName ||
          plugin.id === pluginName ||
          plugin.id === `${pluginName}@${marketplace.name}`,
      ),
    )
    .map((marketplace) => {
      if (marketplace.path) {
        return { kind: "local", name: marketplace.name, path: marketplace.path };
      }
      return { kind: "remote", name: marketplace.name, remoteMarketplaceName: marketplace.name };
    });
}

function chooseKnownComputerUseMarketplace(
  candidates: MarketplaceRef[],
): MarketplaceRef | undefined {
  for (const marketplaceName of COMPUTER_USE_MARKETPLACE_NAME_PRIORITY) {
    const candidate = candidates.find((marketplace) => marketplace.name === marketplaceName);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function marketplaceDiscoveryWaitUntil(params: {
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
}): number {
  if (
    params.allowAdd &&
    !params.config.marketplaceSource &&
    !params.config.marketplacePath &&
    !params.config.marketplaceName
  ) {
    return Date.now() + params.config.marketplaceDiscoveryTimeoutMs;
  }
  return 0;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Computer Use setup was aborted.");
}

async function readComputerUsePlugin(
  request: CodexComputerUseRequest,
  marketplace: MarketplaceRef,
  pluginName: string,
): Promise<CodexPluginDetail> {
  const response = await request<CodexPluginReadResponse>(
    "plugin/read",
    pluginRequestParams(marketplace, pluginName),
  );
  return response.plugin;
}

async function readMcpServerStatus(
  request: CodexComputerUseRequest,
  serverName: string,
): Promise<CodexMcpServerStatus | undefined> {
  let cursor: string | null | undefined;
  do {
    const response = await request<CodexListMcpServerStatusResponse>("mcpServerStatus/list", {
      cursor,
      limit: 100,
      detail: "toolsAndAuthOnly",
    } satisfies CodexRequestObject);
    const found = response.data.find((server) => server.name === serverName);
    if (found) {
      return found;
    }
    cursor = response.nextCursor;
  } while (cursor);
  return undefined;
}

async function reloadMcpServers(request: CodexComputerUseRequest): Promise<void> {
  await request("config/mcpServer/reload", undefined);
}

function pluginRequestParams(marketplace: MarketplaceRef, pluginName: string) {
  return {
    ...(marketplace.kind === "local" ? { marketplacePath: marketplace.path } : {}),
    ...(marketplace.kind === "remote"
      ? { remoteMarketplaceName: marketplace.remoteMarketplaceName }
      : {}),
    pluginName,
  };
}

function pluginSetupReason(
  plugin: CodexPluginDetail,
  marketplace: MarketplaceRef,
): CodexComputerUseStatusReason {
  if (marketplace.kind === "remote") {
    return "remote_install_unsupported";
  }
  return plugin.summary.installed ? "plugin_disabled" : "plugin_not_installed";
}

function pluginSetupMessage(
  config: ResolvedCodexComputerUseConfig,
  plugin: CodexPluginDetail,
  marketplace: MarketplaceRef,
): string {
  if (marketplace.kind === "remote") {
    return remoteInstallUnsupportedMessage(plugin, marketplace);
  }
  if (!plugin.summary.installed) {
    return "Computer Use is available but not installed. Run /codex computer-use install or enable computerUse.autoInstall.";
  }
  return `Computer Use is installed, but the ${config.pluginName} plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.`;
}

function remoteInstallUnsupportedMessage(
  plugin: CodexPluginDetail,
  marketplace: MarketplaceRef,
): string {
  const marketplaceName = marketplace.name ?? plugin.marketplaceName;
  const state = plugin.summary.installed ? "installed but disabled" : "available";
  return `Computer Use is ${state} in remote Codex marketplace ${marketplaceName}, but Codex app-server does not support remote plugin install yet. Configure computerUse.marketplaceSource or computerUse.marketplacePath for a local marketplace, then run /codex computer-use install.`;
}

function statusFromPlugin(params: {
  config: ResolvedCodexComputerUseConfig;
  plugin: CodexPluginDetail;
  tools: string[];
  reason: CodexComputerUseStatusReason;
  message: string;
}): CodexComputerUseStatus {
  return {
    enabled: true,
    ready:
      params.plugin.summary.installed && params.plugin.summary.enabled && params.tools.length > 0,
    reason: params.reason,
    installed: params.plugin.summary.installed,
    pluginEnabled: params.plugin.summary.enabled,
    mcpServerAvailable: params.tools.length > 0,
    pluginName: params.config.pluginName,
    mcpServerName: params.config.mcpServerName,
    marketplaceName: params.plugin.marketplaceName,
    ...(params.plugin.marketplacePath ? { marketplacePath: params.plugin.marketplacePath } : {}),
    tools: params.tools,
    installation: installationStatusFromPlugin(params.plugin, params.message),
    exposure: exposureStatusFromTools(params.config, params.tools),
    liveTest: skippedLiveTestStatus(params.config, "Computer Use live test was not run."),
    warnings: pluginWarnings(params.plugin),
    message: params.message,
  };
}

function disabledStatus(config: ResolvedCodexComputerUseConfig): CodexComputerUseStatus {
  return {
    enabled: false,
    ready: false,
    reason: "disabled",
    installed: false,
    pluginEnabled: false,
    mcpServerAvailable: false,
    pluginName: config.pluginName,
    mcpServerName: config.mcpServerName,
    tools: [],
    installation: {
      status: "disabled",
      ok: false,
      message: "Computer Use is disabled.",
    },
    exposure: {
      status: "skipped",
      ok: false,
      message: "MCP exposure was not checked because Computer Use is disabled.",
    },
    liveTest: skippedLiveTestStatus(
      config,
      "Computer Use live test was not run because Computer Use is disabled.",
    ),
    warnings: [],
    message: "Computer Use is disabled.",
  };
}

function unavailableStatus(
  config: ResolvedCodexComputerUseConfig,
  reason: CodexComputerUseStatusReason,
  message: string,
): CodexComputerUseStatus {
  return {
    enabled: true,
    ready: false,
    reason,
    installed: false,
    pluginEnabled: false,
    mcpServerAvailable: false,
    pluginName: config.pluginName,
    mcpServerName: config.mcpServerName,
    ...(config.marketplaceName ? { marketplaceName: config.marketplaceName } : {}),
    ...(config.marketplacePath ? { marketplacePath: config.marketplacePath } : {}),
    tools: [],
    installation: {
      status: reason === "marketplace_missing" ? "marketplace_missing" : "not_installed",
      ok: false,
      message,
    },
    exposure: {
      status: "skipped",
      ok: false,
      message: "MCP exposure was not checked because Computer Use installation is not ready.",
    },
    liveTest: skippedLiveTestStatus(
      config,
      "Computer Use live test was not run because installation is not ready.",
    ),
    warnings: [],
    message,
  };
}

function installationStatusFromPlugin(
  plugin: CodexPluginDetail,
  message: string,
): CodexComputerUseStatus["installation"] {
  if (!plugin.summary.installed) {
    return {
      status: "not_installed",
      ok: false,
      message,
    };
  }
  if (!plugin.summary.enabled) {
    return {
      status: "installed_disabled",
      ok: false,
      message,
    };
  }
  return {
    status: "installed",
    ok: true,
    message: "Computer Use plugin is installed and enabled.",
  };
}

function exposureStatusFromTools(
  config: ResolvedCodexComputerUseConfig,
  tools: string[],
): CodexComputerUseStatus["exposure"] {
  if (tools.length === 0) {
    return {
      status: "missing",
      ok: false,
      message: `Computer Use MCP server ${config.mcpServerName} is not exposed.`,
    };
  }
  return {
    status: "available",
    ok: true,
    message: `Computer Use MCP server ${config.mcpServerName} exposes ${tools.length} tools.`,
  };
}

function skippedLiveTestStatus(
  config: ResolvedCodexComputerUseConfig,
  message: string,
): CodexComputerUseLiveTestStatus {
  return {
    status: "skipped",
    ok: false,
    attempted: false,
    attempts: 0,
    timeoutMs: config.liveTestTimeoutMs,
    retried: false,
    repaired: false,
    message,
  };
}

function pluginWarnings(plugin: CodexPluginDetail): string[] {
  const warnings: string[] = [];
  const source = plugin.summary.source;
  if (source && typeof source === "object" && "type" in source && source.type === "remote") {
    warnings.push(
      "Computer Use plugin is resolved from a remote marketplace; live local bundles are preferred.",
    );
  }
  return warnings;
}

export async function killStaleComputerUseMcpChildren(
  options: { ancestorPid?: number } = {},
): Promise<CodexComputerUseRepairStatus> {
  if (process.platform !== "darwin") {
    return {
      attempted: true,
      killedPids: [],
      warnings: [
        `Computer Use stale child repair is currently macOS-only, not ${process.platform}.`,
      ],
      message: "Computer Use stale child repair skipped on this platform.",
    };
  }
  if (
    !options.ancestorPid ||
    !Number.isSafeInteger(options.ancestorPid) ||
    options.ancestorPid <= 0
  ) {
    return scopedRepairUnavailableStatus();
  }
  let stdout: string;
  try {
    const result = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    return {
      attempted: true,
      killedPids: [],
      warnings: [
        `Could not list processes for Computer Use repair: ${describeControlFailure(error)}`,
      ],
      message: "Computer Use stale child repair could not inspect running processes.",
    };
  }
  const killedPids: number[] = [];
  const warnings: string[] = [];
  const processInfos = parsePsOutput(stdout);
  for (const processInfo of processInfos) {
    if (!isStaleComputerUseMcpChild(processInfo.command)) {
      continue;
    }
    if (!isDescendantOfPid(processInfo.pid, options.ancestorPid, processInfos)) {
      continue;
    }
    try {
      process.kill(processInfo.pid, "SIGTERM");
      killedPids.push(processInfo.pid);
    } catch (error) {
      warnings.push(
        `Could not terminate stale Computer Use MCP child pid ${processInfo.pid}: ${describeControlFailure(error)}`,
      );
    }
  }
  return {
    attempted: true,
    killedPids,
    warnings,
    message:
      killedPids.length === 0
        ? "No stale Computer Use MCP children were found under the scoped Codex app-server process."
        : `Terminated ${killedPids.length} stale Computer Use MCP child process${killedPids.length === 1 ? "" : "es"} under the scoped Codex app-server process.`,
  };
}

function parsePsOutput(stdout: string): Array<{ pid: number; ppid: number; command: string }> {
  return stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (!match) {
        return [];
      }
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
    })
    .filter(
      (processInfo) =>
        Number.isSafeInteger(processInfo.pid) &&
        processInfo.pid > 0 &&
        Number.isSafeInteger(processInfo.ppid) &&
        processInfo.ppid >= 0,
    );
}

function isStaleComputerUseMcpChild(command: string): boolean {
  return command.includes("SkyComputerUseClient") && /(?:^|\s)mcp(?:\s|$)/u.test(command);
}

function isDescendantOfPid(
  pid: number,
  ancestorPid: number,
  processInfos: Array<{ pid: number; ppid: number }>,
): boolean {
  const parents = new Map(processInfos.map((processInfo) => [processInfo.pid, processInfo.ppid]));
  const seen = new Set<number>();
  let current = pid;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent || parent <= 0) {
      return false;
    }
    if (parent === ancestorPid) {
      return true;
    }
    current = parent;
  }
  return false;
}

function createComputerUseRequest(params: {
  pluginConfig?: unknown;
  config?: CodexComputerUseSetupParams["config"];
  agentDir?: string;
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}): CodexComputerUseRequest {
  if (params.request) {
    return params.request;
  }
  if (params.client) {
    return async <T = JsonValue | undefined>(
      method: string,
      requestParams?: unknown,
      options?: { timeoutMs?: number },
    ) =>
      await params.client!.request<T>(method, requestParams, {
        timeoutMs: options?.timeoutMs ?? params.timeoutMs,
        signal: params.signal,
      });
  }
  // One-off install/status overrides may enable Computer Use without persisting
  // config first, so keep the desktop app entitlement owner for this client.
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    managedCommandOrder: "desktop-first",
  });
  return async <T = JsonValue | undefined>(
    method: string,
    requestParams?: unknown,
    options?: { timeoutMs?: number },
  ) =>
    await requestCodexAppServerJson<T>({
      method,
      requestParams,
      timeoutMs: options?.timeoutMs ?? params.timeoutMs ?? runtime.requestTimeoutMs,
      pluginConfig: params.pluginConfig,
      startOptions: runtime.start,
      config: params.config,
      agentDir: params.agentDir,
    });
}

export const testing = { isDescendantOfPid, parsePsOutput };

function resolveComputerUseConfig(
  params: Pick<CodexComputerUseSetupParams, "pluginConfig" | "overrides" | "forceEnable">,
): ResolvedCodexComputerUseConfig {
  const overrides = params.forceEnable ? { ...params.overrides, enabled: true } : params.overrides;
  return resolveCodexComputerUseConfig({
    pluginConfig: params.pluginConfig,
    overrides,
  });
}
