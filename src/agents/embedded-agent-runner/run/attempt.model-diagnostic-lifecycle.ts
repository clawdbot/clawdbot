import { withProviderAcceptanceObserver, type ProviderAcceptance } from "@openclaw/ai/transports";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticHttpStatusCode,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  areDiagnosticsEnabledForProcess,
  type DiagnosticEventInput,
  type DiagnosticModelCallContent,
  type DiagnosticMemoryUsage,
} from "../../../infra/diagnostic-events.js";
import type { DiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import type { CoreModelRequestOwnerGeneration } from "../../../infra/diagnostic-model-request-provenance.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../../../infra/diagnostic-model-request.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { formatPropagatedDiagnosticTraceparent } from "../../../infra/diagnostic-trace-propagation.js";
import { emitDiagnosticsTimelineEvent } from "../../../infra/diagnostics-timeline.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookContextWindowSource,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";
import type { StreamFn } from "../../runtime/index.js";

export type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
  trace: DiagnosticTraceContext;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  nextCallId: () => string;
  ownerGeneration?: CoreModelRequestOwnerGeneration;
  onStarted?: () => void;
  onTerminal?: () => void;
  onSucceeded?: (startedAt: number) => void;
  suppressPluginHooks?: boolean;
  requestTimeoutMs?: number;
};

export type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "failureKind" | "memory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Pick<
  PluginHookModelCallEndedEvent,
  | "durationMs"
  | "outcome"
  | "errorCategory"
  | "requestPayloadBytes"
  | "responseStreamBytes"
  | "timeToFirstByteMs"
  | "failureKind"
  | "upstreamRequestIdHash"
>;
export type ModelCallSizeTimingFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>,
  "requestPayloadBytes" | "responseStreamBytes" | "timeToFirstByteMs"
>;
export type ModelCallPromptStats = NonNullable<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>["promptStats"]
>;
export type ModelCallUsage = NonNullable<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>["usage"]
>;
export type ModelCallObservationState = {
  requestPayloadBytes?: number;
  providerAcceptanceKind?: ProviderAcceptance["kind"];
  responseStatus?: number;
  responseStreamBytes: number;
  timeToFirstByteMs?: number;
  modelContent?: DiagnosticModelCallContent;
  outputMessages?: unknown[];
  usage?: ModelCallUsage;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  semanticProgressEmitted?: boolean;
  terminalEventEmitted?: boolean;
  terminalError?: Error;
  terminalSucceeded?: boolean;
  suppressPluginHooks?: boolean;
};
export type ModelCallObserver = {
  state: ModelCallObservationState;
  promptStats?: ModelCallPromptStats;
  modelContent?: DiagnosticModelCallContent;
  assignRequestPayloadBytes: (payload: unknown) => void;
  observeResponseChunk: (startedAt: number, chunk: unknown) => void;
  observeFinalResult: (eventBase: ModelCallEventBase, startedAt: number, result: unknown) => void;
  maybeEmitStreamProgress: (eventBase: ModelCallEventBase) => void;
  sizeTimingFields: () => ModelCallSizeTimingFields;
  completedContent: () => DiagnosticModelCallContent | undefined;
  usageField: () => { usage?: ModelCallUsage };
};

const TRACEPARENT_HEADER_NAME = "traceparent";
const TIMELINE_ATTRIBUTE_MAX_LENGTH = 256;
type ModelCallStreamOptions = Parameters<StreamFn>[2];

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
  promptStats: ModelCallPromptStats | undefined,
): ModelCallEventBase {
  return {
    runId: ctx.runId,
    callId,
    ...(ctx.sessionKey && { sessionKey: ctx.sessionKey }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    provider: ctx.provider,
    model: ctx.model,
    ...(ctx.api && { api: ctx.api }),
    ...(ctx.transport && { transport: ctx.transport }),
    observationUnit: "request",
    ...(ctx.contextTokenBudget ? { contextTokenBudget: ctx.contextTokenBudget } : {}),
    ...(ctx.contextWindowSource ? { contextWindowSource: ctx.contextWindowSource } : {}),
    ...(ctx.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: ctx.contextWindowReferenceTokens }
      : {}),
    ...(promptStats ? { promptStats } : {}),
    trace,
  };
}

