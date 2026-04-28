import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeStatus,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";

const ACPX_BACKEND_ID = "acpx";
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";

type RealAcpxServiceModule = typeof import("./src/service.js");
type CreateAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  isHealthy(): boolean;
};

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  params: CreateAcpxRuntimeServiceParams;
  realRuntime: AcpxRuntimeLike | null;
  realService: OpenClawPluginService | null;
  startPromise: Promise<AcpxRuntimeLike> | null;
};

let serviceModulePromise: Promise<RealAcpxServiceModule> | null = null;

function loadServiceModule(): Promise<RealAcpxServiceModule> {
  serviceModulePromise ??= import("./src/service.js");
  return serviceModulePromise;
}

function shouldRunStartupProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_STARTUP_PROBE_ENV] === "1";
}

async function startRealService(state: DeferredServiceState): Promise<AcpxRuntimeLike> {
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
    state.realRuntime = backend.runtime as AcpxRuntimeLike;
    return state.realRuntime;
  })();
  return await state.startPromise;
}

function createDeferredRuntime(state: DeferredServiceState): AcpxRuntimeLike {
  return {
    async ensureSession(input) {
      return await (await startRealService(state)).ensureSession(input);
    },
    async *runTurn(input) {
      yield* (await startRealService(state)).runTurn(input);
    },
    async getCapabilities(input): Promise<AcpRuntimeCapabilities> {
      const runtime = await startRealService(state);
      return (await runtime.getCapabilities?.(input)) ?? { controls: [] };
    },
    async getStatus(input): Promise<AcpRuntimeStatus> {
      const runtime = await startRealService(state);
      return (await runtime.getStatus?.(input)) ?? {};
    },
    async setMode(input) {
      await (await startRealService(state)).setMode?.(input);
    },
    async setConfigOption(input) {
      await (await startRealService(state)).setConfigOption?.(input);
    },
    async doctor(): Promise<AcpRuntimeDoctorReport> {
      const runtime = await startRealService(state);
      return (await runtime.doctor?.()) ?? { ok: true, message: "ok" };
    },
    async prepareFreshSession(input) {
      await (await startRealService(state)).prepareFreshSession?.(input);
    },
    async cancel(input) {
      await (await startRealService(state)).cancel(input);
    },
    async close(input) {
      await (await startRealService(state)).close(input);
    },
    async probeAvailability() {
      await (await startRealService(state)).probeAvailability();
    },
    isHealthy() {
      return state.realRuntime?.isHealthy() ?? false;
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
      if (shouldRunStartupProbe()) {
        await startRealService(state);
        return;
      }

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
