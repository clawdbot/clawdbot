/**
 * Activates curated Codex marketplace plugins and keeps require-active
 * marketplaces outside OpenClaw's install authority.
 */
import type { CodexAppInventoryCache, CodexAppInventoryRequest } from "./app-inventory-cache.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
  type ResolvedCodexPluginPolicy,
} from "./config.js";
import {
  findOpenAiCuratedPluginSummary,
  isOpenAiCuratedMarketplace,
  pluginReadParams,
  type CodexPluginMarketplaceRef,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

/** Terminal reason reported after trying to activate one Codex plugin policy. */
type CodexPluginActivationReason =
  | "already_active"
  | "installed"
  | "disabled"
  | "marketplace_missing"
  | "plugin_missing"
  | "auth_required"
  | "refresh_failed";

/** Human-readable diagnostic emitted during Codex plugin activation. */
type CodexPluginActivationDiagnostic = {
  message: string;
};

/** Result of ensuring one configured Codex plugin is installed and enabled. */
export type CodexPluginActivationResult = {
  identity: ResolvedCodexPluginPolicy;
  ok: boolean;
  reason: CodexPluginActivationReason;
  installAttempted: boolean;
  marketplace?: CodexPluginMarketplaceRef;
  installResponse?: v2.PluginInstallResponse;
  diagnostics: CodexPluginActivationDiagnostic[];
};

/** Inputs for activating one resolved Codex plugin policy. */
type EnsureCodexPluginActivationParams = {
  identity: ResolvedCodexPluginPolicy;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  metadataCache?: CodexPluginMetadataCache;
  installEvenIfActive?: boolean;
  targetAppIds?: readonly string[];
};

/** Diagnostics from refreshing Codex runtime surfaces after plugin activation. */
type CodexPluginRuntimeRefreshResult = {
  diagnostics: CodexPluginActivationDiagnostic[];
};

/** Activates a curated plugin or rejects a workspace plugin that is not already active. */
export async function ensureCodexPluginActivation(
  params: EnsureCodexPluginActivationParams,
): Promise<CodexPluginActivationResult> {
  if (params.identity.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME) {
    return activationFailure(params.identity, "disabled", {
      message:
        "workspace-directory plugins must be installed and enabled outside OpenClaw before use.",
    });
  }

  const listed = await listCuratedCodexPluginMetadata(params);
  const resolved = findOpenAiCuratedPluginSummary(listed, params.identity.pluginName);
  if (!resolved) {
    const hasCuratedMarketplace = listed.marketplaces.some(isOpenAiCuratedMarketplace);
    if (!hasCuratedMarketplace) {
      return activationFailure(params.identity, "marketplace_missing", {
        message: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found.`,
      });
    }
    return activationFailure(params.identity, "plugin_missing", {
      message: `${params.identity.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.`,
    });
  }

  if (resolved.summary.installed && resolved.summary.enabled && !params.installEvenIfActive) {
    return {
      identity: params.identity,
      ok: true,
      reason: "already_active",
      installAttempted: false,
      marketplace: resolved.marketplace,
      diagnostics: [],
    };
  }

  const installResponse = (await params.request(
    "plugin/install",
    pluginReadParams(
      resolved.marketplace,
      resolved.marketplace.remoteMarketplaceName && resolved.summary.remotePluginId
        ? resolved.summary.remotePluginId
        : params.identity.pluginName,
    ) satisfies v2.PluginInstallParams,
  )) as v2.PluginInstallResponse;
  if (params.metadataCache && params.appCacheKey) {
    params.metadataCache.invalidate(params.appCacheKey);
  }
  const refreshDiagnostics: CodexPluginActivationDiagnostic[] = [];
  let refreshFailed = false;
  try {
    const refreshResult = await refreshCodexPluginRuntimeState({
      request: params.request,
      appCache: params.appCache,
      appCacheKey: params.appCacheKey,
      metadataCache: params.metadataCache,
      targetAppIds: params.targetAppIds,
    });
    refreshDiagnostics.push(...refreshResult.diagnostics);
  } catch (error) {
    refreshFailed = true;
    refreshDiagnostics.push({
      message: `Codex plugin runtime refresh failed after install: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  const authRequired = installResponse.appsNeedingAuth.length > 0;
  return {
    identity: params.identity,
    ok: !authRequired && !refreshFailed,
    reason: refreshFailed
      ? "refresh_failed"
      : authRequired
        ? "auth_required"
        : resolved.summary.installed && resolved.summary.enabled
          ? "already_active"
          : "installed",
    installAttempted: true,
    marketplace: resolved.marketplace,
    installResponse,
    diagnostics: [
      ...refreshDiagnostics,
      ...installResponse.appsNeedingAuth.map((app) => ({
        message: `${app.name} requires app authentication before plugin tools are exposed.`,
      })),
    ],
  };
}

/** Forces Codex plugin, skill, hook, MCP, and app inventory refreshes after activation. */
async function refreshCodexPluginRuntimeState(params: {
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  metadataCache?: CodexPluginMetadataCache;
  targetAppIds?: readonly string[];
}): Promise<CodexPluginRuntimeRefreshResult> {
  const diagnostics: CodexPluginActivationDiagnostic[] = [];
  await listCuratedCodexPluginMetadata(params);
  await params.request("skills/list", {
    cwds: [],
    forceReload: true,
  } satisfies v2.SkillsListParams);
  try {
    await params.request("hooks/list", {
      cwds: [],
    } satisfies v2.HooksListParams);
  } catch (error) {
    diagnostics.push({
      message: `Codex hooks refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  await params.request("config/mcpServer/reload", undefined);

  if (params.appCache && params.appCacheKey) {
    params.appCache.invalidate(params.appCacheKey, "Codex plugin activation changed app inventory");
    const request: CodexAppInventoryRequest = async (method, requestParams) =>
      (await params.request(method, requestParams)) as v2.AppsListResponse;
    try {
      await params.appCache.refreshNow({
        key: params.appCacheKey,
        request,
        forceRefetch: true,
        targetAppIds: params.targetAppIds,
      });
    } catch (error) {
      diagnostics.push({
        message: `Codex app inventory refresh skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return { diagnostics };
}

async function listCuratedCodexPluginMetadata(params: {
  request: CodexPluginRuntimeRequest;
  metadataCache?: CodexPluginMetadataCache;
  appCacheKey?: string;
}): Promise<v2.PluginListResponse> {
  const requestParams = {} satisfies v2.PluginListParams;
  if (!params.metadataCache || !params.appCacheKey) {
    return (await params.request("plugin/list", requestParams)) as v2.PluginListResponse;
  }
  const snapshot = await params.metadataCache.load({
    appCacheKey: params.appCacheKey,
    queryKind: "curated-global",
    requestParams,
    request: async (method, listedParams) =>
      (await params.request(method, listedParams)) as v2.PluginListResponse,
    // Fail-open guard: never settle a curated snapshot that lacks the curated
    // marketplace itself (upstream returns local-only on remote fetch failure
    // without a load error). See listCodexPluginMetadata in plugin-inventory.
    cacheable: (response: v2.PluginListResponse) =>
      (response.marketplaces ?? []).some((marketplace) => isOpenAiCuratedMarketplace(marketplace)),
  });
  return snapshot.response;
}

function activationFailure(
  identity: ResolvedCodexPluginPolicy,
  reason: CodexPluginActivationReason,
  diagnostic: CodexPluginActivationDiagnostic,
  extraDiagnostics: CodexPluginActivationDiagnostic[] = [],
): CodexPluginActivationResult {
  return {
    identity,
    ok: false,
    reason,
    installAttempted: false,
    diagnostics: [diagnostic, ...extraDiagnostics],
  };
}
