// Gateway shared-auth generation enforcement.
// Disconnects clients when config writes invalidate shared credentials.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";

/** Gateway client subset relevant to shared auth generation enforcement. */
export type SharedGatewayAuthClient = {
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
  socket: { close: (code: number, reason: string) => void };
};

/** Mutable shared auth generation state. */
export type SharedGatewaySessionGenerationState = {
  current: string | undefined;
  required: string | undefined | null;
};

/** Disconnect shared-auth clients whose generation no longer matches the expected one. */
export function disconnectStaleSharedGatewayAuthClients(params: {
  clients: Iterable<SharedGatewayAuthClient>;
  expectedGeneration: string | undefined;
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    try {
      gatewayClient.socket.close(4001, "gateway auth changed");
    } catch {
      /* ignore */
    }
  }
}

/** Disconnect every shared-auth client regardless of generation. */
export function disconnectAllSharedGatewayAuthClients(
  clients: Iterable<SharedGatewayAuthClient>,
): void {
  for (const gatewayClient of clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    try {
      gatewayClient.socket.close(4001, "gateway auth changed");
    } catch {
      /* ignore */
    }
  }
}

/** Resolve the generation clients must use, treating null as "current is required". */
export function getRequiredSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
): string | undefined {
  return state.required === null ? state.current : state.required;
}

/** Update current generation and clear stale required-generation markers. */
export function setCurrentSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  nextGeneration: string | undefined,
): void {
  const previousGeneration = state.current;
  state.current = nextGeneration;
  if (state.required === nextGeneration) {
    state.required = null;
    return;
  }
  if (state.required !== null && previousGeneration !== nextGeneration) {
    state.required = null;
  }
}

/** Enforce shared auth generation behavior after a config write. */
export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  if (reloadMode === "off") {
    params.state.current = nextSharedGatewaySessionGeneration;
    params.state.required = nextSharedGatewaySessionGeneration;
    disconnectStaleSharedGatewayAuthClients({
      clients: params.clients,
      expectedGeneration: nextSharedGatewaySessionGeneration,
    });
    return;
  }
  params.state.required = null;
  setCurrentSharedGatewaySessionGeneration(params.state, nextSharedGatewaySessionGeneration);
  disconnectStaleSharedGatewayAuthClients({
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
  });
}
