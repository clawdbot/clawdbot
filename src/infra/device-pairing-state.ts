// Shared snapshot, lock, and normalization owner for device pairing domain modules.
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { loadDevicePairingStoreStateReadOnly } from "./device-pairing-store-readonly.js";
import {
  loadDevicePairingStoreState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";

const PAIRING_PENDING_TTL_MS = 5 * 60 * 1000;
const withLock = createAsyncLock();

function pruneExpiredPairingState(state: DevicePairingStoreState): void {
  const now = Date.now();
  pruneExpiredPending(state.pendingById, now, PAIRING_PENDING_TTL_MS);
  // Pending node-surface requests share the pairing TTL; requests refresh
  // their ts on reconnect so an actively retrying node keeps one alive.
  for (const device of Object.values(state.pairedByDeviceId)) {
    if (device.pendingNodeSurface && now - device.pendingNodeSurface.ts > PAIRING_PENDING_TTL_MS) {
      delete device.pendingNodeSurface;
    }
  }
}

/** Run one pairing mutation under the process-wide device pairing lock. */
export async function withDevicePairingLock<T>(operate: () => Promise<T>): Promise<T> {
  return await withLock(operate);
}

/** Load one mutable pairing snapshot with expired pending state removed. */
export async function loadDevicePairingState(baseDir?: string): Promise<DevicePairingStoreState> {
  const state = loadDevicePairingStoreState(baseDir);
  pruneExpiredPairingState(state);
  return state;
}

/** Load one read-only pairing snapshot with expired pending state removed. */
export async function loadDevicePairingStateReadOnly(
  baseDir?: string,
): Promise<DevicePairingStoreState> {
  const state = loadDevicePairingStoreStateReadOnly(baseDir);
  pruneExpiredPairingState(state);
  return state;
}

/** Return whether one pending pairing timestamp is beyond the shared TTL. */
export function isPairingRequestExpired(timestampMs: number, nowMs = Date.now()): boolean {
  return nowMs - timestampMs > PAIRING_PENDING_TTL_MS;
}

/** Resolve the expiry timestamp for one pending pairing request. */
export function resolvePairingRequestExpiry(timestampMs: number): number {
  return timestampMs + PAIRING_PENDING_TTL_MS;
}

/** Normalize a device id at pairing state boundaries. */
export function normalizeDevicePairingId(deviceId: string) {
  return deviceId.trim();
}

/** Normalize one requested or approved pairing role. */
export function normalizeDevicePairingRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

/** Merge pairing roles while preserving first-seen order. */
export function mergeDevicePairingRoles(
  ...items: Array<string | string[] | undefined>
): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    for (const role of normalizeUniqueSingleOrTrimmedStringList(item)) {
      roles.add(role);
    }
  }
  if (roles.size === 0) {
    return undefined;
  }
  return [...roles];
}

/** Merge pairing scopes while preserving first-seen order and explicit emptiness. */
export function mergeDevicePairingScopes(
  ...items: Array<string[] | undefined>
): string[] | undefined {
  const scopes = new Set<string>();
  let sawExplicitScopeList = false;
  for (const item of items) {
    if (!Array.isArray(item)) {
      continue;
    }
    sawExplicitScopeList = true;
    for (const scope of normalizeUniqueSingleOrTrimmedStringList(item)) {
      scopes.add(scope);
    }
  }
  if (scopes.size === 0) {
    return sawExplicitScopeList ? [] : undefined;
  }
  return [...scopes];
}

/** Preserve only approval scopes owned by one pairing role. */
export function preserveDeviceRoleScopes(role: string, scopes: string[] | undefined): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(scopes).filter((scope) =>
    role === "operator" ? scope.startsWith("operator.") : !scope.startsWith("operator."),
  );
}

/** Compare pairing role or scope lists as unordered sets. */
export function sameDevicePairingStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  for (const value of left) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

/** Resolve the normalized role set requested by a pairing record. */
export function resolveRequestedDeviceRoles(input: { role?: string; roles?: string[] }): string[] {
  return mergeDevicePairingRoles(input.roles, input.role) ?? [];
}

/** Clone a paired device's role-token map before mutation. */
export function cloneDevicePairingTokens(device: PairedDevice): Record<string, DeviceAuthToken> {
  return device.tokens ? { ...device.tokens } : {};
}

/** Refresh one compatible pending request or replace a superseded request set atomically. */
export function reconcilePendingPairingRequests<
  TPending extends { requestId: string },
  TIncoming,
>(params: {
  pendingById: Record<string, TPending>;
  existing: readonly TPending[];
  incoming: TIncoming;
  canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
  refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
  buildReplacement: (params: { existing: readonly TPending[]; incoming: TIncoming }) => TPending;
  persist: () => void;
}): { status: "pending"; request: TPending; created: boolean } {
  if (
    params.existing.length === 1 &&
    params.canRefreshSingle(
      expectDefined(params.existing[0], "existing entry at 0"),
      params.incoming,
    )
  ) {
    const refreshed = params.refreshSingle(
      expectDefined(params.existing[0], "existing entry at 0"),
      params.incoming,
    );
    params.pendingById[refreshed.requestId] = refreshed;
    params.persist();
    return { status: "pending", request: refreshed, created: false };
  }

  for (const existing of params.existing) {
    delete params.pendingById[existing.requestId];
  }

  const request = params.buildReplacement({
    existing: params.existing,
    incoming: params.incoming,
  });
  params.pendingById[request.requestId] = request;
  params.persist();
  return { status: "pending", request, created: true };
}
