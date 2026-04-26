import type { StreamFn } from "@mariozechner/pi-agent-core";
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import {
  diagnosticErrorCategory,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";

export { diagnosticErrorCategory };

type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  trace: DiagnosticTraceContext;
  nextCallId: () => string;
};

type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Pick<
  PluginHookModelCallEndedEvent,
  "durationMs" | "outcome" | "errorCategory" | "upstreamRequestIdHash"
>;

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
const TRACEPARENT_HEADER_NAME = "traceparent";
type ModelCallStreamOptions = Parameters<StreamFn>[2];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
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
    trace,
  };
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
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

function emitModelCallStarted(eventBase: ModelCallEventBase): void {
  emitTrustedDiagnosticEvent({
    type: "model.call.started",
    ...eventBase,
  });
  dispatchModelCallStartedHook(eventBase);
}

function emitModelCallCompleted(eventBase: ModelCallEventBase, startedAt: number): void {
  const durationMs = Date.now() - startedAt;
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...eventBase,
    durationMs,
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "completed",
  });
}

function emitModelCallError(
  eventBase: ModelCallEventBase,
  startedAt: number,
  fields: ModelCallErrorFields,
): void {
  const durationMs = Date.now() - startedAt;
  emitTrustedDiagnosticEvent({
    type: "model.call.error",
    ...eventBase,
    durationMs,
    ...fields,
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "error",
    ...fields,
  });
}

function withDiagnosticTraceparentHeader(
  options: ModelCallStreamOptions,
  trace: DiagnosticTraceContext,
): ModelCallStreamOptions {
  const traceparent = formatDiagnosticTraceparent(trace);
  if (!traceparent) {
    return options;
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  headers[TRACEPARENT_HEADER_NAME] = traceparent;
  return {
    ...options,
    headers,
  };
}

async function safeReturnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let returnResult: unknown;
  try {
    returnResult = iterator.return?.();
  } catch {
    return;
  }
  if (!returnResult) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
        const unref =
          typeof timeout === "object" && timeout
            ? (timeout as { unref?: () => void }).unref
            : undefined;
        if (unref) {
          unref.call(timeout);
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function* observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  eventBase: ModelCallEventBase,
  startedAt: number,
): AsyncIterable<T> {
  let terminalEmitted = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      yield next.value;
    }
    terminalEmitted = true;
    emitModelCallCompleted(eventBase, startedAt);
  } catch (err) {
    terminalEmitted = true;
    emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
    throw err;
  } finally {
    if (!terminalEmitted) {
      await safeReturnIterator(iterator);
      emitModelCallCompleted(eventBase, startedAt);
    }
  }
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  eventBase: ModelCallEventBase,
  startedAt: number,
): T {
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), eventBase, startedAt)[Symbol.asyncIterator]();
  let hasNonConfigurableIterator = false;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
    } as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(
  result: unknown,
  eventBase: ModelCallEventBase,
  startedAt: number,
): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(
      result as AsyncIterable<unknown>,
      createIterator,
      eventBase,
      startedAt,
    );
  }
  emitModelCallCompleted(eventBase, startedAt);
  return result;
}

export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const callId = ctx.nextCallId();
    const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
    const eventBase = baseModelCallEvent(ctx, callId, trace);
    emitModelCallStarted(eventBase);
    const startedAt = Date.now();
    const propagatedOptions = withDiagnosticTraceparentHeader(options, trace);

    try {
      const result = streamFn(model, streamContext, propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallResult(resolved, eventBase, startedAt),
          (err) => {
            emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
            throw err;
          },
        );
      }
      return observeModelCallResult(result, eventBase, startedAt);
    } catch (err) {
      emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
      throw err;
    }
  }) as StreamFn;
}
