import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "../../plugin-sdk/provider-stream-shared.js";
import {
  prepareProviderExtraParams as prepareProviderExtraParamsRuntime,
  type ProviderRuntimePluginHandle,
  resolveProviderExtraParamsForTransport as resolveProviderExtraParamsForTransportRuntime,
  wrapProviderStreamFn as wrapProviderStreamFnRuntime,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { legacyModelKey, modelKey } from "../model-selection-normalize.js";
import { supportsGptParallelToolCallsPayload } from "../provider-api-families.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import type { AgentRuntimeTransport } from "../runtime-plan/types.js";
import { createGoogleThinkingPayloadWrapper } from "./google-stream-wrappers.js";
import { log } from "./logger.js";
import { createMinimaxThinkingDisabledWrapper } from "./minimax-stream-wrappers.js";
import {
  createSiliconFlowThinkingWrapper,
  shouldApplySiliconFlowThinkingOffCompat,
} from "./moonshot-stream-wrappers.js";
import {
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAICompletionsToolsCompatWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIStringContentWrapper,
} from "./openai-stream-wrappers.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";
import { createOpenRouterSystemCacheWrapper } from "./proxy-stream-wrappers.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const defaultProviderRuntimeDeps = {
  prepareProviderExtraParams: prepareProviderExtraParamsRuntime,
  resolveProviderExtraParamsForTransport: resolveProviderExtraParamsForTransportRuntime,
  wrapProviderStreamFn: wrapProviderStreamFnRuntime,
};

const providerRuntimeDeps = {
  ...defaultProviderRuntimeDeps,
};

let preparedExtraParamsCache = new WeakMap<OpenClawConfig, Map<string, Record<string, unknown>>>();

export const __testing = {
  setProviderRuntimeDepsForTest(
    deps: Partial<typeof defaultProviderRuntimeDeps> | undefined,
  ): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      deps?.prepareProviderExtraParams ?? defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.resolveProviderExtraParamsForTransport =
      deps?.resolveProviderExtraParamsForTransport ??
      defaultProviderRuntimeDeps.resolveProviderExtraParamsForTransport;
    providerRuntimeDeps.wrapProviderStreamFn =
      deps?.wrapProviderStreamFn ?? defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
  resetProviderRuntimeDepsForTest(): void {
    clearPreparedExtraParamsCache();
    providerRuntimeDeps.prepareProviderExtraParams =
      defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.resolveProviderExtraParamsForTransport =
      defaultProviderRuntimeDeps.resolveProviderExtraParamsForTransport;
    providerRuntimeDeps.wrapProviderStreamFn = defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
};

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const defaultParams = params.cfg?.agents?.defaults?.params ?? undefined;
  const canonicalKey = modelKey(params.provider, params.modelId);
  const legacyKey = legacyModelKey(params.provider, params.modelId);
  const configuredModels = params.cfg?.agents?.defaults?.models;
  const modelConfig =
    configuredModels?.[canonicalKey] ?? (legacyKey ? configuredModels?.[legacyKey] : undefined);
  const globalParams = modelConfig?.params ? { ...modelConfig.params } : undefined;
  const agentParams =
    params.agentId && params.cfg?.agents?.list
      ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params
      : undefined;

  const merged = Object.assign({}, defaultParams, globalParams, agentParams);
  const resolvedParallelToolCalls = resolveAliasedParamValue(
    [defaultParams, globalParams, agentParams],
    "parallel_tool_calls",
    "parallelToolCalls",
  );
  if (resolvedParallelToolCalls !== undefined) {
    merged.parallel_tool_calls = resolvedParallelToolCalls;
    delete merged.parallelToolCalls;
  }

  const resolvedTextVerbosity = resolveAliasedParamValue(
    [globalParams, agentParams],
    "text_verbosity",
    "textVerbosity",
  );
  if (resolvedTextVerbosity !== undefined) {
    merged.text_verbosity = resolvedTextVerbosity;
    delete merged.textVerbosity;
  }

  const resolvedCachedContent = resolveAliasedParamValue(
    [defaultParams, globalParams, agentParams],
    "cached_content",
    "cachedContent",
  );
  if (resolvedCachedContent !== undefined) {
    merged.cachedContent = resolvedCachedContent;
    delete merged.cached_content;
  }
  if (params.provider === "openrouter") {
    canonicalizeOpenRouterResponseCacheParams(merged, [defaultParams, globalParams, agentParams]);
  }

  applyDefaultOpenAIGptRuntimeParams(params, merged);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: "none" | "short" | "long";
  cachedContent?: string;
};
export type SupportedTransport = AgentRuntimeTransport;