function modelContentPrivateData(modelContent: DiagnosticModelCallContent | undefined) {
  return modelContent ? { modelContent } : undefined;
}

function boundedTimelineAttribute(value: string | undefined): string | undefined {
  return truncateUtf16Safe(value?.trim() ?? "", TIMELINE_ATTRIBUTE_MAX_LENGTH) || undefined;
}

function emitProviderRequestTimelineEvent(
  eventBase: ModelCallEventBase,
  startedAt: number,
  durationMs: number,
  ok: boolean,
  responseStatus: number | undefined,
  providerAcceptanceKind: ModelCallObservationState["providerAcceptanceKind"],
): void {
  const provider = boundedTimelineAttribute(eventBase.provider);
  const model = boundedTimelineAttribute(eventBase.model);
  const api = boundedTimelineAttribute(eventBase.api);
  const transport = boundedTimelineAttribute(eventBase.transport);
  emitDiagnosticsTimelineEvent({
    type: "provider.request",
    name: "provider.request",
    timestamp: new Date(startedAt).toISOString(),
    runId: eventBase.runId,
    spanId: eventBase.callId,
    durationMs,
    provider,
    operation: api ?? transport ?? "model.call",
    ok,
    ...(responseStatus !== undefined ? { status: responseStatus } : {}),
    attributes: {
      ...(model ? { model } : {}),
      ...(api ? { api } : {}),
      ...(transport ? { transport } : {}),
      providerAccepted: providerAcceptanceKind !== undefined,
      ...(providerAcceptanceKind ? { providerAcceptanceKind } : {}),
    },
  });
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  const failureKind = diagnosticErrorFailureKind(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {}),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

function modelCallHookEventBase(eventBase: ModelCallEventBase): PluginHookModelCallStartedEvent {
  return {
    runId: eventBase.runId,
    callId: eventBase.callId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    provider: eventBase.provider,
    model: eventBase.model,
    ...(eventBase.api ? { api: eventBase.api } : {}),
    ...(eventBase.transport ? { transport: eventBase.transport } : {}),
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  };
}

function modelCallHookContext(eventBase: ModelCallEventBase): PluginHookAgentContext {
  return Object.freeze({
    runId: eventBase.runId,
    trace: eventBase.trace,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    modelProviderId: eventBase.provider,
    modelId: eventBase.model,
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  }) as PluginHookAgentContext;
}

function dispatchModelCallStartedHook(eventBase: ModelCallEventBase): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_started")) {
    return;
  }
  const event = Object.freeze(modelCallHookEventBase(eventBase)) as PluginHookModelCallStartedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallStarted(event, hookCtx),
    "model_call_started plugin hook failed",
  );
}

function dispatchModelCallEndedHook(
  eventBase: ModelCallEventBase,
  fields: ModelCallEndedHookFields,
): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_ended")) {
    return;
  }
  const event = Object.freeze({
    ...modelCallHookEventBase(eventBase),
    ...fields,
  }) as PluginHookModelCallEndedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallEnded(event, hookCtx),
    "model_call_ended plugin hook failed",
  );
}

function emitModelCallEnded(
  eventBase: ModelCallEventBase,
  startedAt: number,
  observer: ModelCallObserver,
  failure: { error: unknown } | undefined,
  ownerGeneration: CoreModelRequestOwnerGeneration | undefined,
): void {
  if (observer.state.terminalEventEmitted) {
    return;
  }
  observer.state.terminalEventEmitted = true;
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = observer.sizeTimingFields();
  const fields = failure ? modelCallErrorFields(failure.error) : undefined;
  const terminal = fields
    ? { type: "model.call.error" as const, ...fields }
    : { type: "model.call.completed" as const };
  const errorStatus = failure ? diagnosticHttpStatusCode(failure.error) : undefined;
  const responseStatus =
    observer.state.responseStatus ?? (errorStatus === undefined ? undefined : Number(errorStatus));
  emitProviderRequestTimelineEvent(
    eventBase,
    startedAt,
    durationMs,
    failure === undefined,
    responseStatus,
    observer.state.providerAcceptanceKind,
  );
  emitCoreModelRequestEndedDiagnosticEvent(
    {
      ...terminal,
      ...eventBase,
      durationMs,
      ...sizeTimingFields,
      ...observer.usageField(),
    },
    ownerGeneration,
    modelContentPrivateData(observer.completedContent()),
  );
  if (!observer.state.suppressPluginHooks) {
    dispatchModelCallEndedHook(eventBase, {
      durationMs,
      outcome: failure ? "error" : "completed",
      ...sizeTimingFields,
      ...fields,
    });
  }
}

