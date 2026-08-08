import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import {
  refreshCodexPluginAppInventoryState,
  refreshCodexPluginRuntimeState,
} from "./plugin-activation.js";
import {
  requestPluginApprovalOutcome,
  sanitizeCodexApprovalVisibleText,
} from "./plugin-approval-roundtrip.js";
import {
  findOpenAiCuratedPluginSummary,
  pluginReadParams,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { isJsonObject, type JsonObject, type JsonValue, type v2 } from "./protocol.js";

const CODEX_APPS_SERVER_NAME = "codex_apps";
const TOOL_SUGGESTION_KIND = "tool_suggestion";
const INSTALL_SUGGESTION_TYPE = "install";
const INSTALL_ALLOWED_DECISIONS = ["allow-once", "deny"] as const;
// Match the extension's other Codex inventory scans: tolerate large catalogs while bounding
// a malformed or adversarial stream of endlessly unique continuation cursors.
const APP_LIST_MAX_PAGES = 100;

type ToolSuggestion = {
  toolType: "plugin" | "connector";
  threadId: string;
  toolId: string;
  toolName: string;
  reason: string;
  installUrl?: string;
};

export async function handleCodexAppServerToolSuggestion(params: {
  requestParams: JsonObject;
  paramsForRun: EmbeddedRunAttemptParams;
  activeTurnId: string;
  appServerRequest?: CodexPluginRuntimeRequest;
  pluginAppCacheKey?: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const suggestion = readToolSuggestion(params.requestParams, params.activeTurnId);
  if (!suggestion) {
    return undefined;
  }

  if (suggestion.toolType === "connector" && !suggestion.installUrl) {
    const outcome = await requestPluginApprovalOutcome({
      paramsForRun: params.paramsForRun,
      title: `Cannot install ${suggestion.toolName}`,
      description: "Codex did not provide a safe install link. Complete this setup in a Codex UI.",
      toolName: "codex_connector_install",
      allowedDecisions: ["deny"],
      signal: params.signal,
    });
    return outcome === "cancelled" ? cancelResponse() : declineResponse();
  }

  const outcome = await requestPluginApprovalOutcome({
    paramsForRun: params.paramsForRun,
    title: `Install ${suggestion.toolName}`,
    description: buildInstallDescription(suggestion),
    toolName: suggestion.toolType === "plugin" ? "codex_plugin_install" : "codex_connector_install",
    allowedDecisions: [...INSTALL_ALLOWED_DECISIONS],
    signal: params.signal,
  });
  if (outcome === "cancelled") {
    return cancelResponse();
  }
  if (outcome !== "approved-once") {
    return declineResponse();
  }
  if (suggestion.toolType === "connector") {
    return acceptResponse();
  }
  if (!params.appServerRequest) {
    return declineResponse();
  }

  try {
    const installed = await installSuggestedPlugin(params.appServerRequest, suggestion.toolId);
    await refreshCodexPluginRuntimeState({
      request: params.appServerRequest,
      appCache: defaultCodexAppInventoryCache,
      appCacheKey: params.pluginAppCacheKey,
      metadataCache: defaultCodexPluginMetadataCache,
      deferAppInventoryRefresh: installed.appsNeedingAuth.length > 0,
    });
    const authorized = await authorizePluginApps({
      apps: installed.appsNeedingAuth,
      paramsForRun: params.paramsForRun,
      request: params.appServerRequest,
      threadId: suggestion.threadId,
      signal: params.signal,
    });
    if (authorized && installed.appsNeedingAuth.length > 0) {
      await refreshCodexPluginAppInventoryState({
        request: params.appServerRequest,
        appCache: defaultCodexAppInventoryCache,
        appCacheKey: params.pluginAppCacheKey,
      });
    }
    return authorized ? acceptResponse() : declineResponse();
  } catch (error) {
    embeddedAgentLog.warn("codex suggested plugin install failed", {
      toolId: suggestion.toolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return declineResponse();
  }
}

function readToolSuggestion(
  requestParams: JsonObject,
  activeTurnId: string,
): ToolSuggestion | undefined {
  if (
    requestParams.serverName !== CODEX_APPS_SERVER_NAME ||
    requestParams.mode !== "form" ||
    requestParams.turnId !== activeTurnId
  ) {
    return undefined;
  }
  const meta = isJsonObject(requestParams._meta) ? requestParams._meta : undefined;
  const requestedSchema = isJsonObject(requestParams.requestedSchema)
    ? requestParams.requestedSchema
    : undefined;
  const properties = isJsonObject(requestedSchema?.properties)
    ? requestedSchema.properties
    : undefined;
  if (
    !meta ||
    meta.codex_approval_kind !== TOOL_SUGGESTION_KIND ||
    meta.suggest_type !== INSTALL_SUGGESTION_TYPE ||
    requestedSchema?.type !== "object" ||
    !properties ||
    Object.keys(properties).length !== 0
  ) {
    return undefined;
  }
  const toolType = meta.tool_type;
  const threadId = readVisibleString(requestParams.threadId);
  const toolId = readVisibleString(meta.tool_id);
  const toolName = readVisibleString(meta.tool_name);
  const reason = readVisibleString(meta.suggest_reason);
  if (
    (toolType !== "plugin" && toolType !== "connector") ||
    !threadId ||
    !toolId ||
    !toolName ||
    !reason
  ) {
    return undefined;
  }
  const installUrl = toolType === "connector" ? readSafeHttpsUrl(meta.install_url) : undefined;
  return { toolType, threadId, toolId, toolName, reason, ...(installUrl ? { installUrl } : {}) };
}

function buildInstallDescription(suggestion: ToolSuggestion): string {
  if (suggestion.toolType === "connector") {
    return suggestion.installUrl
      ? `Open this Codex install link, finish setup, then approve:\n${suggestion.installUrl}`
      : "Codex did not provide a safe install link. Complete setup in a Codex UI, then approve.";
  }
  return `${suggestion.reason} Approve to install it in Codex.`;
}

async function installSuggestedPlugin(
  request: CodexPluginRuntimeRequest,
  toolId: string,
): Promise<v2.PluginInstallResponse> {
  const listed = (await request("plugin/list", {})) as v2.PluginListResponse;
  const resolved = findOpenAiCuratedPluginSummary(listed, toolId);
  if (!resolved) {
    throw new Error("suggested plugin was not found in the curated Codex catalog");
  }
  const installName = resolved.marketplace.remoteMarketplaceName
    ? resolved.summary.remotePluginId
    : pluginNameFromToolId(toolId);
  if (!installName) {
    throw new Error("suggested plugin did not have an installable catalog id");
  }
  return (await request(
    "plugin/install",
    pluginReadParams(resolved.marketplace, installName),
  )) as v2.PluginInstallResponse;
}

async function authorizePluginApps(params: {
  apps: v2.AppSummary[];
  paramsForRun: EmbeddedRunAttemptParams;
  request: CodexPluginRuntimeRequest;
  threadId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.apps.length === 0) {
    return true;
  }
  for (const app of params.apps) {
    const installUrl = readSafeHttpsUrl(app.installUrl);
    const outcome = await requestPluginApprovalOutcome({
      paramsForRun: params.paramsForRun,
      title: `Authorize ${readVisibleString(app.name) ?? "Codex app"}`,
      description: installUrl
        ? `Open this Codex authorization link, finish setup, then approve:\n${installUrl}`
        : "Codex did not provide a safe authorization link. Complete setup in a Codex UI, then approve.",
      toolName: "codex_app_authorization",
      allowedDecisions: [...INSTALL_ALLOWED_DECISIONS],
      signal: params.signal,
    });
    if (outcome !== "approved-once") {
      return false;
    }
  }
  return await verifyPluginAppsAccessible({
    apps: params.apps,
    request: params.request,
    threadId: params.threadId,
  });
}

async function verifyPluginAppsAccessible(params: {
  apps: readonly v2.AppSummary[];
  request: CodexPluginRuntimeRequest;
  threadId: string;
}): Promise<boolean> {
  const expectedIds = new Set(params.apps.map((app) => app.id));
  const accessibleIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < APP_LIST_MAX_PAGES; page += 1) {
    const inventory = (await params.request("app/list", {
      threadId: params.threadId,
      forceRefetch: true,
      ...(cursor ? { cursor } : {}),
    })) as { data?: v2.AppInfo[]; nextCursor?: string | null };
    for (const app of inventory.data ?? []) {
      if (app.isAccessible && expectedIds.has(app.id)) {
        accessibleIds.add(app.id);
      }
    }
    if (accessibleIds.size === expectedIds.size) {
      return true;
    }
    const nextCursor = inventory.nextCursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return false;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return false;
}

function pluginNameFromToolId(toolId: string): string | undefined {
  const at = toolId.lastIndexOf("@");
  const name = (at > 0 ? toolId.slice(0, at) : toolId).trim();
  return name || undefined;
}

function readVisibleString(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return (
    sanitizeCodexApprovalVisibleText(value, { stripDanglingTerminalSequence: true }) || undefined
  );
}

function readSafeHttpsUrl(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" || value.length > 190) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function acceptResponse(): JsonValue {
  return { action: "accept", content: null, _meta: null };
}

function declineResponse(): JsonValue {
  return { action: "decline", content: null, _meta: null };
}

function cancelResponse(): JsonValue {
  return { action: "cancel", content: null, _meta: null };
}
