// Opencode Go stream termination wrapper aborts stalled OpenAI-compatible
// SSE streams at the provider-owned raw boundary, before the shared runtime
// stuck-session recovery kicks in.
import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

interface OpencodeGoStalledStreamWrapperOptions {
  /**
   * Provider id this wrapper applies to. Calls whose model.provider does not
   * match are forwarded untouched so the wrapper stays provider-scoped.
   */
  provider: string;
  /**
   * Maximum idle window between two stream events before the wrapper treats
   * the underlying SSE as stalled and aborts it. Must be > 0.
   */
  idleTimeoutMs: number;
  /**
   * Maximum window for stream creation and first event delivery. Must be > 0.
   */
  firstEventTimeoutMs?: number;
}

/**
 * Default idle window used in production. Matches the runtime's shared
 * `DEFAULT_LLM_IDLE_TIMEOUT_MS` (120s) so non-cron interactive runs see
 * no behavior change versus the existing watchdog, while cron runs — for
 * which the runtime disables its idle watchdog entirely
 * (`resolveLlmIdleTimeoutMs` returns 0 when `trigger === "cron"` and no
 * explicit timeout is set) — finally get a provider-owned termination
 * well before the ~622s stuck-session recovery kicks in.
 */
export const OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT = 120_000;

export const OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT = 300_000;

function isOpencodeGoModel(model: unknown, providerId: string): boolean {
  return Boolean(model) && typeof model === "object"
    ? (model as { provider?: unknown }).provider === providerId
    : false;
}

function validTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveTimeoutMs(model: unknown, fallbackMs: number): number {
  return validTimeoutMs((model as { requestTimeoutMs?: unknown })?.requestTimeoutMs) ?? fallbackMs;
}

function isProviderProgressEvent(event: AssistantMessageEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_end"
  );
}

