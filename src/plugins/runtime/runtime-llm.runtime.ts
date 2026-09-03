// Runtime LLM helpers adapt plugin provider hooks into the core model runtime.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeBuiltInProviderModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { asFiniteNumber, asFiniteNumberInRange } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import type { UsageLike } from "../../agents/usage.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { markHostPluginUsageDiagnosticEvent } from "../../infra/diagnostic-plugin-usage-provenance.js";
import type { Api, Message } from "../../llm/types.js";
import { getChildLogger } from "../../logging.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { modelKey } from "../../shared/model-key.js";
import {
  estimateAggregateUsageCost,
  estimateUsageCost,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { normalizePluginsConfig } from "../config-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";
import {
  assertSupportedExecutionMode,
  isIsolatedAgentRuntimeRequest,
  runIsolatedAgentRuntimeCompletion,
} from "./runtime-llm-isolated.js";
import type {
  LlmCompleteCaller,
  LlmCompleteParams,
  LlmCompleteResult,
  LlmCompleteUsage,
  PluginRuntimeCore,
  RuntimeLogger,
} from "./types-core.js";

export type RuntimeLlmAuthority = {
  caller?: LlmCompleteCaller;
  /** Trusted host-derived plugin id used only for config policy lookup. */
  pluginIdForPolicy?: string;
  sessionKey?: string;
  agentId?: string;
  preferredProfile?: string;
  requiresBoundAgent?: boolean;
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowedModels?: readonly string[];
  allowedCompletionModels?: readonly string[];
  allowAuthProfileOverride?: boolean;
  allowComplete?: boolean;
  denyReason?: string;
};

export type CreateRuntimeLlmOptions = {
  getConfig?: () => OpenClawConfig | undefined;
  authority?: RuntimeLlmAuthority;
  logger?: RuntimeLogger;
};

type RuntimeModelAllowlist = {
  configured: boolean;
  allowAny: boolean;
  models: Set<string>;
};

type RuntimeLlmPolicy = {
  allowAgentIdOverride: boolean;
  allowModelOverride: boolean;
  allowAuthProfileOverride: boolean;
  overrideModels: RuntimeModelAllowlist;
  completionModels: RuntimeModelAllowlist;
};

const defaultLogger = getChildLogger({ capability: "runtime.llm" });

function toRuntimeLogger(logger: typeof defaultLogger): RuntimeLogger {
  return {
    debug: (message, meta) => logger.debug?.(meta, message),
    info: (message, meta) => logger.info(meta, message),
    warn: (message, meta) => logger.warn(meta, message),
    error: (message, meta) => logger.error(meta, message),
  };
}

function normalizeCaller(
  caller?: LlmCompleteCaller,
  fallback?: LlmCompleteCaller,
): LlmCompleteCaller {
  const source = caller ?? fallback;
  if (!source) {
    return { kind: "unknown" };
  }
  return {
    kind: source.kind,
    ...(normalizeOptionalString(source.id) ? { id: source.id!.trim() } : {}),
    ...(normalizeOptionalString(source.name) ? { name: source.name!.trim() } : {}),
  };
}

function resolveTrustedCaller(authority?: RuntimeLlmAuthority): LlmCompleteCaller {
  if (authority?.caller?.kind === "context-engine") {
    return normalizeCaller(authority.caller);
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedPluginId = normalizeOptionalString(scope?.pluginId);
  if (scopedPluginId) {
    return { kind: "plugin", id: scopedPluginId };
  }
  return normalizeCaller(authority?.caller);
}

function resolveRuntimeConfig(options: CreateRuntimeLlmOptions): OpenClawConfig {
  const cfg = options.getConfig?.();
  if (!cfg) {
    throw new Error("Plugin LLM completion requires an injected runtime config scope.");
  }
  return cfg;
}

async function resolveAgentId(params: {
  request: LlmCompleteParams;
  cfg: OpenClawConfig;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): Promise<string> {
  const authorityAgentIdRaw = normalizeOptionalString(params.authority?.agentId);
  const requestedAgentIdRaw = normalizeOptionalString(params.request.agentId);
  const authorityAgentId = authorityAgentIdRaw ? normalizeAgentId(authorityAgentIdRaw) : undefined;
  const requestedAgentId = requestedAgentIdRaw ? normalizeAgentId(requestedAgentIdRaw) : undefined;
  if (params.authority?.requiresBoundAgent && !authorityAgentId) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion is not bound to an active session agent.",
    );
  }
  if (authorityAgentId) {
    if (requestedAgentId && requestedAgentId !== authorityAgentId && !params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the active session agent.",
      );
    }
    return authorityAgentId;
  }
  if (requestedAgentId) {
    if (!params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the target agent.",
      );
    }
    return requestedAgentId;
  }
  const { resolveAmbientOwnerAgentId } = await import("../../agents/agent-scope.js");
  return resolveAmbientOwnerAgentId(params.cfg);
}

