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
  observeSharedResult: (() => Promise<unknown>) | undefined,
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
    // A bare-EOF stream (no terminal done/error chunk) leaves terminalError unset.
    // When the stream exposes result(), the resolved/rejected result is the
    // authoritative terminal — observe it now so a rejected result() publishes
    // model.call.error instead of being deduped away by an early
    // model.call.completed. The shared observation is cached, so a consumer that
    // later calls result() reuses the same promise and the terminalEventEmitted
    // fence keeps it exactly-once. A terminalError already captured from a
    // streamed error event stays authoritative via emitCompleted. Consumers that
    // never call result() (e.g. worker inference) still get exactly one terminal
    // because the shared observer fires here. Iterator-only streams (no result())
    // have no later terminal signal, so they complete here as before.
    if (observeSharedResult) {
      if (lifecycle.observer.state.terminalError) {
        lifecycle.emitCompleted();
      } else {
        void observeSharedResult();
      }
    } else {
      lifecycle.emitCompleted();
    }
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
      // The consumer abandoned the iterator, so result() will not settle the
      // terminal; emit completion here to avoid leaving the call without one.
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

function createSharedResultObserver(
  stream: unknown,
  lifecycle: ModelCallLifecycle,
): (() => Promise<unknown>) | undefined {
  if (!isRecord(stream) || typeof stream.result !== "function") {
    return undefined;
  }
  const resultFn = stream.result as (...args: unknown[]) => unknown; // SAFETY: isRecord(stream) and typeof stream.result === "function" above narrow the unknown result to a callable signature; no further structural claim.
  // Cache the underlying result() promise so iterator-done and consumer-side
  // result() calls share one observation; terminalEventEmitted keeps the
  // terminal exactly-once. The pre-attached catch keeps iterator-only observers
  // (which never await the returned promise) free of unhandled rejections.
  let cached: Promise<unknown> | undefined;
  return () => {
    if (!cached) {
      cached = Promise.resolve()
        .then(() => resultFn.call(stream))
        .then(
          (resolved) => observeModelCallFinalResult(resolved, lifecycle),
          (err: unknown) => {
            lifecycle.emitError(err);
            throw err;
          },
        );
      cached.catch(() => undefined);
    }
    return cached;
  };
}

function createObservedResultFunction(
  observeSharedResult: () => Promise<unknown>,
  stream: unknown,
): (...args: unknown[]) => unknown {
  // The consumer-facing result() forwards to the shared observer so the
  // terminal is settled by whichever fires first: iterator natural done or
  // an explicit result() call. result() is a no-arg stream contract; the shared
  // cache serves the no-arg path. A caller passing arguments (not part of the
  // contract) falls through to the underlying function without caching.
  const resultFn =
    isRecord(stream) && typeof stream.result === "function"
      ? (stream.result as (...args: unknown[]) => unknown) // SAFETY: the conjunction above narrows stream.result to a function; the (...args) => unknown signature makes no further structural claim.
      : undefined;
  return (...args: unknown[]) => {
    if (args.length > 0 && resultFn) {
      return resultFn.apply(stream, args);
    }
    return observeSharedResult();
  };
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  lifecycle: ModelCallLifecycle,
): T {
  const observeSharedResult = createSharedResultObserver(stream, lifecycle);
  const observedResult = observeSharedResult
    ? createObservedResultFunction(observeSharedResult, stream)
    : undefined;
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), lifecycle, observeSharedResult)[
      Symbol.asyncIterator
    ]();
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
