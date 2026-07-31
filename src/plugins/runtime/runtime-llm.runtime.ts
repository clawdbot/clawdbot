// Runtime LLM helpers adapt plugin provider hooks into the core model runtime.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { normalizeModelRef } from "../../agents/model-selection.js";
import type { NormalizedUsage, UsageLike } from "../../agents/usage.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Message } from "../../llm/types.js";
import { getChildLogger } from "../../logging.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { normalizePluginsConfig } from "../config-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import {
  assertSupportedExecutionMode,
  isIsolatedAgentRuntimeRequest,
  runIsolatedAgentRuntimeCompletion,
} from "./runtime-llm-isolated.js";
import type {
  LlmCompleteCaller,
  LlmCompleteErrorCode,
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

function completionError(
  code: LlmCompleteErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: LlmCompleteErrorCode } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: LlmCompleteErrorCode;
  };
  error.name = "LlmCompleteError";
  error.code = code;
  return error;
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
  const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
  return resolveDefaultAgentId(params.cfg);
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function buildUsage(params: {
  rawUsage: unknown;
  normalized: NormalizedUsage | undefined;
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): LlmCompleteUsage {
  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  const costUsd =
    readExplicitCostUsd(params.rawUsage) ??
    estimateUsageCost({ usage: params.normalized, cost: costConfig });
  return {
    ...(params.normalized?.input !== undefined ? { inputTokens: params.normalized.input } : {}),
    ...(params.normalized?.output !== undefined ? { outputTokens: params.normalized.output } : {}),
    ...(params.normalized?.cacheRead !== undefined
      ? { cacheReadTokens: params.normalized.cacheRead }
      : {}),
    ...(params.normalized?.cacheWrite !== undefined
      ? { cacheWriteTokens: params.normalized.cacheWrite }
      : {}),
    ...(params.normalized?.total !== undefined ? { totalTokens: params.normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function finiteOption(value: number | undefined): number | undefined {
  return asFiniteNumber(value);
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
  const normalized = normalizeModelRef(parsed.provider, parsed.modelId);
  return modelKey(normalized.provider, normalized.model);
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
        const normalizedUsage = normalizeUsage(result.usage as UsageLike | undefined);
        const usage = buildUsage({
          rawUsage: result.usage,
          normalized: normalizedUsage,
          cfg,
          provider: result.provider,
          model: result.model,
        });
        logger.info("plugin llm completion", {
          caller,
          purpose: params.purpose,
          sessionKey: options.authority?.sessionKey,
          agentId,
          provider: result.provider,
          model: result.model,
          executionMode: params.execution.mode,
          executionOwner: result.owner,
          usage,
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
          agentId,
          usage,
          execution: { mode: params.execution.mode, owner: result.owner },
          audit: {
            caller,
            ...(params.purpose ? { purpose: params.purpose } : {}),
            ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
          },
        };
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
          maxTokens: finiteOption(params.maxTokens),
          temperature: finiteOption(params.temperature),
          ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
          signal: params.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const normalizedUsage = normalizeUsage(result.usage as UsageLike | undefined);
      const usage = buildUsage({
        rawUsage: result.usage,
        normalized: normalizedUsage,
        cfg,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
      });

      logger.info("plugin llm completion", {
        caller,
        purpose: params.purpose,
        sessionKey: options.authority?.sessionKey,
        agentId,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        executionMode: "direct-provider",
        executionOwner: { kind: "provider", id: prepared.selection.provider },
        usage,
      });

      return {
        text,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        agentId,
        usage,
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: prepared.selection.provider },
        },
        audit: {
          caller,
          ...(params.purpose ? { purpose: params.purpose } : {}),
          ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
        },
      };
    },
  };
}