function resolveSupportedTransport(value: unknown): SupportedTransport | undefined {
  return value === "sse" || value === "websocket" || value === "auto" ? value : undefined;
}

function hasExplicitTransportSetting(settings: { transport?: unknown }): boolean {
  return Object.hasOwn(settings, "transport");
}

function clearPreparedExtraParamsCache(): void {
  preparedExtraParamsCache = new WeakMap();
}

function fingerprintPreparedExtraParamsModel(model?: ProviderRuntimeModel): unknown {
  if (!model) {
    return null;
  }
  const record = model as unknown as Record<string, unknown>;
  return {
    api: model.api,
    provider: model.provider,
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    compat: record.compat ?? null,
    contextWindow: model.contextWindow,
    contextTokens: model.contextTokens ?? null,
    headers: record.headers ?? null,
    maxTokens: model.maxTokens,
    params: model.params ?? null,
    requestTimeoutMs: model.requestTimeoutMs ?? null,
  };
}

function resolvePreparedExtraParamsCacheKey(params: {
  provider: string;
  modelId: string;
  agentDir?: string;
  workspaceDir?: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  agentId?: string;
  resolvedExtraParams?: Record<string, unknown>;
  model?: ProviderRuntimeModel;
  resolvedTransport?: SupportedTransport;
}): string {
  return JSON.stringify({
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId ?? "",
    agentDir: params.agentDir ?? "",
    workspaceDir: params.workspaceDir ?? "",
    thinkingLevel: params.thinkingLevel ?? "",
    resolvedTransport: params.resolvedTransport ?? "",
    extraParamsOverride: params.extraParamsOverride ?? null,
    resolvedExtraParams: params.resolvedExtraParams ?? null,
    model: fingerprintPreparedExtraParamsModel(params.model),
  });
}

export function resolvePreparedExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  workspaceDir?: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  agentId?: string;
  resolvedExtraParams?: Record<string, unknown>;
  model?: ProviderRuntimeModel;
  resolvedTransport?: SupportedTransport;
  providerRuntimeHandle?: ProviderRuntimePluginHandle;
}): Record<string, unknown> {
  const resolvedExtraParams =
    params.resolvedExtraParams ??
    resolveExtraParams({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    });
  const override =
    params.extraParamsOverride && Object.keys(params.extraParamsOverride).length > 0
      ? sanitizeExtraParamsRecord(
          Object.fromEntries(
            Object.entries(params.extraParamsOverride).filter(([, value]) => value !== undefined),
          ),
        )
      : undefined;
  const merged = {
    ...sanitizeExtraParamsRecord(resolvedExtraParams),
    ...override,
  };
  const resolvedCachedContent = resolveAliasedParamValue(
    [resolvedExtraParams, override],
    "cached_content",
    "cachedContent",
  );
  if (resolvedCachedContent !== undefined) {
    merged.cachedContent = resolvedCachedContent;
    delete merged.cached_content;
  }
  if (params.provider === "openrouter") {
    canonicalizeOpenRouterResponseCacheParams(merged, [resolvedExtraParams, override]);
  }
  const cfg = params.cfg;
  const cacheKey = cfg ? resolvePreparedExtraParamsCacheKey(params) : undefined;
  if (cacheKey) {
    const cached = preparedExtraParamsCache.get(cfg!)?.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const prepared =
    providerRuntimeDeps.prepareProviderExtraParams({
      provider: params.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeHandle: params.providerRuntimeHandle,
      context: {
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        provider: params.provider,
        modelId: params.modelId,
        extraParams: merged,
        thinkingLevel: params.thinkingLevel,
      },
    }) ?? merged;
  const transportPatch = providerRuntimeDeps.resolveProviderExtraParamsForTransport({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHandle: params.providerRuntimeHandle,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.modelId,
      extraParams: prepared,
      thinkingLevel: params.thinkingLevel,
      model: params.model,
      transport: params.resolvedTransport ?? resolveSupportedTransport(prepared.transport),
    },
  })?.patch;
  const result = transportPatch ? { ...prepared, ...transportPatch } : prepared;
  if (cacheKey) {
    let bucket = preparedExtraParamsCache.get(cfg!);
    if (!bucket) {
      bucket = new Map();
      preparedExtraParamsCache.set(cfg!, bucket);
    }
    bucket.set(cacheKey, result);
  }
  return result;
}

function sanitizeExtraParamsRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
    ),
  );
}

function shouldApplyDefaultOpenAIGptRuntimeParams(params: {
  provider: string;
  modelId: string;
}): boolean {
  if (params.provider !== "openai" && params.provider !== "openai-codex") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId);
}

function applyDefaultOpenAIGptRuntimeParams(
  params: { provider: string; modelId: string },
  merged: Record<string, unknown>,
): void {
  if (!shouldApplyDefaultOpenAIGptRuntimeParams(params)) {
    return;
  }
  if (
    !Object.hasOwn(merged, "parallel_tool_calls") &&
    !Object.hasOwn(merged, "parallelToolCalls")
  ) {
    merged.parallel_tool_calls = true;
  }
  if (!Object.hasOwn(merged, "text_verbosity") && !Object.hasOwn(merged, "textVerbosity")) {
    merged.text_verbosity = "low";
  }
}

export function resolveAgentTransportOverride(params: {
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
  effectiveExtraParams: Record<string, unknown> | undefined;
}): SupportedTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (hasExplicitTransportSetting(globalSettings) || hasExplicitTransportSetting(projectSettings)) {
    return undefined;
  }
  return resolveSupportedTransport(params.effectiveExtraParams?.transport);
}

export function resolveExplicitSettingsTransport(params: {
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
  sessionTransport: unknown;
}): SupportedTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (
    !hasExplicitTransportSetting(globalSettings) &&
    !hasExplicitTransportSetting(projectSettings)
  ) {
    return undefined;
  }
  return resolveSupportedTransport(params.sessionTransport);
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  model?: ProviderRuntimeModel,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  const transport = resolveSupportedTransport(extraParams.transport);
  if (transport) {
    streamParams.transport = transport;
  } else if (extraParams.transport != null) {
    const transportSummary =
      typeof extraParams.transport === "string"
        ? extraParams.transport
        : typeof extraParams.transport;
    log.warn(`ignoring invalid transport param: ${transportSummary}`);
  }
  const cachedContent =
    typeof extraParams.cachedContent === "string"
      ? extraParams.cachedContent
      : typeof extraParams.cached_content === "string"
        ? extraParams.cached_content
        : undefined;
  if (typeof cachedContent === "string" && cachedContent.trim()) {
    streamParams.cachedContent = cachedContent.trim();
  }
  const initialCacheRetention = resolveCacheRetention(
    extraParams,
    provider,
    typeof model?.api === "string" ? model.api : undefined,
    typeof model?.id === "string" ? model.id : undefined,
  );
  if (Object.keys(streamParams).length > 0 || initialCacheRetention) {
    const debugParams = initialCacheRetention
      ? { ...streamParams, cacheRetention: initialCacheRetention }
      : streamParams;
    log.debug(`creating streamFn wrapper with params: ${JSON.stringify(debugParams)}`);
  }

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (callModel, context, options) => {
    const cacheRetention = resolveCacheRetention(
      extraParams,
      provider,
      typeof callModel.api === "string" ? callModel.api : undefined,
      typeof callModel.id === "string" ? callModel.id : undefined,
    );
    if (Object.keys(streamParams).length === 0 && !cacheRetention) {
      return underlying(callModel, context, options);
    }
    return underlying(callModel, context, {
      ...streamParams,
      ...(cacheRetention ? { cacheRetention } : {}),
      ...options,
    });
  };

  return wrappedStreamFn;
}

