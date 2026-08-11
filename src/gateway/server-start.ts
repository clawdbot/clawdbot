import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  createGatewayKernel,
  gatewayKernelLogs,
  resetPreparedModelCatalogForTestCore,
} from "./server-kernel.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { createGatewayHttpTransport } from "./server-runtime-state.js";
import { runGatewayShutdownSteps } from "./server-shutdown.js";
import { finishGatewayStartup } from "./server-startup-finish.js";

const loadGatewayStartupPostAttachModule = createLazyRuntimeModule(
  () => import("./server-startup-post-attach.js"),
);

const { log, logTailscale, logChannels, logHealth, logCron, logReload, logHooks, logWsControl } =
  gatewayKernelLogs;
const POST_READY_WORK_START_DELAY_MS = 500;

export { resetPreparedModelCatalogForTestCore };

export async function startGatewayServerCore(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  let releasePostReadyWork: () => void = () => {};
  const postReadyWorkBarrier = new Promise<void>((resolve) => {
    releasePostReadyWork = resolve;
  });
  const gatewayKernel = await createGatewayKernel(port, opts);
  let startupSettled: Promise<void>;
  const {
    beginClosePrelude,
    clearFallbackGatewayContextForServer,
    closeOnStartupFailure,
    createCloseHandler,
    sealAndJoinRegisteredSidecarStops,
    runClosePrelude,
    stopRegisteredGatewayLifetimeSidecars,
    stopRegisteredPostReadySidecars,
    terminalSessions,
    shutdownRuntime,
  } = gatewayKernel;
  try {
    const transport = await createGatewayHttpTransport(gatewayKernel.createHttpTransportOptions());
    gatewayKernel.transportBridge.attach(transport);
    const startup = await finishGatewayStartup({
      kernelRuntime: { ...gatewayKernel, ...transport },
      port,
      opts,
      log,
      logHealth,
      logWsControl,
      logHooks,
      logChannels,
      logCron,
      logReload,
      logTailscale,
      loadGatewayStartupPostAttachModule,
      waitForPostReadyWork: () => postReadyWorkBarrier,
    });
    startupSettled = startup.startupSettled;
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }
  // The public server is fully initialized now. Leave a short I/O window before
  // background prewarms and cleanup imports compete for the startup CPU.
  const postReadyWorkTimer = setTimeout(releasePostReadyWork, POST_READY_WORK_START_DELAY_MS);
  postReadyWorkTimer.unref?.();

  const close = createCloseHandler();

  return {
    startupSettled,
    getTailscaleIngressEndpoint: gatewayKernel.transportBridge.getTailscaleIngressEndpoint,
    close: async (optsLocal) => {
      await runGatewayShutdownSteps({
        steps: [
          { name: "close prelude fence", run: beginClosePrelude },
          // Kill any live operator shells before the socket layer tears down.
          { name: "terminal sessions", run: () => terminalSessions.disposeAll() },
          { name: "gateway lifetime sidecars", run: stopRegisteredGatewayLifetimeSidecars },
          { name: "post-ready sidecars", run: stopRegisteredPostReadySidecars },
          {
            name: "gateway_stop plugin hooks",
            run: async () => {
              await shutdownRuntime.runGlobalGatewayStopSafely({
                event: { reason: optsLocal?.reason ?? "gateway stopping" },
                ctx: { port },
                onError: (error) =>
                  log.warn(`gateway_stop hook failed: ${formatErrorMessage(error)}`),
              });
            },
          },
          { name: "gateway close prelude", run: runClosePrelude },
          { name: "late sidecar cleanup", run: sealAndJoinRegisteredSidecarStops },
          { name: "gateway close", run: () => close(optsLocal) },
          {
            name: "fallback gateway context",
            run: () => clearFallbackGatewayContextForServer.get()(),
          },
        ],
        onError: (message) => log.error(message),
      });
    },
  };
}