function buildSystemPrompt(params: LlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function buildMessages(params: {
  request: LlmCompleteParams;
  provider: string;
  model: string;
  api: Api;
}): Message[] {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content, timestamp: now }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: now,
          },
    );
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0 });
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber((cost as { total?: unknown; totalUsd?: unknown }).totalUsd) ??
    readFiniteNonNegativeNumber((cost as { total?: unknown }).total)
  );
}

export function finalizePluginLlmCompletion(params: {
  cfg: OpenClawConfig;
  hostPluginId?: string;
  suppressUsage?: boolean;
  rawUsage: unknown;
  logger?: RuntimeLogger;
  result: Omit<LlmCompleteResult, "usage">;
}): LlmCompleteResult {
  const normalized = normalizeUsage(params.rawUsage as UsageLike | undefined);
  const costConfig = resolveModelCostConfig({
    provider: params.result.provider,
    model: params.result.model,
    config: params.cfg,
  });
  // Isolated runtimes may report a whole run; only direct calls retain tier boundaries here.
  const estimateCost =
    params.result.execution.mode === "direct-provider"
      ? estimateUsageCost
      : estimateAggregateUsageCost;
  const costUsd =
    readExplicitCostUsd(params.rawUsage) ?? estimateCost({ usage: normalized, cost: costConfig });
  const usage: LlmCompleteUsage = {
    ...(normalized?.input !== undefined ? { inputTokens: normalized.input } : {}),
    ...(normalized?.output !== undefined ? { outputTokens: normalized.output } : {}),
    ...(normalized?.cacheRead !== undefined ? { cacheReadTokens: normalized.cacheRead } : {}),
    ...(normalized?.cacheWrite !== undefined ? { cacheWriteTokens: normalized.cacheWrite } : {}),
    ...(normalized?.total !== undefined ? { totalTokens: normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  const logger = params.logger ?? toRuntimeLogger(defaultLogger);
  logger.info("plugin llm completion", {
    caller: params.result.audit.caller,
    purpose: params.result.audit.purpose,
    sessionKey: params.result.audit.sessionKey,
    agentId: params.result.agentId,
    provider: params.result.provider,
    model: params.result.model,
    executionMode: params.result.execution.mode,
    executionOwner: params.result.execution.owner,
    usage,
  });
  const input = normalized?.input ?? 0;
  const output = normalized?.output ?? 0;
  const cacheRead = normalized?.cacheRead ?? 0;
  const cacheWrite = normalized?.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = normalized?.total ?? promptTokens + output;
  const hasPositiveUsage = [input, output, cacheRead, cacheWrite, total, usage.costUsd].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (params.suppressUsage !== true && isDiagnosticsEnabled(params.cfg) && hasPositiveUsage) {
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          ...(params.result.audit.sessionKey ? { sessionKey: params.result.audit.sessionKey } : {}),
          agentId: params.result.agentId,
          provider: params.result.provider,
          model: params.result.model,
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            promptTokens,
            total,
          },
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        },
        params.hostPluginId,
      ),
    );
  }
  return { ...params.result, usage };
}

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
  // Operator allowlists already name canonical targets; keep policy checks independent
  // of plugin metadata and provider-runtime discovery.
  const modelId = normalizeBuiltInProviderModelId(
    parsed.provider,
    stripSelfProviderModelPrefix(parsed.provider, parsed.modelId),
  );
  return modelKey(parsed.provider, modelId);
}

