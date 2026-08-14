import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { SessionWorkerPlacementContext } from "./worker-environments/session-placement-lifecycle.js";

export type { SessionWorkerPlacementContext } from "./worker-environments/session-placement-lifecycle.js";

const localPlacementState = resolveGlobalSingleton(
  Symbol.for("openclaw.localSessionWorkerPlacementContext"),
  (): { store?: ReturnType<typeof createWorkerSessionPlacementStore> } => ({}),
  (state) => {
    state.store = undefined;
  },
);

/** Uses the live Gateway owner when present; embedded runtimes share the same lightweight DB. */
export function resolveSessionWorkerPlacementContext(): SessionWorkerPlacementContext {
  const gatewayContext =
    getPluginRuntimeGatewayRequestScope()?.context ?? getFallbackGatewayContext();
  if (gatewayContext?.workerSessionPlacementService) {
    return gatewayContext;
  }
  localPlacementState.store ??= createWorkerSessionPlacementStore();
  return { workerSessionPlacementService: localPlacementState.store };
}
