import { normalizeCodexResponsesBaseUrlForOpenAISdk } from "@openclaw/ai/transports";
import type { TSchema } from "typebox";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import { resolveModelAsync } from "../../agents/embedded-agent-runner/model.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { resolveEmbeddedAgentStreamFn } from "../../agents/embedded-agent-runner/stream-resolution.js";
import { mapThinkingLevel } from "../../agents/embedded-agent-runner/utils.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { modelCatalogLogicalKey } from "../../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { resolveProviderModelRouteAuthRequirement } from "../../agents/provider-model-route-auth.js";
import { projectProviderModelRouteConfig } from "../../agents/provider-model-route.js";
import { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import {
  prepareSimpleCompletionModel,
  type PreparedSimpleCompletionModel,
} from "../../agents/simple-completion-runtime.js";
import { bindSimpleCompletionModelResolverWorkspace } from "../../agents/simple-completion-scope.js";
import { normalizeUsage, hasNonzeroUsage } from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  Usage,
} from "../../llm/types.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  projectWorkerInferenceTerminalMessage,
  type WorkerInferenceModelIdentity,
} from "./inference-terminal-message.js";
import { createWorkerToolCallStream } from "./inference-tool-call-stream.js";
import { resolveWorkerSessionTarget, type ResolvedWorkerSessionTarget } from "./session-target.js";

type WorkerInferenceStreamEvent = WorkerInferenceEventParams["event"];
export type WorkerInferenceExecutor = import("./inference.js").WorkerInferenceExecutor;
export type WorkerInferenceExecutionParams = Parameters<WorkerInferenceExecutor>[0];

type WorkerInferenceSessionTarget = Pick<
  ResolvedWorkerSessionTarget,
  "sessionEntry" | "sessionKey" | "sessionStore" | "storePath"
> & { agentId: string };

type WorkerInferenceUsageParams = {
  config: OpenClawConfig;
  target: WorkerInferenceSessionTarget;
  request: WorkerInferenceStartParams;
  model: Model;
  usage: Usage;
  durationMs: number;
  trace: DiagnosticTraceContext;
};

type WorkerInferenceRuntimeDependencies = {
  now: () => number;
  resolveSessionTarget: (
    config: OpenClawConfig,
    sessionId: string,
  ) => WorkerInferenceSessionTarget | undefined;
  acquireRuntimeLease: typeof acquireAgentRunPreparedModelRuntime;
  resolveDefaultModel: typeof resolveDefaultModelForAgent;
  resolveSessionAuthProfile: typeof resolveSessionAuthProfileOverride;
  resolveAuthProfileMode: typeof resolveWorkerInferenceAuthProfileMode;
  resolveModel: typeof resolveModelAsync;
  prepareModel: typeof prepareSimpleCompletionModel;
  resolveProviderStream: typeof registerProviderStreamForModel;
  resolveStream: typeof resolveEmbeddedAgentStreamFn;
  applyStreamPolicy: typeof applyExtraParamsToAgent;
  wrapStream: typeof wrapStreamFnWithDiagnosticModelCallEvents;
  createTrace: typeof createDiagnosticTraceContextFromActiveScope;
  recordUsage: (params: WorkerInferenceUsageParams) => void;
};

function resolveWorkerInferenceAuthProfileMode(params: {
  config: OpenClawConfig;
  agentDir: string;
  profileId: string;
}): string | undefined {
  const configuredMode = params.config.auth?.profiles?.[params.profileId]?.mode;
  if (configuredMode) {
    return configuredMode;
  }
  return ensureAuthProfileStore(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: params.config,
  }).profiles[params.profileId]?.type;
}

export function projectWorkerInferenceModelRouteConfig(params: {
  config: OpenClawConfig;
  provider: string;
  modelId: string;
  authMode?: string;
}): OpenClawConfig {
  const authRequirement = resolveProviderModelRouteAuthRequirement(params.authMode);
  if (!authRequirement) {
    return params.config;
  }
  const resolution = resolveProviderModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
  });
  if (resolution?.kind !== "routes") {
    return params.config;
  }
  const route = resolution.routes.find(
    (candidate) => candidate.authRequirement === authRequirement,
  );
  if (!route) {
    return params.config;
  }
  // Worker placement owns the agent harness, while the gateway-owned profile
  // owns the provider route. Keep those decisions separate or OAuth can be
  // materialized as a public API-key endpoint and fail before the first token.
  return projectProviderModelRouteConfig({
    provider: params.provider,
    config: params.config,
    route,
  });
}

