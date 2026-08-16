import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  createGatewayKernel,
  gatewayKernelLogs,
  resetPreparedModelCatalogForTestCore,
} from "./server-kernel.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { createGatewayHttpTransport } from "./server-runtime-state.js";
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
    markClosePreludeStarted,
    runClosePrelude,
    stopRegisteredGatewayLifetimeSidecars,
    stopRegisteredPostReadySidecars,
    terminalSessions,
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
    close: async (optsLocal) => {
      const closeErrors: unknown[] = [];
      const runCloseStep = async (label: string, step: () => void | Promise<void>) => {
        try {
          await step();
        } catch (err) {
          closeErrors.push(err);
          log.warn(`gateway close ${label} failed: ${String(err)}`);
        }
      };
      try {
        await runCloseStep("prelude fence", markClosePreludeStarted);
        await runCloseStep("prelude owners", beginClosePrelude);
        // Kill any live operator shells before the socket layer tears down.
        await runCloseStep("terminal sessions", () => terminalSessions.disposeAll());
        await runCloseStep("lifetime sidecars", stopRegisteredGatewayLifetimeSidecars);
        await runCloseStep("post-ready sidecars", stopRegisteredPostReadySidecars);
        // Run gateway_stop plugin hook before shutdown
        await runCloseStep("plugin hook", async () => {
          const { runGlobalGatewayStopSafely } = await import("../plugins/hook-runner-global.js");
          await runGlobalGatewayStopSafely({
            event: { reason: optsLocal?.reason ?? "gateway stopping" },
            ctx: { port },
            onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
          });
        });
        await runCloseStep("runtime prelude", runClosePrelude);
        await runCloseStep("transport", () => close(optsLocal));
        if (closeErrors.length > 0) {
          throw closeErrors[0];
        }
      } finally {
        clearFallbackGatewayContextForServer.get()();
      }
    },
  };
}
