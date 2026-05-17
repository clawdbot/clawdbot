import {
  getAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
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
  return await state.startPromise;
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
      await startRealService(state);
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