function normalizeModelAllowlist(params: {
  configured: boolean;
  values?: readonly string[];
}): RuntimeModelAllowlist {
  const models = new Set<string>();
  let allowAny = false;
  for (const modelRef of params.values ?? []) {
    const normalizedModelRef = normalizeAllowedModelRef(modelRef);
    if (!normalizedModelRef) {
      continue;
    }
    if (normalizedModelRef === "*") {
      allowAny = true;
      continue;
    }
    models.add(normalizedModelRef);
  }
  return { configured: params.configured, allowAny, models };
}

function buildPolicyFromEntry(entry: {
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowAuthProfileOverride?: boolean;
  hasAllowedModelsConfig?: boolean;
  allowedModels?: readonly string[];
  hasAllowedCompletionModelsConfig?: boolean;
  allowedCompletionModels?: readonly string[];
}): RuntimeLlmPolicy {
  return {
    allowAgentIdOverride: entry.allowAgentIdOverride === true,
    allowModelOverride: entry.allowModelOverride === true,
    allowAuthProfileOverride: entry.allowAuthProfileOverride === true,
    overrideModels: normalizeModelAllowlist({
      configured: entry.hasAllowedModelsConfig === true,
      values: entry.allowedModels,
    }),
    completionModels: normalizeModelAllowlist({
      configured: entry.hasAllowedCompletionModelsConfig === true,
      values: entry.allowedCompletionModels,
    }),
  };
}

function resolvePluginPolicyId(
  authority: RuntimeLlmAuthority | undefined,
  caller: LlmCompleteCaller,
): string | undefined {
  const authorityPluginId = normalizeOptionalString(authority?.pluginIdForPolicy);
  if (authorityPluginId) {
    return authorityPluginId;
  }
  if (caller.kind !== "plugin") {
    return undefined;
  }
  const pluginId = normalizeOptionalString(caller.id);
  return pluginId;
}

function resolvePluginLlmPolicy(
  cfg: OpenClawConfig,
  pluginId: string | undefined,
): RuntimeLlmPolicy | undefined {
  if (!pluginId) {
    return undefined;
  }
  const entry = normalizePluginsConfig(cfg.plugins).entries[pluginId]?.llm;
  return entry ? buildPolicyFromEntry(entry) : undefined;
}

function resolveAuthorityModelPolicy(
  authority?: RuntimeLlmAuthority,
): RuntimeLlmPolicy | undefined {
  if (
    authority?.allowAgentIdOverride !== true &&
    authority?.allowModelOverride !== true &&
    authority?.allowAuthProfileOverride !== true &&
    authority?.allowedModels === undefined &&
    authority?.allowedCompletionModels === undefined
  ) {
    return undefined;
  }
  return buildPolicyFromEntry({
    allowAgentIdOverride: authority.allowAgentIdOverride,
    allowModelOverride: authority.allowModelOverride,
    allowAuthProfileOverride: authority.allowAuthProfileOverride,
    hasAllowedModelsConfig: authority.allowedModels !== undefined,
    allowedModels: authority.allowedModels,
    hasAllowedCompletionModelsConfig: authority.allowedCompletionModels !== undefined,
    allowedCompletionModels: authority.allowedCompletionModels,
  });
}

function assertAllowedAuthProfileOverride(params: {
  authProfileId: string | undefined;
  authorityPolicy: RuntimeLlmPolicy | undefined;
  pluginPolicy: RuntimeLlmPolicy | undefined;
}): void {
  if (!params.authProfileId) {
    return;
  }
  if (
    params.authorityPolicy?.allowAuthProfileOverride === true ||
    params.pluginPolicy?.allowAuthProfileOverride === true
  ) {
    return;
  }
  throw completionError(
    "LLM_COMPLETION_NOT_AUTHORIZED",
    "Plugin LLM completion cannot override the auth profile. Enable plugins.entries.<id>.llm.allowAuthProfileOverride to authorize it.",
  );
}

