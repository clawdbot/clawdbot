// Gateway plugin runtime adapter.
// Loads plugin registries and builds fallback request context for non-WS paths.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeModelRef, parseModelRef } from "../agents/model-selection.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { clearActivatedPluginRuntimeState, loadOpenClawPlugins } from "../plugins/loader.js";
import { loadPluginLookUpTable, type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntimeLoaderLogger } from "../plugins/runtime/load-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { PluginRuntime, RuntimeGatewayRequestOptions } from "../plugins/runtime/types.js";
import type { PluginLogger, PluginOrigin } from "../plugins/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { normalizeOperatorScopeList, type OperatorScope } from "./operator-scopes.js";
import {
  dispatchGatewayRequestInProcessRaw,
  type GatewayMethodDispatchResponse,
  unwrapGatewayMethodDispatchResponse,
} from "./server-in-process-dispatch.js";
import type { TrustedSessionCreation } from "./server-methods/session-creation-provenance.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
  resolvePluginSubagentToolsAlsoAllow,
} from "./server-plugin-runtime-client.js";
import { projectGatewayRuntimeNodes } from "./server-plugins-node-runtime.js";

export {
  clearFallbackGatewayContext,
  setFallbackGatewayContext,
  setFallbackGatewayContextResolver,
} from "./server-plugin-fallback-context.js";
export { hasInProcessGatewayContext } from "./server-plugins-node-runtime.js";

type PluginSubagentOverridePolicy = {
  allowModelOverride: boolean;

  allowAnyModel: boolean;
  hasConfiguredAllowlist: boolean;
  allowedModels: Set<string>;
};

type PluginSubagentPolicyState = {
  policies: Record<string, PluginSubagentOverridePolicy>;
};

const PLUGIN_SUBAGENT_POLICY_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginSubagentOverridePolicyState",
);

const getPluginSubagentPolicyState = () =>
  resolveGlobalSingleton<PluginSubagentPolicyState>(PLUGIN_SUBAGENT_POLICY_STATE_KEY, () => ({
    policies: {},
  }));

function normalizeAllowedModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return null;
  }
  const normalized = normalizeModelRef(parsed.provider, parsed.modelId);
  return `${normalized.provider}/${normalized.model}`;
}

export function setPluginSubagentOverridePolicies(cfg: OpenClawConfig): void {
  const pluginSubagentPolicyState = getPluginSubagentPolicyState();
  const normalized = normalizePluginsConfig(cfg.plugins);
  const policies: PluginSubagentPolicyState["policies"] = {};
  for (const [pluginId, entry] of Object.entries(normalized.entries)) {
    const allowModelOverride = entry.subagent?.allowModelOverride === true;
    const hasConfiguredAllowlist = entry.subagent?.hasAllowedModelsConfig === true;
    const configuredAllowedModels = entry.subagent?.allowedModels ?? [];
    const allowedModels = new Set<string>();
    let allowAnyModel = false;
    for (const modelRef of configuredAllowedModels) {
      const normalizedModelRef = normalizeAllowedModelRef(modelRef);
      if (!normalizedModelRef) {
        continue;
      }
      if (normalizedModelRef === "*") {
        allowAnyModel = true;
        continue;
      }
      allowedModels.add(normalizedModelRef);
    }
    if (
      !allowModelOverride &&
      !hasConfiguredAllowlist &&
      allowedModels.size === 0 &&
      !allowAnyModel
    ) {
      continue;
    }
    policies[pluginId] = {
      allowModelOverride,
      allowAnyModel,
      hasConfiguredAllowlist,
      allowedModels,
    };
  }
  pluginSubagentPolicyState.policies = policies;
}

