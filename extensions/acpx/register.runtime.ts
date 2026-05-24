import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnInput,
  type AcpRuntimeTurnResult,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";

const ACPX_BACKEND_ID = "acpx";

type RealAcpxServiceModule = typeof import("./src/service.js");
type CreateAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  params: CreateAcpxRuntimeServiceParams;
  realRuntime: AcpRuntime | null;
  realService: OpenClawPluginService | null;
  startPromise: Promise<AcpRuntime> | null;
};

let serviceModulePromise: Promise<RealAcpxServiceModule> | null = null;

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
      throw this.error;
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

function loadServiceModule(): Promise<RealAcpxServiceModule> {
  serviceModulePromise ??= import("./src/service.js");
  return serviceModulePromise;
}

async function startRealService(state: DeferredServiceState): Promise<AcpRuntime> {
  if (state.realRuntime) {
    return state.realRuntime;
  }
  if (!state.ctx) {
    throw new Error("ACPX runtime service is not started");
  }
  state.startPromise ??= (async () => {
    const { createAcpxRuntimeService } = await loadServiceModule();
    const service = createAcpxRuntimeService(state.params);
    state.realService = service;
    await service.start(state.ctx as OpenClawPluginServiceContext);
    const backend = getAcpRuntimeBackend(ACPX_BACKEND_ID);
    if (!backend?.runtime) {
      throw new Error("ACPX runtime service did not register an ACP backend");
    }
    state.realRuntime = backend.runtime;
    return state.realRuntime;
  })();
  try {
    return await state.startPromise;
  } catch (error) {
    state.startPromise = null;
    state.realService = null;
    throw error;
  }
}

function lazyStartTurn(
  resolveRuntime: () => Promise<AcpRuntime>,
  input: AcpRuntimeTurnInput,
): AcpRuntimeTurn {
  const turnPromise: Promise<AcpRuntimeTurn> = resolveRuntime().then((runtime) => {
    if (runtime.startTurn) {
      return runtime.startTurn(input);
    }
    return legacyRunTurnAsStartTurn(runtime, input);
  });
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

function createDeferredRuntime(state: DeferredServiceState): AcpRuntime {
  const resolveRuntime = () => startRealService(state);
  return {
    async ensureSession(input) {
      return await (await resolveRuntime()).ensureSession(input);
    },
    startTurn(input) {
      return lazyStartTurn(resolveRuntime, input);
    },
    async *runTurn(input) {
      yield* (await resolveRuntime()).runTurn(input);
    },
    async getCapabilities(input) {
      return (await (await resolveRuntime()).getCapabilities?.(input)) ?? { controls: [] };
    },
    async getStatus(input) {
      return (await (await resolveRuntime()).getStatus?.(input)) ?? {};
    },
    async setMode(input) {
      await (await resolveRuntime()).setMode?.(input);
    },
    async setConfigOption(input) {
      await (await resolveRuntime()).setConfigOption?.(input);
    },
    async doctor() {
      return (await (await resolveRuntime()).doctor?.()) ?? { ok: true, message: "ok" };
    },
    async prepareFreshSession(input) {
      await (await resolveRuntime()).prepareFreshSession?.(input);
    },
    async cancel(input) {
      await (await resolveRuntime()).cancel(input);
    },
    async close(input) {
      await (await resolveRuntime()).close(input);
    },
  };
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  const state: DeferredServiceState = {
    ctx: null,
    params,
    realRuntime: null,
    realService: null,
    startPromise: null,
  };

  return {
    id: "acpx-runtime",
    async start(ctx) {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }

      state.ctx = ctx;
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: createDeferredRuntime(state),
      });
      ctx.logger.info("embedded acpx runtime backend registered lazily");
    },
    async stop(ctx) {
      if (state.realService) {
        await state.realService.stop?.(ctx);
      } else {
        unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      }
      state.ctx = null;
      state.realRuntime = null;
      state.realService = null;
      state.startPromise = null;
    },
  };
}
