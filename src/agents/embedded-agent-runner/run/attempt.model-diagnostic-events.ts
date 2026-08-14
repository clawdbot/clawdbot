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
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        iteratorSettled = true;
        break;
      }
      lifecycle.observer.observeResponseChunk(lifecycle.startedAt, next.value);
      lifecycle.observer.maybeEmitStreamProgress(lifecycle.eventBase);
      yield next.value;
    }
    lifecycle.emitCompleted();
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
      // event; emitModelCallCompleted self-dedupes via state.terminalEventEmitted.
      await safeReturnIterator(iterator);
      lifecycle.emitCompleted();
    }
  }
}

function observeModelCallFinalResult<T>(result: T, lifecycle: ModelCallLifecycle): T {
  lifecycle.observer.observeFinalResult(lifecycle.eventBase, lifecycle.startedAt, result);
  lifecycle.emitCompleted();
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
  lifecycle.emitCompleted();
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
    const configuredRequestTimeoutMs = isRecord(model) ? model.requestTimeoutMs : undefined;
    const requestTimeoutMs =
      typeof configuredRequestTimeoutMs === "number" &&
      Number.isFinite(configuredRequestTimeoutMs) &&
      configuredRequestTimeoutMs > 0
        ? configuredRequestTimeoutMs
        : undefined;
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