const ERROR_MESSAGES = {
  "model-not-approved": "Model is not approved for this agent.",
  "invalid-context": "Inference context is invalid.",
  "epoch-mismatch": "Worker run epoch does not match.",
  "session-not-attached": "Worker session is not attached.",
  "provider-error": "Model provider request failed.",
  cancelled: "Inference request was cancelled.",
} as const satisfies Record<
  Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  string
>;

function inferenceError(
  reason: Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  usage?: Usage,
): WorkerInferenceTerminalOutcome {
  return {
    type: "error",
    reason,
    message: ERROR_MESSAGES[reason],
    ...(usage ? { usage: structuredClone(usage) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyTool(tool: NonNullable<WorkerInferenceContext["tools"]>[number]): Tool | undefined {
  if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
    return undefined;
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as TSchema,
  };
}

function buildContext(context: WorkerInferenceContext): Context | undefined {
  const tools: Tool[] = [];
  for (const tool of context.tools ?? []) {
    const copied = copyTool(tool);
    if (!copied) {
      return undefined;
    }
    tools.push(copied);
  }
  return {
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    // Clone so provider mutation cannot touch the request.
    messages: structuredClone(context.messages) as Context["messages"],
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function optionBudgetsFitModel(
  options: WorkerInferenceStartParams["options"],
  model: Model,
): boolean {
  if (options.maxTokens !== undefined && options.maxTokens > model.maxTokens) {
    return false;
  }
  for (const budget of Object.values(options.thinkingBudgets ?? {})) {
    if (budget !== undefined && budget > model.maxTokens) {
      return false;
    }
  }
  return true;
}

function buildStreamOptions(params: {
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  apiKey?: string;
}): SimpleStreamOptions {
  const options = params.request.options;
  return {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: mapThinkingLevel(options.reasoning) } : {}),
    ...(options.thinkingBudgets ? { thinkingBudgets: { ...options.thinkingBudgets } } : {}),
    signal: params.signal,
    sessionId: params.request.sessionId,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };
}

function contentAt(message: AssistantMessage, index: number) {
  return message.content[index];
}

function toWorkerStreamEvent(
  event: AssistantMessageEvent,
  modelIdentity: WorkerInferenceModelIdentity,
): WorkerInferenceStreamEvent | undefined {
  switch (event.type) {
    case "start":
      return {
        type: "start",
        resolvedModel: {
          api: modelIdentity.api,
          provider: modelIdentity.provider,
          model: modelIdentity.model,
        },
        timestamp: event.partial.timestamp,
      };
    case "text_start": {
      const content = contentAt(event.partial, event.contentIndex);
      return {
        type: "text_start",
        contentIndex: event.contentIndex,
        ...(content?.type === "text" && content.textSignature
          ? { contentSignature: content.textSignature }
          : {}),
      };
    }
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const content = contentAt(event.partial, event.contentIndex);
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        ...(content?.type === "text" && content.textSignature
          ? { contentSignature: content.textSignature }
          : {}),
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end": {
      const content = contentAt(event.partial, event.contentIndex);
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        ...(content?.type === "thinking" && content.thinkingSignature
          ? { contentSignature: content.thinkingSignature }
          : {}),
      };
    }
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "done":
    case "error":
      return undefined;
  }
  return undefined;
}

function emitWorkerInferenceUsage(params: WorkerInferenceUsageParams): void {
  if (!isDiagnosticsEnabled(params.config)) {
    return;
  }
  const usage = normalizeUsage(params.usage);
  if (!hasNonzeroUsage(usage)) {
    return;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = usage.total ?? promptTokens + output;
  const costUsd = estimateUsageCost({
    usage,
    cost: resolveModelCostConfig({
      provider: params.model.provider,
      model: params.model.id,
      config: params.config,
    }),
  });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    trace: freezeDiagnosticTraceContext(params.trace),
    sessionKey: params.target.sessionKey,
    sessionId: params.request.sessionId,
    channel: "worker",
    agentId: params.target.agentId,
    provider: params.model.provider,
    model: params.model.id,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      total,
    },
    context: {
      limit: params.model.contextTokens ?? params.model.contextWindow,
      ...(usage.contextUsage?.state === "available"
        ? { used: usage.contextUsage.promptTokens }
        : {}),
    },
    ...(costUsd !== undefined ? { costUsd } : {}),
    durationMs: params.durationMs,
  });
}

