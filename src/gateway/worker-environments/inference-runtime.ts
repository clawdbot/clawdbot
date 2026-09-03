import { normalizeCodexResponsesBaseUrlForOpenAISdk } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import { resolveModelAsync } from "../../agents/embedded-agent-runner/model.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { resolveEmbeddedAgentStream } from "../../agents/embedded-agent-runner/stream-resolution.js";
import { mapThinkingLevel } from "../../agents/embedded-agent-runner/utils.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
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
import { modelCatalogLogicalKey } from "../../agents/openai-model-routes.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../../agents/prepared-model-runtime.js";
import { projectProviderModelRouteConfig } from "../../agents/provider-model-route.js";
import { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import {
  prepareSimpleCompletionModel,
  type PreparedSimpleCompletionModel,
} from "../../agents/simple-completion-runtime.js";
import { normalizeUsage, hasObservedModelUsage } from "../../agents/usage.js";
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
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import {
  projectWorkerInferenceTerminalMessage,
  type WorkerInferenceModelIdentity,
} from "./inference-terminal-message.js";
import { createWorkerToolCallStream } from "./inference-tool-call-stream.js";
import { resolveWorkerSessionTarget, type ResolvedWorkerSessionTarget } from "./session-target.js";
import { boundedWorkerError } from "./worker-error.js";

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
  resolveSessionAuthSelection: typeof resolveSessionAuthSelection;
  resolveModel: typeof resolveModelAsync;
  prepareModel: typeof prepareSimpleCompletionModel;
  resolveProviderStream: typeof registerProviderStreamForModel;
  resolveStream: typeof resolveEmbeddedAgentStream;
  applyStreamPolicy: typeof applyExtraParamsToAgent;
  wrapStream: typeof wrapStreamFnWithDiagnosticModelCallEvents;
  createTrace: typeof createDiagnosticTraceContextFromActiveScope;
  recordUsage: (params: WorkerInferenceUsageParams) => void;
};

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
  message: string = ERROR_MESSAGES[reason],
): WorkerInferenceTerminalOutcome {
  return {
    type: "error",
    reason,
    message,
    ...(usage ? { usage: structuredClone(usage) } : {}),
  };
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
  if (!hasObservedModelUsage(usage)) {
    return;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = usage.total ?? promptTokens + output;
  const costUsd =
    usage.cost?.total ??
    estimateUsageCost({
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
  resolveSessionAuthSelection,
  resolveModel: resolveModelAsync,
  prepareModel: prepareSimpleCompletionModel,
  resolveProviderStream: registerProviderStreamForModel,
  resolveStream: resolveEmbeddedAgentStream,
  applyStreamPolicy: applyExtraParamsToAgent,
  wrapStream: wrapStreamFnWithDiagnosticModelCallEvents,
  createTrace: createDiagnosticTraceContextFromActiveScope,
  recordUsage: emitWorkerInferenceUsage,
};

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
      runtimeSnapshot: PreparedModelRuntimeSnapshot;
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
  });
  const runtimeSnapshot = runtimeLease.snapshot;
  try {
    return await withPluginRuntimeGenerationScope(runtimeSnapshot, async () => {
      const lifecycleConfig = runtimeSnapshot.config;
      const agentDir = runtimeSnapshot.agentDir;
      const workspaceDir =
        runtimeSnapshot.workspaceDir ?? resolveAgentWorkspaceDir(lifecycleConfig, target.agentId);
      const manifestSnapshot = runtimeSnapshot.metadataSnapshot;
      const defaultModel = dependencies.resolveDefaultModel({
        cfg: lifecycleConfig,
        agentId: target.agentId,
        manifestPlugins: manifestSnapshot,
        ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      });
      const aliasIndex = buildModelAliasIndex({
        cfg: lifecycleConfig,
        agentId: target.agentId,
        defaultProvider: defaultModel.provider,
        manifestPlugins: manifestSnapshot,
        ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      });
      const resolved = resolveModelRefFromString({
        cfg: lifecycleConfig,
        agentId: target.agentId,
        raw: rawRef,
        defaultProvider: defaultModel.provider,
        aliasIndex,
        manifestPlugins: manifestSnapshot,
        ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      });
      if (
        !resolved ||
        normalizeProviderId(resolved.ref.provider) !==
          normalizeProviderId(request.modelRef.provider)
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
        manifestPlugins: manifestSnapshot,
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
      const sessionSelection = await dependencies.resolveSessionAuthSelection({
        cfg: lifecycleConfig,
        provider: resolved.ref.provider,
        modelId: resolved.ref.model,
        ...(configuredDefaultProfile ? { configuredProfileId: configuredDefaultProfile } : {}),
        harnessRuntime: harnessPolicy.runtime,
        agentDir,
        sessionEntry: target.sessionEntry,
        sessionStore: target.sessionStore,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        isNewSession: false,
      });
      const selectedProfileId = sessionSelection?.profileId;
      const routeRequirement = sessionSelection?.routeRequirement;
      let modelConfig = lifecycleConfig;
      const routeResolution = routeRequirement
        ? resolveProviderModelRoutes({
            provider: resolved.ref.provider,
            modelId: resolved.ref.model,
            config: lifecycleConfig,
          })
        : undefined;
      const route =
        routeResolution?.kind === "routes"
          ? routeResolution.routes.find(
              (candidate) => candidate.authRequirement === routeRequirement,
            )
          : undefined;
      if (route) {
        // Worker placement owns the agent harness, while the gateway-owned profile
        // owns the provider route. Keep those decisions separate or OAuth can be
        // materialized as a public API-key endpoint and fail before the first token.
        modelConfig = projectProviderModelRouteConfig({
          provider: resolved.ref.provider,
          config: lifecycleConfig,
          route,
        });
      }
      // Route projection and credential selection are one decision. Pin even an
      // automatic profile so generic auth fallback cannot cross to another route.
      const prepared = await dependencies.prepareModel({
        cfg: modelConfig,
        agentId: target.agentId,
        provider: resolved.ref.provider,
        modelId: resolved.ref.model,
        agentDir,
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...(selectedProfileId ? { preferredProfile: selectedProfileId } : {}),
        ...(selectedProfileId ? { bindAuthOwner: true } : {}),
        allowMissingApiKeyModes: ["aws-sdk"],
        allowBundledStaticCatalogFallback: true,
        modelResolver: dependencies.resolveModel,
        preparedModelRuntime: runtimeSnapshot,
        workspaceDir,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
      });
      return {
        provider: resolved.ref.provider,
        model: resolved.ref.model,
        config: lifecycleConfig,
        agentDir,
        workspaceDir,
        prepared,
        runtimeSnapshot,
        release: runtimeLease.release,
      };
    });
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
    return await withPluginRuntimeGenerationScope(approved.runtimeSnapshot, async () => {
      try {
        if ("error" in approved.prepared) {
          return inferenceError(
            "provider-error",
            undefined,
            boundedWorkerError(approved.prepared.error, 256),
          );
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
        const streamAgent = dependencies.resolveStream({
          llmRuntime,
          currentStreamFn: llmRuntime.streamSimple,
          ...(providerStream ? { providerStreamFn: providerStream } : {}),
          sessionId: request.sessionId,
          signal,
          model: providerModel,
          resolvedApiKey: authValue,
          authProfileId: approved.prepared.auth.profileId,
        });
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
          nextCallId: () =>
            `${request.runId}:${request.turnId}:worker-model:${(modelCallSeq += 1)}`,
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
              const terminal = projectWorkerInferenceTerminalMessage({
                message: event.message,
                modelIdentity,
                stopReason: event.reason,
              });
              if (terminal.kind === "provider-replay-unavailable") {
                if (isDiagnosticsEnabled(approved.config)) {
                  const { bytes, limitBytes, reason } = terminal.details;
                  emitTrustedDiagnosticEvent({
                    type: "payload.large",
                    surface: "worker.provider-replay",
                    action: "rejected",
                    bytes,
                    limitBytes,
                    reason,
                    trace: freezeDiagnosticTraceContext(trace),
                  });
                }
                return inferenceError(
                  "provider-error",
                  event.message.usage,
                  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
                );
              }
              return { type: "done", message: terminal.message };
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
    });
  };
}

export const executeWorkerInference: WorkerInferenceExecutor = createWorkerInferenceExecutor();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