function resolveAliasedParamValue(
  sources: Array<Record<string, unknown> | undefined>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown {
  return resolveAliasedParamValueFromKeys(sources, [snakeCaseKey, camelCaseKey]);
}

function resolveAliasedParamValueFromKeys(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): unknown {
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      resolved = source[key];
      seen = true;
      break;
    }
  }
  return seen ? resolved : undefined;
}

function applyCanonicalAliasedParamValue(params: {
  merged: Record<string, unknown>;
  sources: Array<Record<string, unknown> | undefined>;
  keys: readonly string[];
  canonicalKey: string;
}): void {
  const resolved = resolveAliasedParamValueFromKeys(params.sources, params.keys);
  if (resolved === undefined) {
    return;
  }
  for (const key of params.keys) {
    delete params.merged[key];
  }
  params.merged[params.canonicalKey] = resolved;
}

function canonicalizeOpenRouterResponseCacheParams(
  merged: Record<string, unknown>,
  sources: Array<Record<string, unknown> | undefined>,
): void {
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: ["responseCache", "response_cache"],
    canonicalKey: "responseCache",
  });
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: [
      "responseCacheTtlSeconds",
      "response_cache_ttl_seconds",
      "responseCacheTtl",
      "response_cache_ttl",
    ],
    canonicalKey: "responseCacheTtlSeconds",
  });
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: ["responseCacheClear", "response_cache_clear"],
    canonicalKey: "responseCacheClear",
  });
}

function createParallelToolCallsWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!supportsGptParallelToolCallsPayload(model.api)) {
      return underlying(model, context, options);
    }
    log.debug(
      `applying parallel_tool_calls=${enabled} for ${model.provider ?? "unknown"}/${model.id ?? "unknown"} api=${model.api}`,
    );
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.parallel_tool_calls = enabled;
    });
  };
}

function shouldStripOpenAICompletionsStore(model: ProviderRuntimeModel): boolean {
  if (model.api !== "openai-completions") {
    return false;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  const capabilities = resolveProviderRequestPolicyConfig({
    provider: typeof model.provider === "string" ? model.provider : undefined,
    api: model.api,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    compat,
    capability: "llm",
    transport: "stream",
  }).capabilities;
  return !capabilities.usesKnownNativeOpenAIRoute;
}

function createOpenAICompletionsStoreCompatWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldStripOpenAICompletionsStore(model as ProviderRuntimeModel)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      delete payloadObj.store;
    });
  };
}

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
}

function resolveExtraBodyParam(rawExtraBody: unknown): Record<string, unknown> | undefined {
  if (rawExtraBody === undefined || rawExtraBody === null) {
    return undefined;
  }
  if (typeof rawExtraBody !== "object" || Array.isArray(rawExtraBody)) {
    const summary = typeof rawExtraBody === "string" ? rawExtraBody : typeof rawExtraBody;
    log.warn(`ignoring invalid extra_body param: ${summary}`);
    return undefined;
  }
  const extraBody = sanitizeExtraBodyRecord(rawExtraBody as Record<string, unknown>);
  return Object.keys(extraBody).length > 0 ? extraBody : undefined;
}

function resolveChatTemplateKwargsParam(
  rawChatTemplateKwargs: unknown,
): Record<string, unknown> | undefined {
  if (rawChatTemplateKwargs === undefined || rawChatTemplateKwargs === null) {
    return undefined;
  }
  if (typeof rawChatTemplateKwargs !== "object" || Array.isArray(rawChatTemplateKwargs)) {
    const summary =
      typeof rawChatTemplateKwargs === "string"
        ? rawChatTemplateKwargs
        : typeof rawChatTemplateKwargs;
    log.warn(`ignoring invalid chat_template_kwargs param: ${summary}`);
    return undefined;
  }
  const chatTemplateKwargs = sanitizeExtraBodyRecord(
    rawChatTemplateKwargs as Record<string, unknown>,
  );
  return Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : undefined;
}

