// Shared snapshot, lock, and normalization owner for device pairing domain modules.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { loadDevicePairingStoreStateReadOnly } from "./device-pairing-store-readonly.js";
import {
  loadDevicePairingStoreState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRecord,
  DevicePairingPendingRequest,
  PairedDevice,
} from "./device-pairing.types.js";
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

type IncomingDevicePairingRequest = Omit<
  DevicePairingPendingRequest,
  "requestId" | "ts" | "isRepair"
>;

function samePendingApprovalSnapshot(
  existing: DevicePairingPendingRequest,
  incoming: IncomingDevicePairingRequest,
): boolean {
  return (
    existing.publicKey === incoming.publicKey &&
    existing.browserOrigin === incoming.browserOrigin &&
    normalizeDevicePairingRole(existing.role) === normalizeDevicePairingRole(incoming.role) &&
    sameDevicePairingStringSet(
      resolveRequestedDeviceRoles(existing),
      resolveRequestedDeviceRoles(incoming),
    ) &&
    sameDevicePairingStringSet(
      normalizeDeviceAuthScopes(existing.scopes),
      normalizeDeviceAuthScopes(incoming.scopes),
    )
  );
}

function isStringSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const supersetSet = new Set(superset);
  return subset.every((value) => supersetSet.has(value));
}

function incomingApprovalCoveredByExisting(
  existing: DevicePairingPendingRequest,
  incoming: IncomingDevicePairingRequest,
): boolean {
  if (
    existing.publicKey !== incoming.publicKey ||
    existing.browserOrigin !== incoming.browserOrigin ||
    normalizeDevicePairingRole(existing.role) !== normalizeDevicePairingRole(incoming.role)
  ) {
    return false;
  }
  const incomingRoles = resolveRequestedDeviceRoles(incoming);
  if (!isStringSubset(incomingRoles, resolveRequestedDeviceRoles(existing))) {
    return false;
  }
  const existingScopes = normalizeDeviceAuthScopes(existing.scopes);
  return normalizeDeviceAuthScopes(incoming.scopes).every((scope) =>
    incomingRoles.some((role) =>
      roleScopesAllow({ role, requestedScopes: [scope], allowedScopes: existingScopes }),
    ),
  );
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRecord,
  incoming: IncomingDevicePairingRequest,
  isRepair: boolean,
): DevicePairingPendingRecord {
  return {
    ...existing,
    publicKey: incoming.publicKey,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    browserOrigin: existing.browserOrigin,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    // Preserve creation time so reconnects cannot jump the owner's approval queue.
    ts: existing.ts,
    refreshedAtMs: Date.now(),
  };
}

function buildPendingDevicePairingRequest(params: {
  deviceId: string;
  isRepair: boolean;
  req: IncomingDevicePairingRequest;
}): DevicePairingPendingRecord {
  const role = normalizeDevicePairingRole(params.req.role) ?? undefined;
  return {
    requestId: randomUUID(),
    deviceId: params.deviceId,
    publicKey: params.req.publicKey,
    displayName: params.req.displayName,
    platform: params.req.platform,
    deviceFamily: params.req.deviceFamily,
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    browserOrigin: params.req.browserOrigin,
    role,
    roles: mergeDevicePairingRoles(params.req.roles, role),
    scopes: mergeDevicePairingScopes(params.req.scopes),
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    isRepair: params.isRepair,
    ts: Date.now(),
  };
}

/** Reconcile one incoming request against the mutable pairing snapshot. */
export function prepareDevicePairingRequest(params: {
  state: DevicePairingStoreState;
  req: IncomingDevicePairingRequest;
}) {
  const deviceId = normalizeDevicePairingId(params.req.deviceId);
  if (!deviceId) {
    throw new Error("deviceId required");
  }
  const isRepair = Boolean(params.state.pairedByDeviceId[deviceId]);
  const existing = Object.values(params.state.pendingById)
    .filter((pending) => pending.deviceId === deviceId)
    .toSorted((left, right) => right.ts - left.ts);
  const result = reconcilePendingPairingRequests({
    pendingById: params.state.pendingById,
    existing,
    incoming: params.req,
    canRefreshSingle: (pending, incoming) =>
      samePendingApprovalSnapshot(pending, incoming) ||
      incomingApprovalCoveredByExisting(pending, incoming),
    refreshSingle: (pending, incoming) =>
      refreshPendingDevicePairingRequest(pending, incoming, isRepair),
    buildReplacement: ({ existing: priorRequests, incoming }) => {
      const latestPending = priorRequests[0];
      const roles = mergeDevicePairingRoles(
        ...priorRequests.flatMap((pending) => [pending.roles, pending.role]),
        incoming.roles,
        incoming.role,
      );
      const scopes = mergeDevicePairingScopes(
        ...priorRequests.map((pending) => pending.scopes),
        incoming.scopes,
      );
      return buildPendingDevicePairingRequest({
        deviceId,
        isRepair,
        req: {
          ...incoming,
          role: normalizeDevicePairingRole(incoming.role) ?? latestPending?.role,
          roles,
          scopes,
          // Once an owner-visible request exists, replacements stay visible.
          silent: Boolean(
            incoming.silent && priorRequests.every((pending) => pending.silent === true),
          ),
        },
      });
    },
    persist: () => {},
  });
  const superseded = result.created
    ? existing.filter((pending) => pending.requestId !== result.request.requestId)
    : [];
  return { result, superseded };
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
