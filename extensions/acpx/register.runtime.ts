/**
 * Lazy ACPX runtime service registration. The plugin exposes an ACP backend
 * immediately, then imports the heavier service only when a session needs it.
 */
import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createLazyAcpRuntimeProxy } from "./src/runtime-proxy.js";

const ACPX_BACKEND_ID = "acpx";

type RealAcpxServiceModule = typeof import("./src/service.js");
type InnerAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;
type CreateAcpxRuntimeServiceParams = Omit<InnerAcpxRuntimeServiceParams, "backendLifecycle">;

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  lifecycleRevision: number;
  ownedRuntime: AcpRuntime | null;
  params: CreateAcpxRuntimeServiceParams;
  realRuntime: AcpRuntime | null;
  realService: OpenClawPluginService | null;
  startPromise: Promise<AcpRuntime> | null;
  stopPromise: Promise<void> | null;
};

const loadServiceModule = createLazyRuntimeModule(() => import("./src/service.js"));

function unregisterOwnedRuntime(runtime: AcpRuntime | null): void {
  if (runtime && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime === runtime) {
    unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
  }
}

async function startRealService(
  state: DeferredServiceState,
  lifecycleRevision: number,
  deferredRuntime: AcpRuntime,
): Promise<AcpRuntime> {
  if (state.lifecycleRevision !== lifecycleRevision || !state.ctx) {
    throw new Error("ACPX runtime service is not started");
  }
  if (state.realRuntime) {
    return state.realRuntime;
  }
  if (state.startPromise) {
    return await state.startPromise;
  }
  const ctx = state.ctx;
  state.startPromise = (async () => {
    let publishedRuntime: AcpRuntime | null = null;
    const { createAcpxRuntimeService: createAcpxRuntimeServiceLocal } = await loadServiceModule();
    const service = createAcpxRuntimeServiceLocal({
      ...state.params,
      backendLifecycle: {
        publish(backend) {
          if (state.lifecycleRevision !== lifecycleRevision || state.ctx !== ctx) {
            throw new Error("ACPX runtime service stopped during activation");
          }
          if (getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== deferredRuntime) {
            throw new Error("ACPX runtime service lost registry ownership during activation");
          }
          // Publication is a synchronous compare-and-replace: another plugin
          // generation cannot be adopted between the ownership check and write.
          registerAcpRuntimeBackend({ id: ACPX_BACKEND_ID, ...backend });
          publishedRuntime = backend.runtime;
          state.ownedRuntime = backend.runtime;
        },
        retract(runtime) {
          unregisterOwnedRuntime(runtime);
        },
      },
    });
    state.realService = service;
    await service.start(ctx);
    if (state.lifecycleRevision !== lifecycleRevision || state.ctx !== ctx) {
      throw new Error("ACPX runtime service stopped during activation");
    }
    if (!publishedRuntime) {
      throw new Error("ACPX runtime service did not register an ACP backend");
    }
    if (getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== publishedRuntime) {
      throw new Error("ACPX runtime service lost registry ownership during activation");
    }
    // Registry publication intentionally precedes the startup probe, but callers
    // must keep sharing the start promise until the inner service is fully ready.
    state.realRuntime = publishedRuntime;
    return publishedRuntime;
  })();
  try {
    return await state.startPromise;
  } catch (error) {
    if (state.lifecycleRevision === lifecycleRevision) {
      state.startPromise = null;
      state.realService = null;
    }
    throw error;
  }
}

function createDeferredRuntime(state: DeferredServiceState, lifecycleRevision: number): AcpRuntime {
  const deferredRuntime: AcpRuntime = createLazyAcpRuntimeProxy(
    (): Promise<AcpRuntime> => startRealService(state, lifecycleRevision, deferredRuntime),
  );
  return deferredRuntime;
}

/** Creates the plugin service that registers ACPX as an ACP runtime backend. */
export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  const state: DeferredServiceState = {
    ctx: null,
    lifecycleRevision: 0,
    ownedRuntime: null,
    params,
    realRuntime: null,
    realService: null,
    startPromise: null,
    stopPromise: null,
  };

  return {
    id: "acpx-runtime",
    async start(ctx) {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }
      if (state.stopPromise) {
        await state.stopPromise;
      }

      state.lifecycleRevision += 1;
      const lifecycleRevision = state.lifecycleRevision;
      state.ctx = ctx;
      const deferredRuntime = createDeferredRuntime(state, lifecycleRevision);
      state.ownedRuntime = deferredRuntime;
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: deferredRuntime,
      });
      ctx.logger.info("embedded acpx runtime backend registered lazily");
    },
    async stop(ctx) {
      if (state.stopPromise) {
        return await state.stopPromise;
      }

      // Invalidate every deferred proxy before waiting for startup. The in-flight
      // service still owns cleanup, but it can no longer become the active runtime.
      state.lifecycleRevision += 1;
      state.ctx = null;
      const ownedRuntime = state.ownedRuntime;
      unregisterOwnedRuntime(ownedRuntime);
      const startPromise = state.startPromise;
      state.stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        try {
          await state.realService?.stop?.(ctx);
        } finally {
          unregisterOwnedRuntime(ownedRuntime);
          state.ownedRuntime = null;
          state.realRuntime = null;
          state.realService = null;
          state.startPromise = null;
        }
      })();
      try {
        await state.stopPromise;
      } finally {
        state.stopPromise = null;
      }
    },
  };
}
