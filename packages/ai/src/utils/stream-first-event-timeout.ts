import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

type StreamStage = "responses" | "completions";

export type FirstStreamEventTimeoutContext = {
  provider?: string;
  api?: string;
  model?: string;
  timeoutMs: number;
  stage?: StreamStage;
  hint?: string;
  abort?: (reason: Error) => void;
  onTimeout?: (reason: Error) => void;
};

export type FirstStreamEventInternalOptions = {
  firstEventTimeoutMs?: number;
  abortFirstEventStream?: (reason: Error) => void;
  onFirstEventTimeout?: (reason: Error) => void;
};

export type FirstStreamEventAbortController = {
  signal: AbortSignal;
  abort: (reason: Error) => void;
  dispose: () => void;
};

export function getFirstStreamEventTimeoutMs(options: unknown): number | undefined {
  return (options as FirstStreamEventInternalOptions | undefined)?.firstEventTimeoutMs;
}

export function getFirstStreamEventTimeoutHandler(
  options: unknown,
): ((reason: Error) => void) | undefined {
  return (options as FirstStreamEventInternalOptions | undefined)?.onFirstEventTimeout;
}

function formatOptionalField(name: string, value: string | undefined): string {
  return value ? ` ${name}=${value}` : "";
}

export function createFirstStreamEventTimeoutError(context: FirstStreamEventTimeoutContext): Error {
  const stage = context.stage ? `${context.stage} ` : "";
  const details = [
    formatOptionalField("provider", context.provider),
    formatOptionalField("api", context.api),
    formatOptionalField("model", context.model),
  ].join("");
  return new Error(
    `${stage}HTTP stream opened but did not deliver a first SSE event within ${context.timeoutMs}ms after streaming headers (first-event timeout).${details}` +
      (context.hint ? ` ${context.hint}` : ""),
  );
}

export function createFirstStreamEventAbortController(
  parentSignal?: AbortSignal,
): FirstStreamEventAbortController {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    abort(reason: Error) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose() {
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function withFirstStreamEventTimeout<T>(
  stream: AsyncIterable<T>,
  context: FirstStreamEventTimeoutContext,
): AsyncIterable<T> {
  const timeoutMs = clampTimerTimeoutMs(context.timeoutMs);
  if (timeoutMs === undefined || context.timeoutMs <= 0) {
    return stream;
  }
  const timeoutContext = { ...context, timeoutMs };
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      try {
        const first = await new Promise<IteratorResult<T>>((resolve, reject) => {
          timer = setTimeout(() => {
            const timeoutError = createFirstStreamEventTimeoutError(timeoutContext);
            timeoutContext.onTimeout?.(timeoutError);
            timeoutContext.abort?.(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
          timer.unref?.();
          iterator.next().then(resolve, reject);
        }).finally(clear);
        if (first.done) {
          completed = true;
          return;
        }
        yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            completed = true;
            return;
          }
          yield next.value;
        }
      } finally {
        clear();
        if (!completed) {
          void iterator.return?.().catch(() => undefined);
        }
      }
    },
  };
}