function createOpenAICompletionsChatTemplateKwargsWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  configured: Record<string, unknown>;
}): StreamFn {
  const underlying = params.baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const existing = payloadObj.chat_template_kwargs;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        payloadObj.chat_template_kwargs = {
          ...(existing as Record<string, unknown>),
          ...params.configured,
        };
        return;
      }
      payloadObj.chat_template_kwargs = params.configured;
    });
  };
}

function createOpenAICompletionsExtraBodyWrapper(
  baseStreamFn: StreamFn | undefined,
  extraBody: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const collisions = Object.keys(extraBody).filter((key) => Object.hasOwn(payloadObj, key));
      if (collisions.length > 0) {
        log.warn(`extra_body overwriting request payload keys: ${collisions.join(", ")}`);
      }
      Object.assign(payloadObj, extraBody);
    });
  };
}

type ApplyExtraParamsContext = {
  agent: { streamFn?: StreamFn };
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  workspaceDir?: string;
  thinkingLevel?: ThinkLevel;
  model?: ProviderRuntimeModel;
  effectiveExtraParams: Record<string, unknown>;
  resolvedExtraParams?: Record<string, unknown>;
  override?: Record<string, unknown>;
};

function applyPrePluginStreamWrappers(ctx: ApplyExtraParamsContext): void {
  const wrappedStreamFn = createStreamFnWithExtraParams(
    ctx.agent.streamFn,
    ctx.effectiveExtraParams,
    ctx.provider,
    ctx.model,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${ctx.provider}/${ctx.modelId}`);
    ctx.agent.streamFn = wrappedStreamFn;
  }

  if (
    shouldApplySiliconFlowThinkingOffCompat({
      provider: ctx.provider,
      modelId: ctx.modelId,
      thinkingLevel: ctx.thinkingLevel,
    })
  ) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${ctx.provider}/${ctx.modelId})`,
    );
    ctx.agent.streamFn = createSiliconFlowThinkingWrapper(ctx.agent.streamFn);
  }
}

