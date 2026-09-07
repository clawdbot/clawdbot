import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Emits diagnostic model-call events around embedded-agent stream functions.
 */
import type { StreamFn } from "../../runtime/index.js";
import {
  createModelLifecycle,
  type ModelCallDiagnosticContext,
  type ModelCallLifecycle,
} from "./attempt.model-diagnostic-lifecycle.js";
import { createModelObserver } from "./attempt.model-diagnostic-observation.js";

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
const ASSISTANT_TERMINAL_ERROR_REASONS = new Set(["error", "aborted"]);

/** Classifies an assistant event as a terminal error rather than a successful close. */
function isAssistantTerminalErrorEvent(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "error") {
    return false;
  }
  const reason = value.reason;
  if (typeof reason === "string" && ASSISTANT_TERMINAL_ERROR_REASONS.has(reason)) {
    return true;
  }
  // Provider streams that surface only an `errorMessage` field on `error` events
  // still represent a terminal failure even when the reason label is missing.
  return typeof value.errorMessage === "string";
}

/** Classifies a resolved assistant result message as a terminal failure. */
function isAssistantErrorResult(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }
  const stopReason = result.stopReason;
  if (typeof stopReason === "string" && ASSISTANT_TERMINAL_ERROR_REASONS.has(stopReason)) {
    return true;
  }
  return typeof result.errorMessage === "string";
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
    // Early consumer return should not hang diagnostic completion forever; give
    // provider cleanup a short chance, then emit completion for the observed call.
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
  lifecycle: ModelCallLifecycle,
): AsyncIterable<T> {
  // Tracks whether the underlying iterator terminated on its own (done or threw).
  // This is independent of state.terminalEventEmitted: result() can emit the
  // terminal event first, but the abandoned iterator still needs return() cleanup.
  let iteratorSettled = false;
  // Provider-declared `{type:"error"}` events are the authoritative terminal
  // signal for failure. We track them separately so the next iterator close
  // publishes `model.call.error` rather than `model.call.completed` even when
  // the provider also calls `iterator.return()` before the consumer reads it.
  let sawTerminalError = false;
  // A provider-declared `{type:"done"}` event is the authoritative successful
  // terminal. A bare iterator close (no `done` and no `error`) defers to the
  // exposed `result()` promise so a truncated or rejected result still
  // publishes a truthful terminal event through the result observer.
  let sawTerminalDone = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        iteratorSettled = true;
        break;
      }
      if (isAssistantTerminalErrorEvent(next.value)) {
        sawTerminalError = true;
      } else if (isRecord(next.value) && next.value.type === "done") {
        sawTerminalDone = true;
      }
      lifecycle.observer.observeResponseChunk(lifecycle.startedAt, next.value);
      lifecycle.observer.maybeEmitStreamProgress(lifecycle.eventBase);
      yield next.value;
    }
    if (sawTerminalError) {
      // Preserve a representative error object so the diagnostic event carries
      // the same provider message the consumer would have seen. The error
      // observer handles plain `Error` instances and records the message.
      lifecycle.emitError(new Error("Provider stream ended with a terminal error event"));
    } else if (sawTerminalDone) {
      lifecycle.emitCompleted();
    }
    // Bare EOF without `done` or `error`: let the result observer own the
    // terminal emission so a rejected result() still publishes model.call.error.
  } catch (err) {
    iteratorSettled = true;
    lifecycle.emitError(err);
    throw err;
  } finally {
    if (!iteratorSettled) {
      // A consumer can stop reading before the provider emits done/error — e.g.
      // the agent loop returns on the terminal event after awaiting result().
      // Close the underlying iterator for provider cleanup (idle-timeout abort
      // listeners, SSE readers) even when result() already emitted the terminal
      // event; lifecycle completion self-dedupes via state.terminalEventEmitted.
      await safeReturnIterator(iterator);
      if (sawTerminalError) {
        lifecycle.emitError(new Error("Provider stream ended with a terminal error event"));
      } else {
        // Consumer-returned-early is the conservative path. result() is still
        // wired and may publish the terminal if a caller later reads it; this
        // fallback only fires for the abandoned-without-result() case.
        lifecycle.emitCompleted();
      }
    }
  }
}

function observeModelCallFinalResult<T>(result: T, lifecycle: ModelCallLifecycle): T {
  lifecycle.observer.observeFinalResult(lifecycle.eventBase, lifecycle.startedAt, result);
  if (isAssistantErrorResult(result)) {
    // Reuse the resolved message as the error so plugin/timeline observers get
    // the same provider detail (errorMessage/errorCode/errorBody) they would
    // have received through the iterator path. emitError tolerates plain
    // objects alongside Error instances.
    lifecycle.emitError(result);
  } else {
    lifecycle.emitCompleted();
  }
  return result;
}

function createObservedResultFunction(
  stream: unknown,
  lifecycle: ModelCallLifecycle,
): ((...args: unknown[]) => unknown) | undefined {
  if (!isRecord(stream) || typeof stream.result !== "function") {
    return undefined;
  }
  const resultFn = stream.result;
  return (...args: unknown[]) => {
    try {
      const result = resultFn.apply(stream, args);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallFinalResult(resolved, lifecycle),
          (err: unknown) => {
            lifecycle.emitError(err);
            throw err;
          },
        );
      }
      return observeModelCallFinalResult(result, lifecycle);
    } catch (err) {
      lifecycle.emitError(err);
      throw err;
    }
  };
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  lifecycle: ModelCallLifecycle,
): T {
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), lifecycle)[Symbol.asyncIterator]();
  const observedResult = createObservedResultFunction(stream, lifecycle);
  let hasNonConfigurableIterator;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
      ...(observedResult ? { result: observedResult } : {}),
    } as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      if (property === "result" && observedResult) {
        return observedResult;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(result: unknown, lifecycle: ModelCallLifecycle): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(result as AsyncIterable<unknown>, createIterator, lifecycle);
  }
  if (isAssistantErrorResult(result)) {
    lifecycle.emitError(result);
  } else {
    lifecycle.emitCompleted();
  }
  return result;
}

/**
 * Wraps a model stream function with diagnostic model-call lifecycle events,
 * traceparent propagation, request/response byte accounting, optional captured
 * model content, progress heartbeats, and plugin hook dispatch.
 */
export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const requestTimeoutMs = clampPositiveTimerTimeoutMs(
      (isRecord(model) ? model.requestTimeoutMs : undefined) ?? ctx.requestTimeoutMs,
    );
    const lifecycle = createModelLifecycle({
      ctx,
      options,
      requestTimeoutMs,
      createObserver: (capturePromptStats) =>
        createModelObserver({
          streamContext,
          contentCapture: ctx.contentCapture,
          suppressPluginHooks: ctx.suppressPluginHooks,
          capturePromptStats,
        }),
    });

    try {
      const result = streamFn(model, streamContext, lifecycle.propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallResult(resolved, lifecycle),
          (err: unknown) => {
            lifecycle.emitError(err);
            throw err;
          },
        );
      }
      return observeModelCallResult(result, lifecycle);
    } catch (err) {
      lifecycle.emitError(err);
      throw err;
    }
  }) as StreamFn;
}
