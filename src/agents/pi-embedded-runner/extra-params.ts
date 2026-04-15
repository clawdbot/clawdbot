import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  prepareProviderExtraParams as prepareProviderExtraParamsRuntime,
  wrapProviderStreamFn as wrapProviderStreamFnRuntime,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { createGoogleThinkingPayloadWrapper } from "./google-stream-wrappers.js";
import { log } from "./logger.js";
import { createMinimaxThinkingDisabledWrapper } from "./minimax-stream-wrappers.js";
import {
  createSiliconFlowThinkingWrapper,
  shouldApplySiliconFlowThinkingOffCompat,
} from "./moonshot-stream-wrappers.js";
import {
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIStringContentWrapper,
} from "./openai-stream-wrappers.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";
import { createOpenRouterSystemCacheWrapper } from "./proxy-stream-wrappers.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const defaultProviderRuntimeDeps = {
  prepareProviderExtraParams: prepareProviderExtraParamsRuntime,
  wrapProviderStreamFn: wrapProviderStreamFnRuntime,
};

const providerRuntimeDeps = {
  ...defaultProviderRuntimeDeps,
};

export const __testing = {
  setProviderRuntimeDepsForTest(
    deps: Partial<typeof defaultProviderRuntimeDeps> | undefined,
  ): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      deps?.prepareProviderExtraParams ?? defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.wrapProviderStreamFn =
      deps?.wrapProviderStreamFn ?? defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
  resetProviderRuntimeDepsForTest(): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      defaultProviderRuntimeDeps.prepareProviderExtraParams;
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
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
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

  applyDefaultOpenAIGptRuntimeParams(params, merged);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: "none" | "short" | "long";
  cachedContent?: string;
  openaiWsWarmup?: boolean;
};
type SupportedTransport = Exclude<CacheRetentionStreamOptions["transport"], undefined>;

function resolveSupportedTransport(value: unknown): SupportedTransport | undefined {
  return value === "sse" || value === "websocket" || value === "auto" ? value : undefined;
}

function hasExplicitTransportSetting(settings: { transport?: unknown }): boolean {
  return Object.hasOwn(settings, "transport");
}

export function resolvePreparedExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  agentId?: string;
  resolvedExtraParams?: Record<string, unknown>;
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
  return (
    providerRuntimeDeps.prepareProviderExtraParams({
      provider: params.provider,
      config: params.cfg,
      context: {
        config: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        extraParams: merged,
        thinkingLevel: params.thinkingLevel,
      },
    }) ?? merged
  );
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
  if (!Object.hasOwn(merged, "openaiWsWarmup")) {
    merged.openaiWsWarmup = true;
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
  if (typeof extraParams.openaiWsWarmup === "boolean") {
    streamParams.openaiWsWarmup = extraParams.openaiWsWarmup;
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
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const hasSnakeCaseKey = Object.hasOwn(source, snakeCaseKey);
    const hasCamelCaseKey = Object.hasOwn(source, camelCaseKey);
    if (!hasSnakeCaseKey && !hasCamelCaseKey) {
      continue;
    }
    resolved = hasSnakeCaseKey ? source[snakeCaseKey] : source[camelCaseKey];
    seen = true;
  }
  return seen ? resolved : undefined;
}

function createParallelToolCallsWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      model.api !== "openai-completions" &&
      model.api !== "openai-responses" &&
      model.api !== "azure-openai-responses"
    ) {
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

  if (!ctx.providerWrapperHandled) {
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

  const rawParallelToolCalls = resolveAliasedParamValue(
    [ctx.resolvedExtraParams, ctx.override],
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
  const effectiveExtraParams = resolvePreparedExtraParams({
    cfg,
    provider,
    modelId,
    extraParamsOverride,
    thinkingLevel,
    agentId,
    resolvedExtraParams,
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
      provider,
      modelId,
      extraParams: effectiveExtraParams,
      thinkingLevel,
      model,
      streamFn: providerStreamBase,
    },
  });
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  // Apply caller/config extra params outside provider defaults so explicit values
  // like `openaiWsWarmup=false` can override provider-added defaults.
  applyPrePluginStreamWrappers(wrapperContext);
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
  applyPostPluginStreamWrappers({
    ...wrapperContext,
    providerWrapperHandled,
  });

  return { effectiveExtraParams };
}
