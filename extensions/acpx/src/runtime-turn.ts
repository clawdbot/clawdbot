import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "../runtime-api.js";

function createDeferredResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class LegacyRunTurnEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private readonly waits: Array<{
    resolve: (value: AcpRuntimeEvent | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(item: AcpRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  clear(): void {
    this.items.length = 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.resolve(null);
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.error = error;
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.reject(error);
    }
  }

  private async next(): Promise<AcpRuntimeEvent | null> {
    const item = this.items.shift();
    if (item) {
      return item;
    }
    if (this.error) {
      throw toLintErrorObject(this.error, "Non-Error thrown");
    }
    if (this.closed) {
      return null;
    }
    return await new Promise<AcpRuntimeEvent | null>((resolve, reject) => {
      this.waits.push({ resolve, reject });
    });
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    for (;;) {
      const item = await this.next();
      if (!item) {
        return;
      }
      yield item;
    }
  }
}

function legacyRunTurnAsStartTurn(runtime: AcpRuntime, input: AcpRuntimeTurnInput): AcpRuntimeTurn {
  const result = createDeferredResult<AcpRuntimeTurnResult>();
  result.promise.catch(() => {});
  const queue = new LegacyRunTurnEventQueue();
  let resultSettled = false;
  const settleResult = (next: AcpRuntimeTurnResult) => {
    if (resultSettled) {
      return;
    }
    resultSettled = true;
    result.resolve(next);
  };
  void (async () => {
    try {
      for await (const event of runtime.runTurn(input)) {
        if (event.type === "done") {
          settleResult({
            status: "completed",
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          });
          continue;
        }
        if (event.type === "error") {
          settleResult({
            status: "failed",
            error: {
              message: event.message,
              ...(event.code ? { code: event.code } : {}),
              ...(event.detailCode ? { detailCode: event.detailCode } : {}),
              ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
            },
          });
          continue;
        }
        queue.push(event);
      }
      settleResult({
        status: "failed",
        error: {
          code: "ACP_TURN_FAILED",
          message: "ACP turn ended without a terminal done event.",
        },
      });
    } catch (error) {
      result.reject(error);
      queue.fail(error);
      return;
    }
    queue.close();
  })();
  return {
    requestId: input.requestId,
    events: queue.iterate(),
    result: result.promise,
    async cancel(inputArgs) {
      await runtime.cancel({ handle: input.handle, reason: inputArgs?.reason });
    },
    async closeStream() {
      queue.clear();
      queue.close();
    },
  };
}

export function startRuntimeTurn(runtime: AcpRuntime, input: AcpRuntimeTurnInput): AcpRuntimeTurn {
  return runtime.startTurn?.(input) ?? legacyRunTurnAsStartTurn(runtime, input);
}

export function lazyStartRuntimeTurn(
  resolveRuntime: () => Promise<AcpRuntime>,
  input: AcpRuntimeTurnInput,
): AcpRuntimeTurn {
  const turnPromise = resolveRuntime().then((runtime) => startRuntimeTurn(runtime, input));
  return {
    requestId: input.requestId,
    events: {
      async *[Symbol.asyncIterator]() {
        yield* (await turnPromise).events;
      },
    },
    result: turnPromise.then((turn) => turn.result),
    cancel(inputArgs) {
      return turnPromise.then((turn) => turn.cancel(inputArgs));
    },
    closeStream(inputArgs) {
      return turnPromise.then((turn) => turn.closeStream(inputArgs));
    },
  };
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