function applyPostPluginStreamWrappers(
  ctx: ApplyExtraParamsContext & { providerWrapperHandled: boolean },
): void {
  ctx.agent.streamFn = createOpenRouterSystemCacheWrapper(ctx.agent.streamFn);
  ctx.agent.streamFn = createOpenAIStringContentWrapper(ctx.agent.streamFn);
  ctx.agent.streamFn = createOpenAICompletionsStrictMessageKeysWrapper(ctx.agent.streamFn);
  ctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(ctx.agent.streamFn);

  if (!ctx.providerWrapperHandled) {
    ctx.agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: ctx.agent.streamFn,
      thinkingLevel: ctx.thinkingLevel,
      shouldPatchModel: isDeepSeekV4OpenAICompatibleModel,
    });

    // Guard Google-family payloads against invalid negative thinking budgets
    // emitted by upstream model-ID heuristics for Gemini 3.1 variants.
    ctx.agent.streamFn = createGoogleThinkingPayloadWrapper(ctx.agent.streamFn, ctx.thinkingLevel);

    // Work around upstream pi-ai hardcoding `store: false` for Responses API.
    // Force `store=true` for direct OpenAI Responses models and auto-enable
    // server-side compaction for compatible Responses payloads.
    ctx.agent.streamFn = createOpenAIResponsesContextManagementWrapper(
      ctx.agent.streamFn,
      ctx.effectiveExtraParams,
    );
  }

  // MiniMax's Anthropic-compatible stream can leak reasoning_content into the
  // visible reply path because it does not emit native Anthropic thinking
  // blocks. Disable thinking unless an earlier wrapper already set it.
  ctx.agent.streamFn = createMinimaxThinkingDisabledWrapper(ctx.agent.streamFn);

  const rawChatTemplateKwargs = resolveAliasedParamValue(
    [ctx.effectiveExtraParams, ctx.override],
    "chat_template_kwargs",
    "chatTemplateKwargs",
  );
  const configuredChatTemplateKwargs = resolveChatTemplateKwargsParam(rawChatTemplateKwargs);
  if (configuredChatTemplateKwargs) {
    ctx.agent.streamFn = createOpenAICompletionsChatTemplateKwargsWrapper({
      baseStreamFn: ctx.agent.streamFn,
      configured: configuredChatTemplateKwargs,
    });
  }

  const rawExtraBody = resolveAliasedParamValue(
    [ctx.effectiveExtraParams, ctx.override],
    "extra_body",
    "extraBody",
  );
  const extraBody = resolveExtraBodyParam(rawExtraBody);
  if (extraBody) {
    ctx.agent.streamFn = createOpenAICompletionsExtraBodyWrapper(ctx.agent.streamFn, extraBody);
  }
  ctx.agent.streamFn = createOpenAICompletionsStoreCompatWrapper(ctx.agent.streamFn);

  const rawParallelToolCalls = resolveAliasedParamValue(
    [ctx.effectiveExtraParams, ctx.override],
    "parallel_tool_calls",
    "parallelToolCalls",
  );
  if (rawParallelToolCalls === undefined) {
    return;
  }
  if (typeof rawParallelToolCalls === "boolean") {
    ctx.agent.streamFn = createParallelToolCallsWrapper(ctx.agent.streamFn, rawParallelToolCalls);
    return;
  }
  if (rawParallelToolCalls === null) {
    log.debug("parallel_tool_calls suppressed by null override, skipping injection");
    return;
  }
  const summary =
    typeof rawParallelToolCalls === "string" ? rawParallelToolCalls : typeof rawParallelToolCalls;
  log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
}

function normalizeDeepSeekV4CandidateId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const withoutSuffix = modelId.trim().toLowerCase().split(":", 1)[0];
  return withoutSuffix.split("/").pop();
}

function isDeepSeekV4OpenAICompatibleModel(model: Parameters<StreamFn>[0]): boolean {
  const normalizedModelId = normalizeDeepSeekV4CandidateId(model.id);
  return (
    model.api === "openai-completions" &&
    (normalizedModelId === "deepseek-v4-flash" || normalizedModelId === "deepseek-v4-pro")
  );
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  thinkingLevel?: ThinkLevel,
  agentId?: string,
  workspaceDir?: string,
  model?: ProviderRuntimeModel,
  agentDir?: string,
  resolvedTransport?: SupportedTransport,
  options?: { preparedExtraParams?: Record<string, unknown> },
): { effectiveExtraParams: Record<string, unknown> } {
  const resolvedExtraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
    agentId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const effectiveExtraParams =
    options?.preparedExtraParams ??
    resolvePreparedExtraParams({
      cfg,
      provider,
      modelId,
      extraParamsOverride,
      thinkingLevel,
      agentId,
      agentDir,
      workspaceDir,
      resolvedExtraParams,
      model,
      resolvedTransport,
    });
  const wrapperContext: ApplyExtraParamsContext = {
    agent,
    cfg,
    provider,
    modelId,
    agentDir,
    workspaceDir,
    thinkingLevel,
    model,
    effectiveExtraParams,
    resolvedExtraParams,
    override,
  };

  const providerStreamBase = agent.streamFn;
  const pluginWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
    provider,
    config: cfg,
    context: {
      config: cfg,
      agentDir,
      workspaceDir,
      provider,
      modelId,
      extraParams: effectiveExtraParams,
      thinkingLevel,
      model,
      streamFn: providerStreamBase,
    },
  });
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  // Apply caller/config extra params outside provider defaults so explicit runtime
  // transport values can override provider-added defaults.
  applyPrePluginStreamWrappers(wrapperContext);
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
  applyPostPluginStreamWrappers({
    ...wrapperContext,
    providerWrapperHandled,
  });

  return { effectiveExtraParams };
}