function combineAbortSignals(signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const [firstSignal] = present;
  if (!firstSignal) {
    return { signal: new AbortController().signal, cleanup: () => undefined };
  }
  if (present.length === 1) {
    return { signal: firstSignal, cleanup: () => undefined };
  }
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") {
    return { signal: anyFn(present), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const alreadyAborted = present.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort((alreadyAborted as { reason?: unknown }).reason);
    return { signal: controller.signal, cleanup: () => undefined };
  }
  const unsubscribe: Array<() => void> = [];
  for (const signal of present) {
    const onAbort = () => controller.abort((signal as { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const remove of unsubscribe) {
        remove();
      }
      unsubscribe.length = 0;
    },
  };
}

const STALLED_STREAM_ERROR_MESSAGE =
  "opencode-go stream timed out after provider-owned SSE boundary stalled";

function buildStalledErrorEvent(partial: AssistantMessage | undefined): AssistantMessageEvent {
  if (partial) {
    return {
      type: "error",
      reason: "error",
      error: {
        ...partial,
        stopReason: "error",
        errorMessage: STALLED_STREAM_ERROR_MESSAGE,
      },
    };
  }
  return {
    type: "error",
    reason: "error",
    error: synthesizeMinimalAssistantMessage(STALLED_STREAM_ERROR_MESSAGE, "error"),
  };
}

function buildUnterminatedErrorEvent(partial: AssistantMessage | undefined): AssistantMessageEvent {
  if (partial) {
    return {
      type: "error",
      reason: "error",
      error: {
        ...partial,
        stopReason: "error",
        errorMessage: "opencode-go stream ended without a terminal event",
      },
    };
  }
  return {
    type: "error",
    reason: "error",
    error: synthesizeMinimalAssistantMessage(
      "opencode-go stream ended without a terminal event",
      "error",
    ),
  };
}

function buildCaughtErrorEvent(
  partial: AssistantMessage | undefined,
  error: unknown,
): AssistantMessageEvent {
  const message = error instanceof Error ? error.message : String(error);
  if (partial) {
    return {
      type: "error",
      reason: "error",
      error: {
        ...partial,
        stopReason: "error",
        errorMessage: message,
      },
    };
  }
  return {
    type: "error",
    reason: "error",
    error: synthesizeMinimalAssistantMessage(message, "error"),
  };
}

function synthesizeMinimalAssistantMessage(
  errorMessage: string,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "opencode-go",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/**
 * Wraps an opencode-go provider stream function so that an SSE socket that
 * fails to deliver a first event or stops producing progress is aborted at the
 * provider-owned raw boundary via the injected AbortSignal, instead of waiting
 * for the much later shared runtime stuck-session recovery.
 *
 * Behavior:
 * - Provider-scoped: only applies when `model.provider === options.provider`.
 * - Idle-based: the timer covers stream creation, first event delivery, and
 *   every gap after provider progress begins; if no event arrives within
 *   `idleTimeoutMs`, the wrapper calls `controller.abort()` on the AbortSignal
 *   injected into the underlying call (so the OpenAI SDK request is genuinely
 *   interrupted, not just the iterator) and pushes a terminal `error` event
 *   downstream.
 * - Terminal-safe: when the underlying stream emits `done` or `error`, the
 *   wrapper forwards the event, clears all timers, and ends the stream.
 *
 * The wrapper never shortens the natural end of a normal completion, because
 * provider progress refreshes the idle timer and a terminal event cancels it entirely.
 */
export function createOpencodeGoStalledStreamWrapper(
  underlying: ProviderStreamFn,
  options: OpencodeGoStalledStreamWrapperOptions,
): ProviderStreamFn {
  if (!options || options.idleTimeoutMs <= 0) {
    throw new Error("createOpencodeGoStalledStreamWrapper requires idleTimeoutMs > 0");
  }
  if (options.firstEventTimeoutMs !== undefined && options.firstEventTimeoutMs <= 0) {
    throw new Error("createOpencodeGoStalledStreamWrapper requires firstEventTimeoutMs > 0");
  }
  const providerId = options.provider;
  const idleTimeoutMsDefault = options.idleTimeoutMs;
  const firstEventTimeoutMsDefault = options.firstEventTimeoutMs ?? options.idleTimeoutMs;

  return (model, context, callOptions) => {
    if (!isOpencodeGoModel(model, providerId)) {
      return underlying(model, context, callOptions);
    }

    const output = createAssistantMessageEventStream();
    const idleTimeoutMs = resolveTimeoutMs(model, idleTimeoutMsDefault);
    const firstEventTimeoutMs = resolveTimeoutMs(model, firstEventTimeoutMsDefault);
    const controller = new AbortController();
    const combinedSignal = combineAbortSignals([
      (callOptions as { signal?: AbortSignal } | undefined)?.signal,
      controller.signal,
    ]);
    const wrappedOptions = {
      ...callOptions,
      // This provider owns the raw SSE stall policy. Preserve that longer first
      // event window when delegating to OpenAI-compatible streams so the generic
      // embedded-runner default cannot shorten opencode-go prompt evaluation.
      firstEventTimeoutMs,
      signal: combinedSignal.signal,
    };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeenPartial: AssistantMessage | undefined;
    let settled = false;
    let baseIterator: AsyncIterator<AssistantMessageEvent> | undefined;

    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const cleanup = () => {
      clearIdleTimer();
      combinedSignal.cleanup();
    };

    const releaseBaseStream = () => {
      if (baseIterator?.return) {
        void Promise.resolve(baseIterator.return()).catch(() => undefined);
      }
    };

    const finishWith = (event: AssistantMessageEvent) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      output.push(event);
      output.end(
        event.type === "done" ? (event as { message: AssistantMessage }).message : undefined,
      );
    };

    const abortStalledStream = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
      controller.abort(new Error("opencode-go stream stalled"));
      combinedSignal.cleanup();
      releaseBaseStream();
      output.push(buildStalledErrorEvent(lastSeenPartial));
      output.end();
    };

    const armTimer = (timeoutMs: number) => {
      clearIdleTimer();
      idleTimer = setTimeout(abortStalledStream, timeoutMs);
      idleTimer.unref?.();
    };

    const armFirstEventTimer = () => armTimer(firstEventTimeoutMs);

    const armIdleTimer = () => armTimer(idleTimeoutMs);

    const trackPartial = (event: AssistantMessageEvent) => {
      const partial =
        (event as { partial?: AssistantMessage; message?: AssistantMessage }).partial ??
        (event as { message?: AssistantMessage }).message;
      if (partial) {
        lastSeenPartial = partial;
      }
    };

    const releaseResolvedStream = (baseStream: AsyncIterable<AssistantMessageEvent>) => {
      const iterator = baseStream[Symbol.asyncIterator]();
      if (iterator.return) {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      }
    };

    armFirstEventTimer();
    let baseStreamResult: ReturnType<ProviderStreamFn>;
    try {
      baseStreamResult = underlying(model, context, wrappedOptions);
    } catch (error) {
      cleanup();
      throw error;
    }

    void (async () => {
      try {
        const baseStream = await Promise.resolve(
          baseStreamResult as Awaited<ReturnType<ProviderStreamFn>>,
        );
        if (settled) {
          releaseResolvedStream(baseStream as AsyncIterable<AssistantMessageEvent>);
          return;
        }
        baseIterator = (baseStream as AsyncIterable<AssistantMessageEvent>)[Symbol.asyncIterator]();
        for (;;) {
          const result = await baseIterator.next();
          if (settled) {
            return;
          }
          if (result.done) {
            finishWith(buildUnterminatedErrorEvent(lastSeenPartial));
            return;
          }
          const event = result.value;
          if (event.type === "done" || event.type === "error") {
            trackPartial(event);
            finishWith(event);
            return;
          }
          trackPartial(event);
          output.push(event);
          if (isProviderProgressEvent(event)) {
            armIdleTimer();
          }
        }
      } catch (error) {
        if (!settled) {
          finishWith(buildCaughtErrorEvent(lastSeenPartial, error));
        }
      } finally {
        cleanup();
      }
    })();

    return output;
  };
}