function withDiagnosticRequestContext(
  options: ModelCallStreamOptions,
  trace: DiagnosticTraceContext,
  observer: ModelCallObserver,
  callId: string,
): ModelCallStreamOptions {
  const traceparent = formatPropagatedDiagnosticTraceparent(trace);
  const originalOnPayload = options?.onPayload;
  const originalOnResponse = options?.onResponse;
  const onPayload: NonNullable<ModelCallStreamOptions>["onPayload"] = (payload, model) => {
    if (!originalOnPayload) {
      observer.assignRequestPayloadBytes(payload);
      return undefined;
    }
    const result = originalOnPayload(payload, model);
    if (isPromiseLike(result)) {
      return result.then((replacement) => {
        observer.assignRequestPayloadBytes(replacement ?? payload);
        return replacement;
      });
    }
    observer.assignRequestPayloadBytes(result ?? payload);
    return result;
  };
  const onResponse: NonNullable<ModelCallStreamOptions>["onResponse"] = (response, model) => {
    // Retrying providers can expose several responses; the terminal request status
    // is the latest response observed before the model call completes or fails.
    observer.state.responseStatus = response.status;
    return originalOnResponse?.(response, model);
  };

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  if (traceparent) {
    headers[TRACEPARENT_HEADER_NAME] = traceparent;
  }
  const requestOptions = {
    ...options,
    requestId: callId,
    ...((options?.headers || traceparent) && { headers }),
    onPayload,
    onResponse,
  };
  return withProviderAcceptanceObserver(requestOptions, (acceptance) => {
    observer.state.providerAcceptanceKind = acceptance.kind;
    if (acceptance.kind === "http_response") {
      observer.state.responseStatus = acceptance.status;
    }
  });
}

export function createModelLifecycle(params: {
  ctx: ModelCallDiagnosticContext;
  options: ModelCallStreamOptions;
  requestTimeoutMs?: number;
  createObserver: (capturePromptStats: boolean) => ModelCallObserver;
}) {
  const callId = params.ctx.nextCallId();
  const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(params.ctx.trace));
  const observer = params.createObserver(areDiagnosticsEnabledForProcess());
  const eventBase = baseModelCallEvent(params.ctx, callId, trace, observer.promptStats);
  emitCoreModelRequestStartedDiagnosticEvent(
    eventBase,
    params.ctx.ownerGeneration,
    params.requestTimeoutMs,
    modelContentPrivateData(observer.modelContent),
  );
  if (params.ctx.suppressPluginHooks !== true) {
    dispatchModelCallStartedHook(eventBase);
  }
  params.ctx.onStarted?.();
  const startedAt = Date.now();
  const propagatedOptions = withDiagnosticRequestContext(params.options, trace, observer, callId);
  let terminalNotified = false;
  return {
    eventBase,
    observer,
    propagatedOptions,
    startedAt,
    emitCompleted() {
      // Iterator exhaustion can emit diagnostics before result() supplies the terminal response.
      if (!terminalNotified && (observer.state.terminalSucceeded || observer.state.terminalError)) {
        terminalNotified = true;
        params.ctx.onTerminal?.();
        if (observer.state.terminalSucceeded && !observer.state.terminalError) {
          params.ctx.onSucceeded?.(startedAt);
        }
      }
      emitModelCallEnded(
        eventBase,
        startedAt,
        observer,
        observer.state.terminalError ? { error: observer.state.terminalError } : undefined,
        params.ctx.ownerGeneration,
      );
    },
    emitError(err: unknown) {
      emitModelCallEnded(
        eventBase,
        startedAt,
        observer,
        { error: err },
        params.ctx.ownerGeneration,
      );
    },
  };
}

export type ModelCallLifecycle = ReturnType<typeof createModelLifecycle>;
