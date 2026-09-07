import { getRuntimeConfig } from "../config/io.js";
import { retireQuestionChannelGateway } from "../infra/question-channel-runtime.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import type { GatewayHostLifecycle } from "./server-public.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

/** Completes the socket-free request and internal-dispatch half of Gateway startup. */
export async function prepareGatewayKernelRequestRuntime(params: {
  coreRuntime: GatewayCoreRuntime;
  log: GatewayLogger;
  logHealth: GatewayLogger;
  hostLifecycle?: GatewayHostLifecycle;
}) {
  const { coreRuntime: runtime, log, logHealth } = params;
  const {
    minimalTestGateway,
    runtimeState,
    bindApprovalPublicationContext,
    startupTrace,
    workerPlacementRuntime,
    githubPublicationRuntime,
    pluginGatewayContext,
    getAttachedGatewayMethodRegistry,
    gatewayInstanceRuntimeRef,
    lifecycle,
    startupState,
    kernel,
    shutdownRuntime,
  } = runtime;
  const chatMetadataLifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: getRuntimeConfig,
    minimalTestGateway,
    log,
  });
  const configRevisionProjector = await startupTrace.measure(
    "gateway.config-revision-key",
    async () => {
      const { loadGatewayConfigRevisionProjector } = await import("./config-revision-token.js");
      return loadGatewayConfigRevisionProjector({ env: process.env });
    },
  );
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      runtime,
      configRevisionProjector,
      chatMetadataLifecycle,
      log,
      logHealth,
    });
  });
  kernel.addGatewayLifetimeSidecar({
    stop: async () => {
      // Received mutations and their finalizers join before lifetime sidecars stop.
      // Retire this exact context too when no request ever bound its coordinator.
      retireQuestionChannelGateway(runtime.connectionWork.signal);
      await gatewayRequestContext.scopeUpgradeCoordinator?.close();
    },
  });
  gatewayRequestContext.requestEntryLifetime = runtime.requestEntryLifetime;
  bindApprovalPublicationContext(gatewayRequestContext);
  await attachInitialGatewayLifetimeSidecars({
    chatMetadataLifecycle,
    gatewayRequestContext,
    flushPendingSessionsChangedEvents: shutdownRuntime.flushPendingSessionsChangedEvents,
    minimalTestGateway,
    logWarning: (message) => log.warn(message),
    ...(!workerPlacementRuntime && githubPublicationRuntime
      ? { reconcileGitHubPublications: githubPublicationRuntime.reconcilePublications }
      : {}),
    sidecars: runtimeState.gatewayLifetimeSidecars,
  });
  pluginGatewayContext.current = gatewayRequestContext;
  gatewayRequestContext.dispatchHookAgentTurn = async (pluginId, hookParams) => {
    const transport = runtime.transportBridge.current();
    if (!transport) {
      throw new Error("Gateway listener must start before plugin hook dispatch");
    }
    return await transport.dispatchHookAgentTurn(pluginId, hookParams);
  };
  const { createGatewayInstanceRuntime } = await import("./server-instance-runtime.js");
  const gatewayInstanceRuntime = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    isDispatchAvailable: () => startupState.dispatchReady && !lifecycle.closePreludeStarted,
    logError: (message) => log.error(message),
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntime;
  gatewayRequestContext.resolveGatewayContext = () =>
    gatewayInstanceRuntime.isAvailable() ? gatewayRequestContext : undefined;
  // Detached RPC replies retain this availability fence after the request ends.
  // Shutdown must still recognize them as work owned by this exact Gateway.
  bindGatewayContextResolver(
    gatewayRequestContext.resolveGatewayContext,
    runtime.resolvePluginGatewayContext,
  );
  const hostLifecycle = params.hostLifecycle;
  if (hostLifecycle) {
    gatewayRequestContext.hostLifecycle = {
      externalRestart: hostLifecycle.externalRestart,
      request: (action, assertCaller) =>
        hostLifecycle.request(action, () => {
          if (!gatewayInstanceRuntime.isAvailable()) {
            throw new Error(
              "Gateway lifecycle is unavailable for this closed instance. Reconnect and retry.",
            );
          }
          assertCaller();
        }),
    };
  }
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntime.approvalEvents;
  gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntime.recovery;
  bindGatewayContextResolver(
    gatewayInstanceRuntime.recovery,
    gatewayRequestContext.resolveGatewayContext,
  );
  gatewayRequestContext.createAgentTurnFacade = gatewayInstanceRuntime.createAgentTurnFacade;
  return { ...runtime, chatMetadataLifecycle, gatewayRequestContext, gatewayInstanceRuntime };
}

export type GatewayKernelRuntime = Awaited<ReturnType<typeof prepareGatewayKernelRequestRuntime>>;