function authorizeFallbackModelOverride(params: {
  pluginId?: string;
  provider?: string;
  model?: string;
}): { allowed: true } | { allowed: false; reason: string } {
  const pluginSubagentPolicyState = getPluginSubagentPolicyState();
  const pluginId = params.pluginId?.trim();
  if (!pluginId) {
    return {
      allowed: false,
      reason: "provider/model override requires plugin identity in fallback subagent runs.",
    };
  }
  const policy = pluginSubagentPolicyState.policies[pluginId];
  if (!policy?.allowModelOverride) {
    return {
      allowed: false,
      reason:
        `plugin "${pluginId}" is not trusted for fallback provider/model override requests. ` +
        "See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-subagent and search for: " +
        "plugins.entries.<id>.subagent.allowModelOverride",
    };
  }
  if (policy.allowAnyModel) {
    return { allowed: true };
  }
  if (policy.hasConfiguredAllowlist && policy.allowedModels.size === 0) {
    return {
      allowed: false,
      reason: `plugin "${pluginId}" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.`,
    };
  }
  if (policy.allowedModels.size === 0) {
    return { allowed: true };
  }
  const requestedModelRef = resolveRequestedFallbackModelRef(params);
  if (!requestedModelRef) {
    return {
      allowed: false,
      reason:
        "fallback provider/model overrides that use an allowlist must resolve to a canonical provider/model target.",
    };
  }
  if (policy.allowedModels.has(requestedModelRef)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `model override "${requestedModelRef}" is not allowlisted for plugin "${pluginId}".`,
  };
}

function resolveRequestedFallbackModelRef(params: {
  provider?: string;
  model?: string;
}): string | null {
  if (params.provider && params.model) {
    const normalizedRequest = normalizeModelRef(params.provider, params.model);
    return `${normalizedRequest.provider}/${normalizedRequest.model}`;
  }
  const rawModel = params.model?.trim();
  if (!rawModel || !rawModel.includes("/")) {
    return null;
  }
  const parsed = parseModelRef(rawModel, "");
  if (!parsed?.provider || !parsed.model) {
    return null;
  }
  return `${parsed.provider}/${parsed.model}`;
}

// ── Internal gateway dispatch for plugin runtime ────────────────────

function hasAdminScope(client: GatewayRequestOptions["client"] | undefined): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function canClientUseModelOverride(client: GatewayRequestOptions["client"]): boolean {
  return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

function canTrustedOfficialPluginRequestScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
}): boolean {
  if (!params.pluginId) {
    return false;
  }
  if (params.pluginOrigin === "bundled" || params.pluginTrustedOfficialInstall === true) {
    return true;
  }
  const registry = getActivePluginRegistry();
  const record = registry?.plugins.find((entry) => entry.id === params.pluginId);
  return record?.origin === "bundled" || record?.trustedOfficialInstall === true;
}

function resolveRuntimeNodeInvokeSyntheticScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  requestedScopes?: OperatorScope[];
}): OperatorScope[] | undefined {
  // Requested scopes may replace caller scopes, so only bundled or trusted official plugins qualify.
  return params.requestedScopes && canTrustedOfficialPluginRequestScopes(params)
    ? params.requestedScopes
    : undefined;
}

type DispatchGatewayMethodInProcessOptions = {
  allowSyntheticModelOverride?: boolean;
  allowSyntheticCronRunContinuation?: boolean;
  agentRunTracking?: "plugin_subagent";
  disableSyntheticClient?: boolean;
  expectFinal?: boolean;
  forceSyntheticClient?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  onAccepted?: (payload: unknown) => void;
  pluginRuntimeOwnerId?: string;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  delegatedToolPolicyHandoff?: boolean;
  sessionCreation?: TrustedSessionCreation;
  requireScopedClient?: boolean;
  syntheticScopes?: string[];
  timeoutMs?: number;
};

