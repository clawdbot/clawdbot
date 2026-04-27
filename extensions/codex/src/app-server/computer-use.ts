import { describeControlFailure } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexComputerUseConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import type { v2 } from "./protocol-generated/typescript/index.js";
import type { JsonValue } from "./protocol.js";
import { requestCodexAppServerJson } from "./request.js";

export type CodexComputerUseRequest = <T = JsonValue | undefined>(
  method: string,
  params?: unknown,
) => Promise<T>;

export type CodexComputerUseStatus = {
  enabled: boolean;
  ready: boolean;
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

export class CodexComputerUseSetupError extends Error {
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
};

type MarketplaceRef = {
  name?: string;
  path?: string;
  remoteMarketplaceName?: string;
};

type MarketplaceResolution = {
  marketplace?: MarketplaceRef;
  message?: string;
};

const CURATED_MARKETPLACE_POLL_INTERVAL_MS = 2_000;
const COMPUTER_USE_MARKETPLACE_NAME_PRIORITY = ["openai-bundled", "openai-curated", "local"];

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
    return unavailableStatus(config, `Computer Use check failed: ${describeControlFailure(error)}`);
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
}): Promise<CodexComputerUseStatus> {
  const request = createComputerUseRequest(params);
  if (params.installPlugin) {
    await request<v2.ExperimentalFeatureEnablementSetResponse>(
      "experimentalFeature/enablement/set",
      {
        enablement: { plugins: true },
      } satisfies v2.ExperimentalFeatureEnablementSetParams,
    );
  }

  const marketplace = await resolveMarketplaceRef({
    request,
    config: params.config,
    allowAdd: params.installPlugin,
    signal: params.signal,
  });
  if (!marketplace.marketplace) {
    return unavailableStatus(
      params.config,
      marketplace.message ??
        `No Codex marketplace containing ${params.config.pluginName} is registered. Configure computerUse.marketplaceSource or computerUse.marketplacePath, then run /codex computer-use install.`,
    );
  }

  let plugin = await readComputerUsePlugin(
    request,
    marketplace.marketplace,
    params.config.pluginName,
  );
  if (!plugin.summary.installed || !plugin.summary.enabled) {
    if (!params.installPlugin) {
      return statusFromPlugin({
        config: params.config,
        plugin,
        tools: [],
        message: `Computer Use is available but not installed. Run /codex computer-use install or enable computerUse.autoInstall.`,
      });
    }
    await request<v2.PluginInstallResponse>(
      "plugin/install",
      pluginRequestParams(
        marketplace.marketplace,
        params.config.pluginName,
      ) satisfies v2.PluginInstallParams,
    );
    await reloadMcpServers(request);
    plugin = await readComputerUsePlugin(
      request,
      marketplace.marketplace,
      params.config.pluginName,
    );
  }

  let server = await readMcpServerStatus(request, params.config.mcpServerName);
  if (!server && params.installPlugin) {
    await reloadMcpServers(request);
    server = await readMcpServerStatus(request, params.config.mcpServerName);
  }
  if (!server) {
    return statusFromPlugin({
      config: params.config,
      plugin,
      tools: [],
      message: `Computer Use is installed, but the ${params.config.mcpServerName} MCP server is not available.`,
    });
  }

  return statusFromPlugin({
    config: params.config,
    plugin,
    tools: Object.keys(server.tools).toSorted(),
    message: "Computer Use is ready.",
  });
}

async function resolveMarketplaceRef(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  signal?: AbortSignal;
}): Promise<MarketplaceResolution> {
  let preferredMarketplaceName = params.config.marketplaceName;
  if (params.config.marketplaceSource && params.allowAdd) {
    const added = await params.request<v2.MarketplaceAddResponse>("marketplace/add", {
      source: params.config.marketplaceSource,
    } satisfies v2.MarketplaceAddParams);
    preferredMarketplaceName ??= added.marketplaceName;
  }

  if (params.config.marketplacePath) {
    const marketplace: MarketplaceRef = preferredMarketplaceName
      ? { name: preferredMarketplaceName, path: params.config.marketplacePath }
      : { path: params.config.marketplacePath };
    return { marketplace };
  }

  let candidates: MarketplaceRef[] = [];
  const waitUntil = marketplaceDiscoveryWaitUntil(params);
  while (candidates.length === 0) {
    const listed = await params.request<v2.PluginListResponse>("plugin/list", {
      cwds: [],
    } satisfies v2.PluginListParams);
    candidates = findComputerUseMarketplaces(listed, params.config.pluginName);
    if (candidates.length > 0) {
      break;
    }
    if (Date.now() >= waitUntil) {
      break;
    }
    await delay(
      Math.min(CURATED_MARKETPLACE_POLL_INTERVAL_MS, waitUntil - Date.now()),
      params.signal,
    );
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

function blockUnsafeAutoInstallStatus(
  config: ResolvedCodexComputerUseConfig,
): CodexComputerUseStatus | undefined {
  if (!config.marketplaceSource && !config.marketplacePath) {
    return undefined;
  }
  return unavailableStatus(
    config,
    "Computer Use auto-install only uses marketplaces Codex app-server has already discovered. Run /codex computer-use install to install from a configured marketplace source or path.",
  );
}

function findComputerUseMarketplaces(
  listed: v2.PluginListResponse,
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
        return { name: marketplace.name, path: marketplace.path };
      }
      return { name: marketplace.name, remoteMarketplaceName: marketplace.name };
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
): Promise<v2.PluginDetail> {
  const response = await request<v2.PluginReadResponse>(
    "plugin/read",
    pluginRequestParams(marketplace, pluginName) satisfies v2.PluginReadParams,
  );
  return response.plugin;
}

async function readMcpServerStatus(
  request: CodexComputerUseRequest,
  serverName: string,
): Promise<v2.McpServerStatus | undefined> {
  let cursor: string | null | undefined;
  do {
    const response = await request<v2.ListMcpServerStatusResponse>("mcpServerStatus/list", {
      cursor,
      limit: 100,
      detail: "toolsAndAuthOnly",
    } satisfies v2.ListMcpServerStatusParams);
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
    ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
    ...(!marketplace.path && marketplace.remoteMarketplaceName
      ? { remoteMarketplaceName: marketplace.remoteMarketplaceName }
      : {}),
    pluginName,
  };
}

function statusFromPlugin(params: {
  config: ResolvedCodexComputerUseConfig;
  plugin: v2.PluginDetail;
  tools: string[];
  message: string;
}): CodexComputerUseStatus {
  return {
    enabled: true,
    ready:
      params.plugin.summary.installed && params.plugin.summary.enabled && params.tools.length > 0,
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
  message: string,
): CodexComputerUseStatus {
  return {
    enabled: true,
    ready: false,
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
