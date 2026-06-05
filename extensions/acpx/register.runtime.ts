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
import { createLazyAcpRuntimeProxy } from "./src/runtime-proxy.js";

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
    const { createAcpxRuntimeService: createAcpxRuntimeServiceLocal } = await loadServiceModule();
    const service = createAcpxRuntimeServiceLocal(state.params);
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

function createDeferredRuntime(state: DeferredServiceState): AcpRuntime {
  const resolveRuntime = () => startRealService(state);
  return createLazyAcpRuntimeProxy(resolveRuntime);
}

/** Creates the plugin service that registers ACPX as an ACP runtime backend. */
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