const DEFAULT_DEPENDENCIES: WorkerInferenceRuntimeDependencies = {
  now: Date.now,
  resolveSessionTarget: (config, sessionId) => {
    const target = resolveWorkerSessionTarget(config, sessionId);
    if (!target) {
      return undefined;
    }
    return {
      ...target,
      agentId: target.agentId ?? resolveDefaultAgentId(config),
    };
  },
  acquireRuntimeLease: acquireAgentRunPreparedModelRuntime,
  resolveDefaultModel: resolveDefaultModelForAgent,
  resolveSessionAuthProfile: resolveSessionAuthProfileOverride,
  resolveAuthProfileMode: resolveWorkerInferenceAuthProfileMode,
  resolveModel: resolveModelAsync,
  prepareModel: prepareSimpleCompletionModel,
  resolveProviderStream: registerProviderStreamForModel,
  resolveStream: resolveEmbeddedAgentStreamFn,
  applyStreamPolicy: applyExtraParamsToAgent,
  wrapStream: wrapStreamFnWithDiagnosticModelCallEvents,
  createTrace: createDiagnosticTraceContextFromActiveScope,
  recordUsage: emitWorkerInferenceUsage,
};

function resolveReturnedProfileSource(
  entry: WorkerInferenceSessionTarget["sessionEntry"],
  profileId: string | undefined,
): "auto" | "user" | undefined {
  if (!profileId) {
    return undefined;
  }
  if (entry.authProfileOverride?.trim() !== profileId) {
    return "auto";
  }
  return (
    entry.authProfileOverrideSource ??
    (typeof entry.authProfileOverrideCompactionCount === "number" ? "auto" : "user")
  );
}

async function resolveApprovedModel(params: {
  config: OpenClawConfig;
  target: WorkerInferenceSessionTarget;
  request: WorkerInferenceStartParams;
  dependencies: WorkerInferenceRuntimeDependencies;
}): Promise<
  | {
      provider: string;
      model: string;
      config: OpenClawConfig;
      agentDir: string;
      workspaceDir: string;
      prepared: PreparedSimpleCompletionModel;
      release: () => void;
    }
  | undefined
