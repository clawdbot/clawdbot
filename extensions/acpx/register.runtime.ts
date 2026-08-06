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
type CreateAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  lifecycleRevision: number;
  params: CreateAcpxRuntimeServiceParams;
  realRuntime: AcpRuntime | null;
  realService: OpenClawPluginService | null;
  startPromise: Promise<AcpRuntime> | null;
  stopPromise: Promise<void> | null;
};

const loadServiceModule = createLazyRuntimeModule(() => import("./src/service.js"));

async function startRealService(
  state: DeferredServiceState,
  lifecycleRevision: number,
): Promise<AcpRuntime> {
  if (state.lifecycleRevision !== lifecycleRevision || !state.ctx) {
    throw new Error("ACPX runtime service is not started");
  }
  if (state.realRuntime) {
    return state.realRuntime;
  }
  const ctx = state.ctx;
  state.startPromise ??= (async () => {
    const { createAcpxRuntimeService: createAcpxRuntimeServiceLocal } = await loadServiceModule();
    const service = createAcpxRuntimeServiceLocal(state.params);
    state.realService = service;
    await service.start(ctx);
    // The real service registers its backend during start. Only the current
    // outer lifecycle may publish that runtime after the async boundary.
    if (state.lifecycleRevision !== lifecycleRevision || state.ctx !== ctx) {
      throw new Error("ACPX runtime service stopped during activation");
    }
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
    if (state.lifecycleRevision === lifecycleRevision) {
      state.startPromise = null;
      state.realService = null;
    }
    throw error;
  }
}

function createDeferredRuntime(state: DeferredServiceState, lifecycleRevision: number): AcpRuntime {
  const resolveRuntime = () => startRealService(state, lifecycleRevision);
  return createLazyAcpRuntimeProxy(resolveRuntime);
}

/** Creates the plugin service that registers ACPX as an ACP runtime backend. */
export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  const state: DeferredServiceState = {
    ctx: null,
    lifecycleRevision: 0,
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
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: createDeferredRuntime(state, lifecycleRevision),
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
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      const startPromise = state.startPromise;
      state.stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        try {
          await state.realService?.stop?.(ctx);
        } finally {
          unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
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