function assertOverrideModelAllowed(params: {
  resolvedModelRef: string | null;
  policy: RuntimeLlmPolicy | undefined;
  policyOwnerPluginId?: string;
}): void {
  const allowlist = params.policy?.overrideModels;
  if (!allowlist?.configured) {
    return;
  }
  if (allowlist.allowAny) {
    return;
  }
  if (allowlist.models.size === 0) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model override allowlist has no valid models.",
    );
  }
  if (!params.resolvedModelRef) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model override allowlist requires a resolvable provider/model target.",
    );
  }
  if (!allowlist.models.has(params.resolvedModelRef)) {
    const owner = params.policyOwnerPluginId ? ` for plugin "${params.policyOwnerPluginId}"` : "";
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion model override "${params.resolvedModelRef}" is not allowlisted${owner}.`,
    );
  }
}

function assertAllowedModelOverride(params: {
  resolvedModelRef: string | null;
  pluginPolicyId: string | undefined;
  authorityPolicy: RuntimeLlmPolicy | undefined;
  pluginPolicy: RuntimeLlmPolicy | undefined;
}): void {
  if (
    params.authorityPolicy?.allowModelOverride !== true &&
    params.pluginPolicy?.allowModelOverride !== true
  ) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion cannot override the target model.",
    );
  }
  // Host and operator policy are independent trust boundaries. When both
  // configure a restriction, an override must satisfy their intersection.
  assertOverrideModelAllowed({
    resolvedModelRef: params.resolvedModelRef,
    policy: params.authorityPolicy,
  });
  assertOverrideModelAllowed({
    resolvedModelRef: params.resolvedModelRef,
    policy: params.pluginPolicy,
    policyOwnerPluginId: params.pluginPolicyId,
  });
}

function assertCompletionModelAllowed(params: {
  resolvedModelRef: string | null;
  policy: RuntimeLlmPolicy | undefined;
  policyOwnerPluginId?: string;
}): void {
  const policy = params.policy;
  const allowlist = policy?.completionModels;
  if (!allowlist?.configured) {
    return;
  }
  if (allowlist.allowAny) {
    return;
  }
  if (allowlist.models.size === 0) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model allowlist has no valid models.",
    );
  }
  if (!params.resolvedModelRef) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model allowlist requires a resolvable provider/model target.",
    );
  }
  if (!allowlist.models.has(params.resolvedModelRef)) {
    const owner = params.policyOwnerPluginId ? ` for plugin "${params.policyOwnerPluginId}"` : "";
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion model "${params.resolvedModelRef}" is not allowlisted for completions${owner}.`,
    );
  }
}

/**
 * Create the host-owned generic LLM completion runtime for trusted plugin callers.
 */