> {
  const { config, target, request, dependencies } = params;
  const rawRef = `${request.modelRef.provider}/${request.modelRef.model}`;
  if (splitTrailingAuthProfile(rawRef).profile) {
    return undefined;
  }
  const runtimeLease = await dependencies.acquireRuntimeLease({
    config,
    agentId: target.agentId,
    agentDir: resolveAgentDir(config, target.agentId),
    inheritedAuthDir: resolveDefaultAgentDir(config),
  });
  const runtimeSnapshot = runtimeLease.snapshot;
  try {
    const lifecycleConfig = runtimeSnapshot.config;
    const agentDir = runtimeSnapshot.agentDir;
    const workspaceDir =
      runtimeSnapshot.workspaceDir ?? resolveAgentWorkspaceDir(lifecycleConfig, target.agentId);
    const manifestSnapshot = runtimeSnapshot.metadataSnapshot;
    const preparedStores = runtimeSnapshot.createStores();
    const defaultModel = dependencies.resolveDefaultModel({
      cfg: lifecycleConfig,
      agentId: target.agentId,
      manifestPlugins: manifestSnapshot.plugins,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const agentModels = resolveAgentConfig(lifecycleConfig, target.agentId)?.models;
    const aliasConfig = agentModels
      ? {
          ...lifecycleConfig,
          agents: {
            ...lifecycleConfig.agents,
            defaults: {
              ...lifecycleConfig.agents?.defaults,
              models: { ...lifecycleConfig.agents?.defaults?.models, ...agentModels },
            },
          },
        }
      : lifecycleConfig;
    const aliasIndex = buildModelAliasIndex({
      cfg: aliasConfig,
      defaultProvider: defaultModel.provider,
      manifestPlugins: manifestSnapshot.plugins,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const resolved = resolveModelRefFromString({
      cfg: aliasConfig,
      raw: rawRef,
      defaultProvider: defaultModel.provider,
      aliasIndex,
      manifestPlugins: manifestSnapshot.plugins,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    if (
      !resolved ||
      normalizeProviderId(resolved.ref.provider) !== normalizeProviderId(request.modelRef.provider)
    ) {
      runtimeLease.release();
      return undefined;
    }
    const catalog = runtimeSnapshot.modelCatalog.entries;
    const policy = createModelVisibilityPolicy({
      cfg: lifecycleConfig,
      catalog,
      defaultProvider: defaultModel.provider,
      defaultModel: `${defaultModel.provider}/${defaultModel.model}`,
      agentId: target.agentId,
      manifestPlugins: manifestSnapshot.plugins,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const resolvedKey = modelCatalogLogicalKey({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
    });
    // Retained refs stay approved during cold discovery.
    const known =
      policy.allowedCatalog.some(
        (entry: ModelCatalogEntry) => resolvedKey === modelCatalogLogicalKey(entry),
      ) || policy.retainedKeys.has(resolvedKey);
    if (!known || !policy.allows(resolved.ref)) {
      runtimeLease.release();
      return undefined;
    }
    const configuredDefaultProfile =
      resolvedKey ===
      modelCatalogLogicalKey({ provider: defaultModel.provider, id: defaultModel.model })
        ? splitTrailingAuthProfile(
            resolveAgentEffectiveModelPrimary(lifecycleConfig, target.agentId) ?? "",
          ).profile
        : undefined;
    const harnessPolicy = resolveAgentHarnessPolicy({
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      config: lifecycleConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const agentRuntimeId =
      harnessPolicy.runtimeSource !== "implicit" ||
      lifecycleConfig.plugins?.entries?.codex?.enabled === true
        ? harnessPolicy.runtime
        : undefined;
    const sessionProfileId = await dependencies.resolveSessionAuthProfile({
      cfg: lifecycleConfig,
      provider: resolved.ref.provider,
      acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: resolved.ref.provider,
        harnessRuntime: harnessPolicy.runtime,
        config: lifecycleConfig,
      }),
      agentDir,
      sessionEntry: target.sessionEntry,
      sessionStore: target.sessionStore,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      isNewSession: false,
    });
    const sessionProfileSource = resolveReturnedProfileSource(
      target.sessionEntry,
      sessionProfileId,
    );
    const selectedProfile =
      sessionProfileId && sessionProfileSource === "user"
        ? { id: sessionProfileId, source: sessionProfileSource }
        : configuredDefaultProfile
          ? { id: configuredDefaultProfile, source: "user" as const }
          : sessionProfileId
            ? { id: sessionProfileId, source: sessionProfileSource }
            : undefined;
    const modelConfig = projectWorkerInferenceModelRouteConfig({
      config: lifecycleConfig,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      authMode: selectedProfile
        ? dependencies.resolveAuthProfileMode({
            config: lifecycleConfig,
            agentDir,
            profileId: selectedProfile.id,
          })
        : undefined,
    });
    const modelResolver = bindSimpleCompletionModelResolverWorkspace(
      (provider, modelId, resolvedAgentDir, cfg, options) =>
        dependencies.resolveModel(provider, modelId, resolvedAgentDir, cfg, {
          ...options,
          authStorage: preparedStores.authStorage,
          modelRegistry: preparedStores.modelRegistry,
          ...(agentRuntimeId ? { agentRuntimeId } : {}),
          workspaceDir,
        }),
      workspaceDir,
    );
    // Route projection and credential selection are one decision. Pin even an
    // automatic profile so generic auth fallback cannot cross to another route.
    const prepared = await dependencies.prepareModel({
      cfg: modelConfig,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      agentDir,
      ...(selectedProfile ? { profileId: selectedProfile.id } : {}),
      ...(selectedProfile ? { preferredProfile: selectedProfile.id } : {}),
      ...(selectedProfile ? { bindAuthOwner: true } : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
      useAsyncModelResolution: true,
      modelResolver,
    });
    return {
      provider: resolved.ref.provider,
      model: resolved.ref.model,
      config: lifecycleConfig,
      agentDir,
      workspaceDir,
      prepared,
      release: runtimeLease.release,
    };
  } catch (error) {
    runtimeLease.release();
    throw error;
  }
}

export function createWorkerInferenceExecutor(overrides?: object): WorkerInferenceExecutor;
export function createWorkerInferenceExecutor(
  overrides: Partial<WorkerInferenceRuntimeDependencies> = {},
): WorkerInferenceExecutor {
  const dependencies: WorkerInferenceRuntimeDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  return async (params) => {
    const { identity, request, signal } = params;
    if (identity.sessionId !== request.sessionId) {
      return inferenceError("session-not-attached");
    }
    if (identity.ownerEpoch !== request.runEpoch) {
      return inferenceError("epoch-mismatch");
    }
    if (signal.aborted || !params.isCurrent()) {
      return inferenceError("cancelled");
    }
    const config = params.config ?? getRuntimeConfig();
    const target = dependencies.resolveSessionTarget(config, request.sessionId);
    if (!target) {
      return inferenceError("session-not-attached");
    }
    const context = buildContext(request.context);
    if (!context) {
      return inferenceError("invalid-context");
    }
    const approved = await resolveApprovedModel({
      config,
      target,
      request,
      dependencies,
    });
    if (!approved) {
      return inferenceError("model-not-approved");
    }
    try {
      if ("error" in approved.prepared) {
        return inferenceError("provider-error");
      }
      // Keep logical identity separate from transport endpoint encoding.
      const modelIdentity: WorkerInferenceModelIdentity = {
        api: approved.prepared.model.api,
        provider: approved.provider,
        model: approved.model,
      };
      const logicalModel = approved.prepared.model;
      const llmRuntime = getModelLlmRuntime(logicalModel);
      if (!llmRuntime) {
        throw new Error("Prepared worker model has no lifecycle runtime owner");
      }
      const providerModel =
        logicalModel.provider === "openai" && logicalModel.api === "openai-chatgpt-responses"
          ? {
              ...logicalModel,
              baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(logicalModel.baseUrl),
            }
          : logicalModel;
      const providerStream = dependencies.resolveProviderStream({
        model: providerModel,
        cfg: approved.config,
        agentDir: approved.agentDir,
        workspaceDir: approved.workspaceDir,
      });
      const authValue = approved.prepared.auth.apiKey;
      const streamAgent = {
        streamFn: dependencies.resolveStream({
          llmRuntime,
          currentStreamFn: llmRuntime.streamSimple,
          ...(providerStream ? { providerStreamFn: providerStream } : {}),
          sessionId: request.sessionId,
          signal,
          model: providerModel,
          resolvedApiKey: authValue,
          authProfileId: approved.prepared.auth.profileId,
        }),
      };
      const streamPolicyOptions: WorkerInferenceStartParams["options"] = {
        ...(request.options.temperature !== undefined
          ? { temperature: request.options.temperature }
          : {}),
        ...(request.options.maxTokens !== undefined
          ? { maxTokens: request.options.maxTokens }
          : {}),
        ...(request.options.reasoning !== undefined
          ? { reasoning: request.options.reasoning }
          : {}),
        ...(request.options.thinkingBudgets
          ? { thinkingBudgets: { ...request.options.thinkingBudgets } }
          : {}),
      };
      dependencies.applyStreamPolicy(
        streamAgent,
        approved.config,
        approved.provider,
        approved.model,
        streamPolicyOptions,
        streamPolicyOptions.reasoning,
        target.agentId,
        approved.workspaceDir,
        providerModel,
        approved.agentDir,
      );
      const scopedStream = streamAgent.streamFn;
      const model = providerModel;
      if (!optionBudgetsFitModel(request.options, model)) {
        return inferenceError("invalid-context");
      }
      if (signal.aborted || !params.isCurrent()) {
        return inferenceError("cancelled");
      }

      const startedAt = dependencies.now();
      const trace = dependencies.createTrace();
      let modelCallSeq = 0;
      const stream = dependencies.wrapStream(scopedStream, {
        runId: request.runId,
        sessionKey: target.sessionKey,
        sessionId: request.sessionId,
        provider: model.provider,
        model: model.id,
        api: model.api,
        contextTokenBudget: model.contextTokens ?? model.contextWindow,
        trace,
        contentCapture: resolveDiagnosticModelContentCapturePolicy(approved.config),
        nextCallId: () => `${request.runId}:${request.turnId}:worker-model:${(modelCallSeq += 1)}`,
      });
      let usageRecorded = false;
      const recordUsage = (usage: Usage) => {
        if (usageRecorded) {
          return;
        }
        usageRecorded = true;
        dependencies.recordUsage({
          config: approved.config,
          target,
          request,
          model,
          usage,
          durationMs: Math.max(0, dependencies.now() - startedAt),
          trace,
        });
      };
      const executionIsCurrent = () => !signal.aborted && params.isCurrent();
      const toolCalls = createWorkerToolCallStream({
        emit: params.emit,
        isCurrent: executionIsCurrent,
      });

      const providerAbort = new AbortController();
      const providerSignal = AbortSignal.any([signal, providerAbort.signal]);
      try {
        const events = await stream(
          model,
          context,
          buildStreamOptions({
            request,
            signal: providerSignal,
            apiKey: authValue,
          }),
        );
        for await (const event of events) {
          if (event.type === "done") {
            recordUsage(event.message.usage);
            if (signal.aborted || !params.isCurrent()) {
              return inferenceError("cancelled", event.message.usage);
            }
            for (const [contentIndex, content] of event.message.content.entries()) {
              if (content.type === "toolCall") {
                const endResult = toolCalls.end(contentIndex, event.message, content);
                if (endResult === "cancelled") {
                  return inferenceError("cancelled", event.message.usage);
                }
                if (endResult === "invalid") {
                  return inferenceError("provider-error");
                }
              }
            }
            if (!toolCalls.matchesTerminal(event.message)) {
              return inferenceError("provider-error");
            }
            return {
              type: "done",
              message: projectWorkerInferenceTerminalMessage({
                message: event.message,
                modelIdentity,
                stopReason: event.reason,
              }),
            };
          }
          if (event.type === "error") {
            recordUsage(event.error.usage);
            return inferenceError(
              event.reason === "aborted" ? "cancelled" : "provider-error",
              event.error.usage,
            );
          }
          if (signal.aborted || !params.isCurrent()) {
            return inferenceError("cancelled");
          }
          if (event.type === "toolcall_start") {
            if (toolCalls.start(event.contentIndex, event.partial) === "cancelled") {
              return inferenceError("cancelled");
            }
            continue;
          }
          if (event.type === "toolcall_delta") {
            const deltaResult = toolCalls.delta(event.contentIndex, event.delta, event.partial);
            if (deltaResult === "cancelled") {
              return inferenceError("cancelled");
            }
            if (deltaResult === "invalid") {
              return inferenceError("provider-error");
            }
            continue;
          }
          if (event.type === "toolcall_end") {
            const endResult = toolCalls.end(event.contentIndex, event.partial, event.toolCall);
            if (endResult === "cancelled") {
              return inferenceError("cancelled");
            }
            if (endResult === "invalid") {
              return inferenceError("provider-error");
            }
            continue;
          }
          const workerEvent = toWorkerStreamEvent(event, modelIdentity);
          if (workerEvent) {
            params.emit(workerEvent);
          }
        }
        return inferenceError(signal.aborted ? "cancelled" : "provider-error");
      } catch {
        return inferenceError(signal.aborted ? "cancelled" : "provider-error");
      } finally {
        providerAbort.abort();
      }
    } finally {
      approved.release();
    }
  };
}

export const executeWorkerInference: WorkerInferenceExecutor = createWorkerInferenceExecutor();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