export type { GatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

export async function dispatchGatewayMethodInProcessRaw(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<GatewayMethodDispatchResponse> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.context ?? getFallbackGatewayContext();
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `In-process gateway dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`,
    );
  }
  if (options?.requireScopedClient === true && !scope?.client) {
    throw new Error(
      `In-process gateway dispatch requires an authenticated plugin request scope (method: ${method}).`,
    );
  }

  const pluginRuntimeOwnerId =
    typeof options?.pluginRuntimeOwnerId === "string" && options.pluginRuntimeOwnerId.trim()
      ? options.pluginRuntimeOwnerId.trim()
      : undefined;
  const syntheticClient = createSyntheticPluginRuntimeClient({
    allowModelOverride: options?.allowSyntheticModelOverride === true,
    agentRunTracking: options?.agentRunTracking,
    cronRunContinuation: options?.allowSyntheticCronRunContinuation === true,
    internalDeliveryMediaUrls: options?.internalDeliveryMediaUrls,
    internalDeliverySuppressText: options?.internalDeliverySuppressText,
    ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
    ...(options?.runtimePluginToolGrant
      ? { runtimePluginToolGrant: options.runtimePluginToolGrant }
      : {}),
    delegatedToolPolicyHandoff: options?.delegatedToolPolicyHandoff === true,
    ...(options?.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
    scopes: options?.syntheticScopes,
  });
  const scopedClient = mergePluginRuntimeClientInternal(
    scope?.client,
    pluginRuntimeOwnerId ||
      options?.agentRunTracking ||
      options?.runtimePluginToolGrant ||
      options?.delegatedToolPolicyHandoff ||
      scope?.client?.internal?.delegatedToolPolicyHandoff
      ? {
          ...(options?.agentRunTracking ? { agentRunTracking: options.agentRunTracking } : {}),
          ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
          runtimePluginToolGrant: options?.runtimePluginToolGrant,
          delegatedToolPolicyHandoff:
            options?.delegatedToolPolicyHandoff === true ? (true as const) : undefined,
        }
      : undefined,
  );
  if (options?.disableSyntheticClient === true && !scopedClient) {
    throw new Error(`In-process gateway dispatch requires a scoped client (method: ${method}).`);
  }
  return await dispatchGatewayRequestInProcessRaw(method, params, {
    client:
      options?.forceSyntheticClient === true
        ? syntheticClient
        : (scopedClient ?? (options?.disableSyntheticClient === true ? null : syntheticClient)),
    context,
    expectFinal: options?.expectFinal,
    isWebchatConnect,
    onAccepted: options?.onAccepted,
    requestIdPrefix: "plugin-subagent",
    timeoutMs: options?.timeoutMs,
  });
}

/** Live request context for trusted built-in tools that need direct runtime state. */
export function getInProcessGatewayRequestContext(): GatewayRequestContext | undefined {
  return getPluginRuntimeGatewayRequestScope()?.context ?? getFallbackGatewayContext();
}

async function dispatchGatewayMethod<T>(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  const response = await dispatchGatewayMethodInProcessRaw(method, params, options);
  return unwrapGatewayMethodDispatchResponse(method, response) as T;
}

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  return await dispatchGatewayMethod<T>(method, params, options);
}

