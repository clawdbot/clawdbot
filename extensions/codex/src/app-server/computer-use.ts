import { existsSync } from "node:fs";
import { describeControlFailure } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexComputerUseConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import type {
  CodexListMcpServerStatusResponse,
  CodexMcpServerStatus,
  CodexPluginDetail,
  CodexPluginListResponse,
  CodexPluginReadResponse,
  CodexRequestObject,
  JsonValue,
} from "./protocol.js";
import { requestCodexAppServerJson } from "./request.js";

export type CodexComputerUseRequest = <T = JsonValue | undefined>(
  method: string,
  params?: unknown,
) => Promise<T>;

type CodexComputerUseStatusReason =
  | "disabled"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "remote_install_unsupported"
  | "mcp_missing"
  | "ready"
  | "check_failed"
  | "auto_install_blocked";

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

export type CodexComputerUseSetupParams = {
  pluginConfig?: unknown;
  overrides?: Partial<CodexComputerUseConfig>;
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  forceEnable?: boolean;
  defaultBundledMarketplacePath?: string;
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
const DEFAULT_CODEX_BUNDLED_MARKETPLACE_PATH =
  "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled";

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
      config,
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

export async function ensureCodexComputerUse(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig(params);
  if (!config.enabled) {
    return disabledStatus(config);
  }
  const status = await inspectCodexComputerUse({
    ...params,
    config,
    installPlugin: false,
  });
  if (status.ready) {
    return status;
  }
  if (config.autoInstall) {
    const blockedAutoInstallStatus = blockUnsafeAutoInstallStatus(config);
    if (blockedAutoInstallStatus) {
      throw new CodexComputerUseSetupError(blockedAutoInstallStatus);
    }
    const installedStatus = await inspectCodexComputerUse({
      ...params,
      config,
      installPlugin: true,
    });
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
    config,
    installPlugin: true,
  });
  if (!status.ready) {
    throw new CodexComputerUseSetupError(status);
  }
  return status;
}

async function inspectCodexComputerUse(params: {
  pluginConfig?: unknown;
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  config: ResolvedCodexComputerUseConfig;
  installPlugin: boolean;
  defaultBundledMarketplacePath?: string;
}): Promise<CodexComputerUseStatus> {
  const request = createComputerUseRequest(params);
  if (params.installPlugin) {
    await request<JsonValue>("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    } satisfies CodexRequestObject);
  }

  const marketplace = await resolveMarketplaceRef({
    request,
    config: params.config,
    allowAdd: params.installPlugin,
    signal: params.signal,
    defaultBundledMarketplacePath: params.defaultBundledMarketplacePath,
  });
  if (!marketplace.marketplace) {
    return unavailableStatus(
      params.config,
      "marketplace_missing",
      marketplace.message ??
        `No Codex marketplace containing ${params.config.pluginName} is registered. Configure computerUse.marketplaceSource or computerUse.marketplacePath, then run /codex computer-use install.`,
    );
  }

  const pluginInspection = await ensureComputerUsePlugin({
    request,
    config: params.config,
    marketplace: marketplace.marketplace,
    installPlugin: params.installPlugin,
  });
  if (!pluginInspection.ok) {
    return pluginInspection.status;
  }

  return await readComputerUseTools({
    request,
    config: params.config,
    plugin: pluginInspection.plugin,
    installPlugin: params.installPlugin,
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

  return statusFromPlugin({
    config: params.config,
    plugin: params.plugin,
    tools: Object.keys(server.tools).toSorted(),
    reason: "ready",
    message: "Computer Use is ready.",
  });
}

async function resolveMarketplaceRef(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  signal?: AbortSignal;
  defaultBundledMarketplacePath?: string;
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
  if (candidates.length === 0 && shouldAddBundledComputerUseMarketplace(params)) {
    const bundledMarketplacePath =
      params.defaultBundledMarketplacePath ?? DEFAULT_CODEX_BUNDLED_MARKETPLACE_PATH;
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
}): boolean {
  const bundledMarketplacePath =
    params.defaultBundledMarketplacePath ?? DEFAULT_CODEX_BUNDLED_MARKETPLACE_PATH;
  return (
    params.allowAdd &&
    !params.config.marketplaceSource &&
    !params.config.marketplacePath &&
    !params.config.marketplaceName &&
    existsSync(bundledMarketplacePath)
  );
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
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
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
    message,
  };
}

function createComputerUseRequest(params: {
  pluginConfig?: unknown;
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}): CodexComputerUseRequest {
  if (params.request) {
    return params.request;
  }
  if (params.client) {
    return async <T = JsonValue | undefined>(method: string, requestParams?: unknown) =>
      await params.client!.request<T>(method, requestParams, {
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      });
  }
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  return async <T = JsonValue | undefined>(method: string, requestParams?: unknown) =>
    await requestCodexAppServerJson<T>({
      method,
      requestParams,
      timeoutMs: params.timeoutMs ?? runtime.requestTimeoutMs,
      startOptions: runtime.start,
    });
}

function resolveComputerUseConfig(
  params: Pick<CodexComputerUseSetupParams, "pluginConfig" | "overrides" | "forceEnable">,
): ResolvedCodexComputerUseConfig {
  const overrides = params.forceEnable ? { ...params.overrides, enabled: true } : params.overrides;
  return resolveCodexComputerUseConfig({
    pluginConfig: params.pluginConfig,
    overrides,
  });
}
