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

export type SharedGatewaySessionGenerationOwnership = {
  generation: string | undefined;
  previousGeneration: string | undefined;
  revision: number;
};

const stateRevisions = new WeakMap<SharedGatewaySessionGenerationState, number>();

function advanceStateRevision(state: SharedGatewaySessionGenerationState): number {
  const revision = (stateRevisions.get(state) ?? 0) + 1;
  stateRevisions.set(state, revision);
  return revision;
}

/** Capture current generation-state ownership without mutating it. */
export function captureSharedGatewaySessionGenerationOwnership(
  state: SharedGatewaySessionGenerationState,
): SharedGatewaySessionGenerationOwnership {
  return {
    generation: state.current,
    previousGeneration: state.current,
    revision: stateRevisions.get(state) ?? 0,
  };
}

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

/** Claim current generation while preserving required until its transaction commits. */
function claimSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  generation: string | undefined,
): SharedGatewaySessionGenerationOwnership {
  const previousGeneration = state.current;
  state.current = generation;
  return { generation, previousGeneration, revision: advanceStateRevision(state) };
}

/** Claim current only while no later generation-state writer has run. */
export function claimSharedGatewaySessionGenerationIfOwned(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  generation: string | undefined,
): SharedGatewaySessionGenerationOwnership | null {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return null;
  }
  return claimSharedGatewaySessionGeneration(state, generation);
}

/** Check whether a transaction still owns all generation-state mutations. */
export function isSharedGatewaySessionGenerationOwnershipCurrent(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
): boolean {
  return (stateRevisions.get(state) ?? 0) === ownership.revision;
}

/** Replace both generation fields as one ownership-changing mutation. */
function replaceSharedGatewaySessionGenerationState(
  state: SharedGatewaySessionGenerationState,
  next: Pick<SharedGatewaySessionGenerationState, "current" | "required">,
): void {
  state.current = next.current;
  state.required = next.required;
  advanceStateRevision(state);
}

/** Replace both fields only while the caller still owns generation state. */
export function replaceOwnedSharedGatewaySessionGenerationState(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  next: Pick<SharedGatewaySessionGenerationState, "current" | "required">,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  replaceSharedGatewaySessionGenerationState(state, next);
  return true;
}

/** Restore current only while preserving the required marker owned by the transaction. */
export function restoreOwnedCurrentSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  current: string | undefined,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  state.current = current;
  advanceStateRevision(state);
  return true;
}

/** Update the required marker as one ownership-changing mutation. */
function setRequiredSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  required: string | undefined | null,
): void {
  state.required = required;
  advanceStateRevision(state);
}

/** Update required only while no later generation-state writer has run. */
export function setRequiredSharedGatewaySessionGenerationIfOwned(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  required: string | undefined | null,
): SharedGatewaySessionGenerationOwnership | null {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return null;
  }
  setRequiredSharedGatewaySessionGeneration(state, required);
  return captureSharedGatewaySessionGenerationOwnership(state);
}

/** Finalize only while no later generation-state writer has replaced this owner. */
export function finalizeOwnedSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  state.current = ownership.generation;
  if (
    state.required === ownership.generation ||
    (state.required !== null && ownership.previousGeneration !== ownership.generation)
  ) {
    state.required = null;
  }
  advanceStateRevision(state);
  return true;
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
    replaceSharedGatewaySessionGenerationState(params.state, {
      current: nextSharedGatewaySessionGeneration,
      required: nextSharedGatewaySessionGeneration,
    });
    disconnectStaleSharedGatewayAuthClients({
      clients: params.clients,
      expectedGeneration: nextSharedGatewaySessionGeneration,
    });
    return;
  }
  replaceSharedGatewaySessionGenerationState(params.state, {
    current: nextSharedGatewaySessionGeneration,
    required: null,
  });
  disconnectStaleSharedGatewayAuthClients({
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
  });
}
