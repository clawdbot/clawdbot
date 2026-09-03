import { randomUUID } from "node:crypto";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeBuiltInProviderModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { resolvePluginSubagentCompletionRequester } from "../plugins/runtime/subagent-requester-context.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginOrigin } from "../plugins/types.js";
import { createBackgroundWorkOwner } from "../process/background-work.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayContextResolver, GatewayRequestOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  prepareInProcessAgentExecution,
} from "./server-plugin-in-process-dispatch.js";
import { resolvePluginSubagentToolsAlsoAllow } from "./server-plugin-runtime-client.js";

function normalizePluginSubagentAllowedModelRef(raw: string): string | null {
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
  // Operator allowlists already name canonical targets; keep policy setup independent
  // of plugin metadata and provider-runtime discovery.
  const modelId = normalizeBuiltInProviderModelId(
    parsed.provider,
    stripSelfProviderModelPrefix(parsed.provider, parsed.modelId),
  );
  return `${parsed.provider}/${modelId}`;
}

function resolvePluginSubagentRequestedModelRef(params: {
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

function normalizePluginSubagentRunRuntime(
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

type PluginSubagentOverridePolicy = {
  allowModelOverride: boolean;

  allowAnyModel: boolean;
  hasConfiguredAllowlist: boolean;
  allowedModels: Set<string>;
};

export type PluginSubagentOverridePolicies = Record<string, PluginSubagentOverridePolicy>;

export function resolvePluginSubagentOverridePolicies(
  cfg: OpenClawConfig,
): PluginSubagentOverridePolicies {
  const normalized = normalizePluginsConfig(cfg.plugins);
  const policies: PluginSubagentOverridePolicies = {};
  for (const [pluginId, entry] of Object.entries(normalized.entries)) {
    const allowModelOverride = entry.subagent?.allowModelOverride === true;
    const hasConfiguredAllowlist = entry.subagent?.hasAllowedModelsConfig === true;
    const configuredAllowedModels = entry.subagent?.allowedModels ?? [];
    const allowedModels = new Set<string>();
    let allowAnyModel = false;
    for (const modelRef of configuredAllowedModels) {
      const normalizedModelRef = normalizePluginSubagentAllowedModelRef(modelRef);
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
  return policies;
}

function authorizeFallbackModelOverride(params: {
  policies: PluginSubagentOverridePolicies;
  pluginId?: string;
  provider?: string;
  model?: string;
}): { allowed: true } | { allowed: false; reason: string } {
  const pluginId = params.pluginId?.trim();
  if (!pluginId) {
    return {
      allowed: false,
      reason: "provider/model override requires plugin identity in fallback subagent runs.",
    };
  }
  const policy = params.policies[pluginId];
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
  const requestedModelRef = resolvePluginSubagentRequestedModelRef(params);
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

function hasAdminScope(client: GatewayRequestOptions["client"] | undefined): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function canClientUseModelOverride(client: GatewayRequestOptions["client"]): boolean {
  return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

export function canTrustedOfficialPluginRequestScopes(params: {
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

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

export function createGatewaySubagentRuntime(
  resolveGatewayContext?: GatewayContextResolver,
  overridePolicies: PluginSubagentOverridePolicies = {},
  runtimeLifetime?: AbortSignal,
): PluginRuntime["subagent"] {
  const authorizeModelOverride = (params: { provider?: string; model?: string }) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    const overrideRequested = Boolean(params.provider || params.model);
    const hasRequestScopeClient = Boolean(scope?.client);
    let allowOverride = hasRequestScopeClient && canClientUseModelOverride(scope?.client ?? null);
    let allowSyntheticModelOverride = false;
    if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
      const fallbackAuth = authorizeFallbackModelOverride({
        policies: overridePolicies,
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
    return { allowOverride, allowSyntheticModelOverride };
  };
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    const limit =
      params.limit == null || !Number.isFinite(params.limit)
        ? undefined
        : Math.min(
            PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(params.limit)),
          );
    const payload = await dispatchGatewayMethodInProcess<{ messages?: unknown[] }>(
      "sessions.get",
      {
        key: params.sessionKey,
        ...(limit != null && { limit }),
      },
      {
        resolveGatewayContext,
        ...(!scope?.client && canTrustedOfficialPluginRequestScopes(scope ?? {})
          ? { operatorRoleActor: { kind: "system" as const } }
          : {}),
      },
    );
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  const subagentRuntime: PluginRuntime["subagent"] = {
    async complete(request) {
      // Authorization and credential selection must use the same request across queue waits.
      const params = { ...request };
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId = scope?.pluginId?.trim();
      if (!pluginId) {
        throw new Error(
          "Plugin background completion requires a plugin identity and Gateway binding.",
        );
      }
      const execution = prepareInProcessAgentExecution({
        agentId: params.agentId,
        pluginRuntimeOwnerId: pluginId,
        resolveGatewayContext,
      });
      const assertCurrent = () => {
        runtimeLifetime?.throwIfAborted();
        execution.assertCurrent();
      };
      runtimeLifetime?.throwIfAborted();
      await execution.authorize();
      assertCurrent();
      authorizeModelOverride(params);
      const signals = [params.signal, runtimeLifetime, execution.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      // Preserve subagent authority while sharing the sessionless inference owner.
      // Queueing must not outlive the Gateway instance that admitted the plugin.
      return await createBackgroundWorkOwner({
        owner: `plugin:${pluginId}`,
        maxConcurrent: 3,
      }).enqueue(
        async (signal) => {
          assertCurrent();
          const [
            { resolveConfiguredAgentId },
            { resolveSimpleCompletionSelectionForAgent },
            { runIsolatedCompletion },
            { finalizePluginLlmCompletion },
          ] = await Promise.all([
            import("../agents/agent-scope.js"),
            import("../agents/simple-completion-runtime.js"),
            import("../agents/isolated-completion.js"),
            import("../plugins/runtime/runtime-llm.runtime.js"),
          ]);
          await execution.authorize();
          assertCurrent();
          signal.throwIfAborted();
          authorizeModelOverride(params);
          const cfg = execution.context.getRuntimeConfig();
          const agentId = resolveConfiguredAgentId(cfg, params.agentId);
          const selection = resolveSimpleCompletionSelectionForAgent({
            cfg,
            agentId,
            modelRef: params.model,
          });
          if (!selection) {
            throw new Error(`No model configured for agent ${agentId}.`);
          }
          const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 30_000);
          const runSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
          // Hold capacity through runtime cleanup; a response-only abort race would
          // admit another completion while the previous model still unwinds.
          const result = await execution.run(() =>
            runIsolatedCompletion({
              config: cfg,
              agentId,
              provider: selection.provider,
              model: selection.modelId,
              authProfileId: selection.profileId,
              systemPrompt: params.extraSystemPrompt ?? "",
              prompt: params.message,
              timeoutMs,
              abortSignal: runSignal,
              assertCurrent,
            }),
          );
          runSignal.throwIfAborted();
          assertCurrent();
          signal.throwIfAborted();
          finalizePluginLlmCompletion({
            cfg,
            hostPluginId: pluginId,
            rawUsage: result.usage,
            result: {
              text: result.text,
              provider: result.provider,
              model: result.model,
              agentId,
              execution: { mode: "isolated-agent-runtime", owner: result.owner },
              audit: { caller: { kind: "plugin", id: pluginId } },
            },
          });
          return { text: result.text };
        },
        { abortSignal: signals.length ? AbortSignal.any(signals) : undefined },
      );
    },
    async run(params) {
      if (params.disableTools === true && (params.toolsAlsoAllow?.length ?? 0) > 0) {
        throw new Error("Tool-free plugin subagent runs cannot request additive tools.");
      }
      const pluginSubagentRequester = resolvePluginSubagentCompletionRequester(
        params.completionDelivery,
      );
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
        pluginId,
        toolsAlsoAllow: params.toolsAlsoAllow,
      });
      const { allowOverride, allowSyntheticModelOverride } = authorizeModelOverride(params);
      const payload = await dispatchGatewayMethodInProcess<{
        runId?: string;
        sessionKey?: string;
        runtime?: unknown;
      }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.promptMode === "minimal" && { promptMode: params.promptMode }),
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
          ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(pluginSubagentRequester ? { pluginSubagentRequester } : {}),
          ...(runtimePluginToolGrant ? { runtimePluginToolGrant } : {}),
          ...(params.disableTools === true ? { pluginSubagentToolsAllow: [] } : {}),
          resolveGatewayContext,
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      const sessionKey = payload?.sessionKey?.trim() || params.sessionKey;
      const runtime = normalizePluginSubagentRunRuntime(payload?.runtime);
      return { runId, sessionKey, ...(runtime ? { runtime } : {}) };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethodInProcess<
        Omit<AgentWaitResult, "status"> & { status?: string }
      >(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
        { resolveGatewayContext },
      );
      const { status: rawStatus, error, ...metadata } = payload;
      let status = rawStatus;
      if (status === "completed" || status === "succeeded") {
        status = "ok";
      } else if (status === "error" && error?.trim().toLowerCase() === "completed") {
        status = "ok";
      }
      if (status !== "ok" && status !== "error" && status !== "timeout" && status !== "pending") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${rawStatus}`);
      }
      return {
        ...metadata,
        status,
        ...(status !== "ok" && error ? { error } : {}),
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
      await dispatchGatewayMethodInProcess(
        "sessions.delete",
        {
          key: params.sessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
        },
        {
          ...pluginOwnedCleanupOptions,
          resolveGatewayContext,
          ...(!scope?.client && canTrustedOfficialPluginRequestScopes(scope ?? {})
            ? { operatorRoleActor: { kind: "system" as const } }
            : {}),
        },
      );
    },
  };
  if (resolveGatewayContext) {
    bindGatewayContextResolver(subagentRuntime, resolveGatewayContext);
  }
  return subagentRuntime;
}