export async function dispatchTrustedPluginGatewayMethod<T>(
  method: string,
  params: Record<string, unknown> = {},
  options?: RuntimeGatewayRequestOptions,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId = scope?.pluginId?.trim();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Gateway requests are only available to bundled or trusted official plugins.");
  }
  const syntheticScopes = normalizeOperatorScopeList(options?.scopes);
  return await dispatchGatewayMethod<T>(method, params, {
    forceSyntheticClient: true,
    pluginRuntimeOwnerId: pluginId,
    ...(syntheticScopes ? { syntheticScopes } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

function normalizeSubagentRunRuntime(
  value: unknown,
): Awaited<ReturnType<PluginRuntime["subagent"]["run"]>>["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const harness = typeof record.harness === "string" ? record.harness.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return harness && provider && model ? { harness, provider, model } : undefined;
}

export function createGatewaySubagentRuntime(): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const limit =
      params.limit == null || !Number.isFinite(params.limit)
        ? undefined
        : Math.min(
            PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(params.limit)),
          );
    const payload = await dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(limit != null && { limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  return {
    async run(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
        pluginId,
        toolsAlsoAllow: params.toolsAlsoAllow,
      });
      const overrideRequested = Boolean(params.provider || params.model);
      const hasRequestScopeClient = Boolean(scope?.client);
      let allowOverride = hasRequestScopeClient && canClientUseModelOverride(scope?.client ?? null);
      let allowSyntheticModelOverride = false;
      if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
        const fallbackAuth = authorizeFallbackModelOverride({
          pluginId: scope?.pluginId,
          provider: params.provider,
          model: params.model,
        });
        if (!fallbackAuth.allowed) {
          throw new Error(fallbackAuth.reason);
        }
        allowOverride = true;
        allowSyntheticModelOverride = true;
      }
      if (overrideRequested && !allowOverride) {
        throw new Error("provider/model override is not authorized for this plugin subagent run.");
      }
      const payload = await dispatchGatewayMethod<{ runId?: string; runtime?: unknown }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.lane && { lane: params.lane }),
          ...(params.cwd && { cwd: params.cwd }),
          ...(params.lightContext === true && { bootstrapContextMode: "lightweight" }),
          // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`,
          // so fall back to a generated UUID when the caller omits it. Without
          // this, plugin subagent runs (for example memory-core dreaming
          // narrative) silently fail schema validation at the gateway.
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          allowSyntheticModelOverride,
          agentRunTracking: "plugin_subagent",
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(runtimePluginToolGrant ? { runtimePluginToolGrant } : {}),
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      const runtime = normalizeSubagentRunRuntime(payload?.runtime);
      return { runId, ...(runtime ? { runtime } : {}) };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      let status = payload?.status;
      if (status === "completed" || status === "succeeded") {
        status = "ok";
      } else if (status === "error" && payload?.error?.trim().toLowerCase() === "completed") {
        status = "ok";
      }
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${payload?.status}`);
      }
      return {
        status,
        ...(status !== "ok" &&
          typeof payload?.error === "string" &&
          payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async deleteSession(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const pluginOwnedCleanupOptions = pluginId
        ? {
            pluginRuntimeOwnerId: pluginId,
            ...(!hasAdminScope(scope?.client)
              ? {
                  forceSyntheticClient: true,
                  syntheticScopes: [ADMIN_SCOPE],
                }
              : {}),
          }
        : undefined;
      await dispatchGatewayMethod(
        "sessions.delete",
        {
          key: params.sessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
        },
        pluginOwnedCleanupOptions,
      );
    },
  };
}

export function createGatewayNodesRuntime(): PluginRuntime["nodes"] {
  return {
    async list(params) {
      const payload = await dispatchGatewayMethod<{ nodes?: unknown[] }>("node.list", {});
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const filteredNodes =
        params?.connected === true
          ? nodes.filter(
              (node) =>
                node !== null &&
                typeof node === "object" &&
                (node as { connected?: unknown }).connected === true,
            )
          : nodes;
      const projectedNodes = projectGatewayRuntimeNodes(filteredNodes);
      return {
        nodes: projectedNodes as Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
      };
    },
    async invoke(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const syntheticScopes = resolveRuntimeNodeInvokeSyntheticScopes({
        pluginId,
        pluginOrigin: scope?.pluginOrigin,
        pluginTrustedOfficialInstall: scope?.pluginTrustedOfficialInstall,
        requestedScopes: normalizeOperatorScopeList(params.scopes),
      });
      const payload = await dispatchGatewayMethod<unknown>(
        "node.invoke",
        {
          nodeId: params.nodeId,
          command: params.command,
          ...(params.params !== undefined && { params: params.params }),
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(syntheticScopes ? { forceSyntheticClient: true, syntheticScopes } : {}),
        },
      );
      return payload;
    },
  };
}

// ── Plugin loading ──────────────────────────────────────────────────

function createGatewayPluginRegistrationLogger(params?: {
  suppressInfoLogs?: boolean;
}): PluginLogger {
  const logger = createPluginRuntimeLoaderLogger();
  if (params?.suppressInfoLogs !== true) {
    return logger;
  }
  return {
    ...logger,
    info: (_message: string) => undefined,
  };
}

export function loadGatewayPlugins(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  baseMethods: string[];
  pluginIds?: string[];
  pluginLookUpTable?: PluginLookUpTable;
  preferSetupRuntimeForChannelPlugins?: boolean;
  suppressPluginInfoLogs?: boolean;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const started = performance.now();
  const activationAutoEnabled =
    params.activationSourceConfig !== undefined && params.autoEnabledReasons === undefined
      ? applyPluginAutoEnable({
          config: params.activationSourceConfig,
          env: process.env,
          ...(params.pluginLookUpTable?.manifestRegistry
            ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
            : {}),
          discovery: params.pluginLookUpTable?.discovery,
          ambientEnvTriggers: params.ambientEnvTriggers,
        })
      : undefined;
  const autoEnableMs = performance.now() - started;
  const autoEnabled =
    params.activationSourceConfig !== undefined
      ? {
          config: params.cfg,
          changes: activationAutoEnabled?.changes ?? [],
          autoEnabledReasons:
            params.autoEnabledReasons ?? activationAutoEnabled?.autoEnabledReasons ?? {},
        }
      : params.autoEnabledReasons !== undefined
        ? {
            config: params.cfg,
            changes: [],
            autoEnabledReasons: params.autoEnabledReasons,
          }
        : applyPluginAutoEnable({
            config: params.cfg,
            env: process.env,
            ...(params.pluginLookUpTable?.manifestRegistry
              ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
              : {}),
            discovery: params.pluginLookUpTable?.discovery,
            ambientEnvTriggers: params.ambientEnvTriggers,
          });
  const resolvedConfigMs = performance.now() - started;
  const resolvedConfig = autoEnabled.config;
  const pluginIds = params.pluginIds ?? [
    ...(
      params.pluginLookUpTable ??
      loadPluginLookUpTable({
        config: resolvedConfig,
        activationSourceConfig: params.activationSourceConfig,
        workspaceDir: params.workspaceDir,
        env: process.env,
        ambientEnvTriggers: params.ambientEnvTriggers,
      })
    ).startup.pluginIds,
  ];
  const pluginIdsMs = performance.now() - started;
  if (pluginIds.length === 0) {
    clearActivatedPluginRuntimeState();
    const pluginRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pluginRegistry, undefined, "gateway-bindable", params.workspaceDir);
    params.startupTrace?.detail("plugins.gateway-load", [
      ["autoEnableMs", autoEnableMs],
      ["resolvedConfigMs", resolvedConfigMs],
      ["pluginIdsMs", pluginIdsMs],
      ["loadMs", 0],
      ["pluginIds", "0"],
      ["pluginCount", 0],
      ["gatewayHandlerCount", 0],
    ]);
    return {
      pluginRegistry,
      gatewayMethods: [...params.baseMethods],
    };
  }
  const beforeLoad = performance.now();
  const loaderStatsBefore = getPluginModuleLoaderStats();
  const pluginRegistry = loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: pluginIds,
    logger: createGatewayPluginRegistrationLogger({
      suppressInfoLogs: params.suppressPluginInfoLogs,
    }),
    ...(params.coreGatewayHandlers !== undefined && {
      coreGatewayHandlers: params.coreGatewayHandlers,
    }),
    ...(params.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: params.coreGatewayMethodNames,
    }),
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    preferBuiltPluginArtifacts: true,
    ...(params.startupTrace !== undefined && {
      startupTrace: params.startupTrace,
    }),
    ...(params.pluginLookUpTable?.manifestRegistry
      ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
      : {}),
  });
  const loadMs = performance.now() - beforeLoad;
  const loaderStatsAfter = getPluginModuleLoaderStats();
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = uniqueStrings([...params.baseMethods, ...pluginMethods]);
  params.startupTrace?.detail("plugins.gateway-load", [
    ["autoEnableMs", autoEnableMs],
    ["resolvedConfigMs", resolvedConfigMs],
    ["pluginIdsMs", pluginIdsMs],
    ["loadMs", loadMs],
    ["pluginIds", String(pluginIds.length)],
    ["pluginCount", pluginIds.length],
    ["gatewayHandlers", String(pluginMethods.length)],
    ["gatewayHandlerCount", pluginMethods.length],
    ["loaderCallsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
    ["loaderNativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
    ["loaderNativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
    [
      "loaderSourceTransformForcedCount",
      loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced,
    ],
    [
      "loaderSourceTransformFallbacksCount",
      loaderStatsAfter.sourceTransformFallbacks - loaderStatsBefore.sourceTransformFallbacks,
    ],
    [
      "loaderTopSourceTransformTargets",
      loaderStatsAfter.topSourceTransformTargets
        .slice(0, 3)
        .map((entry) => `${entry.count}:${entry.target}`)
        .join(","),
    ],
  ]);
  return { pluginRegistry, gatewayMethods };
}