export function createRuntimeLlm(
  options: CreateRuntimeLlmOptions = {},
): Pick<PluginRuntimeCore["llm"], "complete"> {
  const logger = options.logger ?? toRuntimeLogger(defaultLogger);
  return {
    complete: async (params: LlmCompleteParams): Promise<LlmCompleteResult> => {
      const caller = resolveTrustedCaller(options.authority);
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm completion denied", {
          caller,
          purpose: params.purpose,
          reason,
        });
        throw completionError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          `Plugin LLM completion denied: ${reason}`,
        );
      }
      assertSupportedExecutionMode(params);

      const [
        {
          prepareSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel,
          resolveSimpleCompletionSelectionForAgent,
        },
        cfg,
      ] = await Promise.all([
        import("../../agents/simple-completion-runtime.js"),
        Promise.resolve(resolveRuntimeConfig(options)),
      ]);
      const pluginPolicyId = resolvePluginPolicyId(options.authority, caller);
      const pluginPolicy = resolvePluginLlmPolicy(cfg, pluginPolicyId);
      const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
      const preferredProfile = normalizeOptionalString(options.authority?.preferredProfile);
      const audit = {
        caller,
        ...(params.purpose ? { purpose: params.purpose } : {}),
        ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
      };
      const agentId = await resolveAgentId({
        request: params,
        cfg,
        authority: options.authority,
        allowAgentIdOverride:
          options.authority?.allowAgentIdOverride === false
            ? false
            : authorityPolicy?.allowAgentIdOverride === true ||
              pluginPolicy?.allowAgentIdOverride === true,
      });
      const requestedModel = normalizeOptionalString(params.model);
      const requestedModelProfile = requestedModel
        ? normalizeOptionalString(splitTrailingAuthProfile(requestedModel).profile)
        : undefined;
      const selection = resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId,
        modelRef: requestedModel,
      });
      if (!selection) {
        throw completionError("LLM_COMPLETION_FAILED", `No model configured for agent ${agentId}.`);
      }
      const normalizedSelection = normalizeModelRef(selection.provider, selection.modelId);
      const resolvedModelRef = modelKey(normalizedSelection.provider, normalizedSelection.model);
      assertCompletionModelAllowed({ resolvedModelRef, policy: authorityPolicy });
      assertCompletionModelAllowed({
        resolvedModelRef,
        policy: pluginPolicy,
        policyOwnerPluginId: pluginPolicyId,
      });
      if (requestedModel) {
        assertAllowedModelOverride({
          resolvedModelRef,
          pluginPolicyId,
          authorityPolicy,
          pluginPolicy,
        });
      }

      const isolatedRequest = isIsolatedAgentRuntimeRequest(params);
      const executionProfile = isolatedRequest
        ? normalizeOptionalString(params.execution.authProfileId)
        : undefined;
      const modelProfile = normalizeOptionalString(selection.profileId);
      if (executionProfile && requestedModelProfile && executionProfile !== requestedModelProfile) {
        throw completionError(
          "LLM_ISOLATED_INPUT_REJECTED",
          "Isolated completion received conflicting auth profiles in model and execution.authProfileId.",
        );
      }

      if (isolatedRequest) {
        // Direct completions preserve the shipped model@profile contract under model
        // override authority. Isolated credential routing requires separate authority.
        assertAllowedAuthProfileOverride({
          authProfileId: executionProfile ?? requestedModelProfile,
          authorityPolicy,
          pluginPolicy,
        });
        const result = await runIsolatedAgentRuntimeCompletion({
          request: params,
          cfg,
          agentId,
          provider: selection.provider,
          model: selection.modelId,
          // Request-authorized profiles win, then the host/session binding. Only
          // an unbound call may fall back to the agent's configured selection.
          authProfileId:
            executionProfile ?? requestedModelProfile ?? preferredProfile ?? modelProfile,
        });
        return finalizePluginLlmCompletion({
          cfg,
          hostPluginId: pluginPolicyId,
          rawUsage: result.usage,
          logger,
          result: {
            text: result.text,
            provider: result.provider,
            model: result.model,
            agentId,
            execution: { mode: params.execution.mode, owner: result.owner },
            audit,
          },
        });
      }

      const prepared = await prepareSimpleCompletionModelForAgent({
        cfg,
        agentId,
        modelRef: params.model,
        preferredProfile,
        allowBundledStaticCatalogFallback: true,
        allowMissingApiKeyModes: ["aws-sdk"],
        skipAgentDiscovery: true,
      });

      if ("error" in prepared) {
        throw new Error(`Plugin LLM completion failed: ${prepared.error}`);
      }

      const context = {
        systemPrompt: buildSystemPrompt(params),
        messages: buildMessages({
          request: params,
          provider: prepared.model.provider,
          model: prepared.model.id,
          api: prepared.model.api,
        }),
      };

      const result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        cfg,
        context,
        options: {
          maxTokens: asFiniteNumber(params.maxTokens),
          temperature: asFiniteNumber(params.temperature),
          ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
          signal: params.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      return finalizePluginLlmCompletion({
        cfg,
        hostPluginId: pluginPolicyId,
        // Provider failures resolve as messages; only visible successful output owns usage.
        suppressUsage: !text.trim() || !["stop", "length", "toolUse"].includes(result.stopReason),
        rawUsage: result.usage,
        logger,
        result: {
          text,
          provider: prepared.selection.provider,
          model: prepared.selection.modelId,
          agentId,
          execution: {
            mode: "direct-provider",
            owner: { kind: "provider", id: prepared.selection.provider },
          },
          audit,
        },
      });
    },
  };
}
