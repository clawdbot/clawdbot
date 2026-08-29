// Manages device pairing requests, records, metadata, and node pairing state.
import { createHash, randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { isProgressCardRendererClient } from "../utils/message-channel.js";
import { revokeDeviceBootstrapTokensForDevice } from "./device-bootstrap.js";
import {
  cloneDevicePairingTokens,
  isPairingRequestExpired,
  loadDevicePairingState,
  loadDevicePairingStateReadOnly,
  mergeDevicePairingRoles,
  mergeDevicePairingScopes,
  mutateDevicePairingState,
  normalizeDevicePairingId,
  normalizeDevicePairingRole,
  preserveDeviceRoleScopes,
  reconcilePendingPairingRequests,
  resolvePairingRequestExpiry,
  resolveRequestedDeviceRoles,
  sameDevicePairingStringSet,
  withDevicePairingLock as withLock,
} from "./device-pairing-state.js";
import {
  loadPairedDevicePairingStoreRecord,
  updatePairedDevicePresenceInTransaction,
  type DevicePairingStorePersist,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRecord,
  DevicePairingPendingRequest,
  PairedDevice,
} from "./device-pairing.types.js";

export type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDevicePendingNodeSurface,
} from "./device-pairing.types.js";

export type NodePairingGeneration = {
  nodeId: string;
  key: string;
};

export type NodePairingIdentity = {
  nodeId: string;
  key: string;
};

export type NodePairingState = {
  identity: NodePairingIdentity;
  generation: NodePairingGeneration | null;
};

/** Pending request summary returned when a replacement supersedes older requests. */
type DevicePairingSupersededRequest = Pick<DevicePairingPendingRequest, "requestId" | "deviceId">;

/** Result for creating or refreshing a pending device pairing request. */
type RequestDevicePairingResult = {
  status: "pending";
  request: DevicePairingPendingRequest;
  expiresAtMs: number;
  created: boolean;
  superseded?: DevicePairingSupersededRequest[];
};

/** Metadata fields a device may refresh without changing approval or token state. */
type PairedDeviceMetadataPatch = Pick<
  PairedDevice,
  | "displayName"
  | "operatorLabel"
  | "platform"
  | "clientId"
  | "clientMode"
  | "remoteIp"
  | "lastSeenAtMs"
  | "lastSeenReason"
>;

/** Combined pending/paired view returned by pairing list APIs. */
type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

// Pairing mutations own invalidation, so this single-slot cache keeps SQLite out
// of attempt hot paths without serving a removed or newly approved renderer.
let pairedCardRendererCache: { stateDir: string; value: Promise<boolean> } | undefined;

export function invalidatePairedCardRendererCache(): void {
  pairedCardRendererCache = undefined;
}

/** Return whether this Gateway has a paired client that can render progress cards. */
export function hasPairedCardRenderer(baseDir?: string): Promise<boolean> {
  const stateDir = baseDir ?? resolveStateDir();
  if (pairedCardRendererCache?.stateDir !== stateDir) {
    const value = listDevicePairingReadOnly(stateDir)
      .then(({ paired }) => paired.some(isProgressCardRendererClient))
      .catch(() => false);
    pairedCardRendererCache = { stateDir, value };
  }
  return pairedCardRendererCache.value;
}

function mutatePairingState<T>(
  baseDir: string | undefined,
  mutate: (state: DevicePairingStoreState, persist: DevicePairingStorePersist) => T,
): T {
  let persisted = false;
  const value = mutateDevicePairingState(baseDir, (state, persist) =>
    mutate(state, (target, options) => {
      persisted = true;
      persist(target, options);
    }),
  );
  if (persisted) {
    invalidatePairedCardRendererCache();
  }
  return value;
}

/**
 * Internal seam for the paired-device node-surface module: run one
 * operation against the paired-device records under the shared pairing lock.
 * Return `persist: true` to write the paired store after the mutation. Not a
 * public API — node surface state lives inside device records, and both
 * modules must serialize through the same lock to avoid lost updates.
 */
export async function withPairedDeviceRecords<T>(
  baseDir: string | undefined,
  operate: (pairedByDeviceId: Record<string, PairedDevice>) => { value: T; persist: boolean },
): Promise<T> {
  return await withLock(async () =>
    mutatePairingState(baseDir, (state, persist) => {
      const outcome = operate(state.pairedByDeviceId);
      if (outcome.persist) {
        persist("paired");
      }
      return outcome.value;
    }),
  );
}

function listActiveTokenRoles(
  tokens: Record<string, DeviceAuthToken> | undefined,
): string[] | undefined {
  if (!tokens) {
    return undefined;
  }
  return mergeDevicePairingRoles(
    Object.values(tokens)
      .filter((entry) => !entry.revokedAtMs)
      .map((entry) => entry.role),
  );
}

/** List the durable roles an owner approved for a paired device record. */
export function listApprovedPairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles">,
): string[] {
  // Approved roles come from the pairing record itself. This is the durable
  // contract the owner approved, independent of any currently active tokens.
  return mergeDevicePairingRoles(device.roles, device.role) ?? [];
}

/** List active-token roles, bounded by the durable approved pairing roles. */
export function listEffectivePairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
): string[] {
  const activeTokenRoles = listActiveTokenRoles(device.tokens);
  if (activeTokenRoles && activeTokenRoles.length > 0) {
    // Effective roles are the active token roles, bounded by the approved
    // pairing contract. A stray token entry must not grant new access.
    const approvedRoles = new Set(listApprovedPairedDeviceRoles(device));
    return activeTokenRoles.filter((role) => approvedRoles.has(role));
  }
  // Token entries are authoritative. Tokenless legacy records fail closed so
  // sticky historical role fields cannot retain access after token migration.
  return [];
}

/** Return whether a paired device currently has an active token for one role. */
export function hasEffectivePairedDeviceRole(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
  role: string,
): boolean {
  const normalized = normalizeDevicePairingRole(role);
  if (!normalized) {
    return false;
  }
  return listEffectivePairedDeviceRoles(device).includes(normalized);
}

/** Resolve the authenticated node pairing independently of surface approval. */
function resolveNodePairingIdentity(device: PairedDevice | null): NodePairingIdentity | null {
  if (!device || !hasEffectivePairedDeviceRole(device, "node")) {
    return null;
  }
  const nodeToken = device.tokens?.node;
  if (!nodeToken) {
    return null;
  }
  const key = createHash("sha256")
    .update(
      [
        device.publicKey,
        device.createdAtMs,
        nodeToken.token,
        nodeToken.createdAtMs,
        nodeToken.rotatedAtMs ?? "",
        nodeToken.revokedAtMs ?? "",
      ].join("\0"),
    )
    .digest("hex");
  return { nodeId: device.deviceId, key };
}

/** Resolve the durable node-owned identity used to admit asynchronous work. */
export function resolveNodePairingGeneration(
  device: PairedDevice | null,
): NodePairingGeneration | null {
  if (!device || !hasEffectivePairedDeviceRole(device, "node") || !device.nodeSurface) {
    return null;
  }
  const nodeToken = device.tokens?.node;
  const nodeSurface = device.nodeSurface;
  // Device-wide approval also changes for unrelated operator upgrades, so only
  // node-owned identity participates in the generation.
  const key = createHash("sha256")
    .update(
      [
        device.publicKey,
        device.createdAtMs,
        nodeToken?.token ?? "",
        nodeToken?.revokedAtMs ?? "",
        nodeSurface.createdAtMs,
        nodeSurface.approvedAtMs,
      ].join("\0"),
    )
    .digest("hex");
  return { nodeId: device.deviceId, key };
}

/** Clear node runtime facts when their owning pairing generation changes. */
export function clearNodePairingGenerationState(
  device: PairedDevice,
  previousGeneration: NodePairingGeneration | null,
): void {
  const nextGeneration = resolveNodePairingGeneration(device);
  if (previousGeneration?.key === nextGeneration?.key || !device.nodeSurface) {
    return;
  }
  delete device.nodeSurface.bins;
  delete device.nodeSurface.sessionHost;
}

/** Resolve connection identity and optional approved surface generation from one row. */
export function resolveNodePairingState(device: PairedDevice | null): NodePairingState | null {
  const identity = resolveNodePairingIdentity(device);
  if (!identity) {
    return null;
  }
  return { identity, generation: resolveNodePairingGeneration(device) };
}

function resolveRequestedScopes(input: { scopes?: string[] }): string[] {
  return normalizeDeviceAuthScopes(input.scopes);
}

function samePendingApprovalSnapshot(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeDevicePairingRole(existing.role) !== normalizeDevicePairingRole(incoming.role)) {
    return false;
  }
  if (
    !sameDevicePairingStringSet(
      resolveRequestedDeviceRoles(existing),
      resolveRequestedDeviceRoles(incoming),
    ) ||
    !sameDevicePairingStringSet(resolveRequestedScopes(existing), resolveRequestedScopes(incoming))
  ) {
    return false;
  }
  return true;
}

function isStringSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const supersetSet = new Set(superset);
  for (const value of subset) {
    if (!supersetSet.has(value)) {
      return false;
    }
  }
  return true;
}

// True when the incoming request only asks for roles/scopes a single existing pending
// request (same key + role) already covers. Such subset re-requests refresh in place so
// the owner's listed requestId stays valid; escalations still supersede with a fresh id.
function incomingApprovalCoveredByExisting(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeDevicePairingRole(existing.role) !== normalizeDevicePairingRole(incoming.role)) {
    return false;
  }
  const incomingRoles = resolveRequestedDeviceRoles(incoming);
  if (!isStringSubset(incomingRoles, resolveRequestedDeviceRoles(existing))) {
    return false;
  }
  const existingScopes = resolveRequestedScopes(existing);
  for (const scope of resolveRequestedScopes(incoming)) {
    const covered = incomingRoles.some((role) =>
      roleScopesAllow({
        role,
        requestedScopes: [scope],
        allowedScopes: existingScopes,
      }),
    );
    if (!covered) {
      return false;
    }
  }
  return true;
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRecord,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
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
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    // Preserve the original creation timestamp so that reconnects cannot bump this
    // request's queue position. Using Date.now() here would let an attacker silently
    // refresh recency and win the implicit --latest approval race.
    ts: existing.ts,
    // Keepalive for the pending TTL only (see pruneExpiredPending); never affects ordering.
    refreshedAtMs: Date.now(),
  };
}

function resolveSupersededPendingSilent(params: {
  existing: readonly DevicePairingPendingRequest[];
  incomingSilent: boolean | undefined;
}): boolean {
  return Boolean(
    params.incomingSilent && params.existing.every((pending) => pending.silent === true),
  );
}

function toPublicPendingDevicePairingRequest(
  pending: DevicePairingPendingRecord,
): DevicePairingPendingRequest {
  const { refreshedAtMs: _refreshedAtMs, ...request } = pending;
  return request;
}

function buildPendingDevicePairingRequest(params: {
  requestId?: string;
  deviceId: string;
  isRepair: boolean;
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
}): DevicePairingPendingRequest {
  const role = normalizeDevicePairingRole(params.req.role) ?? undefined;
  return {
    requestId: params.requestId ?? randomUUID(),
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

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadDevicePairingState(baseDir);
  const pending = Object.values(state.pendingById)
    .map(toPublicPendingDevicePairingRequest)
    .toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

/** List pairing state without creating or migrating shared state. */
export async function listDevicePairingReadOnly(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadDevicePairingStateReadOnly(baseDir);
  const pending = Object.values(state.pendingById)
    .map(toPublicPendingDevicePairingRequest)
    .toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

/** Return one paired device by normalized device id. */
export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<PairedDevice | null> {
  const device = loadPairedDevicePairingStoreRecord(normalizeDevicePairingId(deviceId), baseDir);
  if (device?.pendingNodeSurface && isPairingRequestExpired(device.pendingNodeSurface.ts)) {
    delete device.pendingNodeSurface;
  }
  return device;
}

/** Return one pending pairing request by request id. */
export async function getPendingDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<DevicePairingPendingRequest | null> {
  const state = await loadDevicePairingState(baseDir);
  const pending = state.pendingById[requestId];
  return pending ? toPublicPendingDevicePairingRequest(pending) : null;
}

/** Create or refresh a pending device pairing request for owner approval. */
export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<RequestDevicePairingResult> {
  return await withLock(async () => {
    return mutatePairingState(baseDir, (state, persist) => {
      const deviceId = normalizeDevicePairingId(req.deviceId);
      if (!deviceId) {
        throw new Error("deviceId required");
      }
      const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
      const pendingForDevice = Object.values(state.pendingById)
        .filter((pending) => pending.deviceId === deviceId)
        .toSorted((left, right) => right.ts - left.ts);
      const result = reconcilePendingPairingRequests({
        pendingById: state.pendingById,
        existing: pendingForDevice,
        incoming: req,
        canRefreshSingle: (existing, incoming) =>
          samePendingApprovalSnapshot(existing, incoming) ||
          incomingApprovalCoveredByExisting(existing, incoming),
        refreshSingle: (existing, incoming) =>
          refreshPendingDevicePairingRequest(existing, incoming, isRepair),
        buildReplacement: ({ existing, incoming }) => {
          const latestPending = existing[0];
          const mergedRoles = mergeDevicePairingRoles(
            ...existing.flatMap((pending) => [pending.roles, pending.role]),
            incoming.roles,
            incoming.role,
          );
          const mergedScopes = mergeDevicePairingScopes(
            ...existing.map((pending) => pending.scopes),
            incoming.scopes,
          );
          return buildPendingDevicePairingRequest({
            deviceId,
            isRepair,
            req: {
              ...incoming,
              role: normalizeDevicePairingRole(incoming.role) ?? latestPending?.role,
              roles: mergedRoles,
              scopes: mergedScopes,
              // Preserve interactive visibility when superseding pending requests:
              // if any previous pending request was interactive, keep this one interactive.
              silent: resolveSupersededPendingSilent({
                existing,
                incomingSilent: incoming.silent,
              }),
            },
          });
        },
        persist: () => persist("pending"),
      });
      // Surface superseded requestIds so callers can broadcast their resolution;
      // clients otherwise keep prompting for requests that can no longer be approved.
      const superseded = result.created
        ? pendingForDevice
            .filter((pending) => pending.requestId !== result.request.requestId)
            .map((pending) => ({ requestId: pending.requestId, deviceId: pending.deviceId }))
        : [];
      const publicResult = {
        ...result,
        request: toPublicPendingDevicePairingRequest(result.request),
        expiresAtMs: resolvePairingRequestExpiry(result.request.refreshedAtMs ?? result.request.ts),
      };
      return superseded.length > 0 ? { ...publicResult, superseded } : publicResult;
    });
  });
}

/** Reject a pending request and revoke matching bootstrap tokens for that device. */
export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withLock(async () => {
    const removed = mutatePairingState(baseDir, (state, persist) => {
      const pending = state.pendingById[requestId];
      if (!pending) {
        return null;
      }
      delete state.pendingById[requestId];
      persist("pending");
      return { deviceId: pending.deviceId, publicKey: pending.publicKey };
    });
    if (!removed) {
      return null;
    }
    await revokeDeviceBootstrapTokensForDevice({
      deviceId: removed.deviceId,
      publicKey: removed.publicKey,
      baseDir,
    });
    return { requestId, deviceId: removed.deviceId };
  });
}

/** Remove a paired device and any pending repair requests for the same device id. */
export async function removePairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<{ deviceId: string } | null> {
  return await withLock(async () => {
    return mutatePairingState(baseDir, (state, persist) => {
      const normalized = normalizeDevicePairingId(deviceId);
      if (!normalized || !state.pairedByDeviceId[normalized]) {
        return null;
      }
      delete state.pairedByDeviceId[normalized];
      for (const [requestId, pending] of Object.entries(state.pendingById)) {
        if (pending.deviceId === normalized) {
          delete state.pendingById[requestId];
        }
      }
      persist("both", { clearApnsNodeIds: [normalized] });
      return { deviceId: normalized };
    });
  });
}

/** Remove one approved paired-device role while preserving unrelated role tokens. */
export async function removePairedDeviceRole(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<{ deviceId: string; role: string; removedDevice: boolean } | null> {
  return await withLock(async () => {
    return mutatePairingState(params.baseDir, (state, persist) => {
      const normalizedDeviceId = normalizeDevicePairingId(params.deviceId);
      const role = normalizeDevicePairingRole(params.role);
      const device = state.pairedByDeviceId[normalizedDeviceId];
      if (!device || !role || !listApprovedPairedDeviceRoles(device).includes(role)) {
        return null;
      }

      const tokens = cloneDevicePairingTokens(device);
      delete tokens[role];
      const remainingRoles = listApprovedPairedDeviceRoles(device).filter(
        (entry) => entry !== role,
      );
      if (remainingRoles.length === 0) {
        for (const [requestId, pending] of Object.entries(state.pendingById)) {
          if (pending.deviceId === normalizedDeviceId) {
            delete state.pendingById[requestId];
          }
        }
        delete state.pairedByDeviceId[normalizedDeviceId];
        persist("both", {
          clearApnsNodeIds: [normalizedDeviceId],
        });
        return { deviceId: normalizedDeviceId, role, removedDevice: true };
      }

      for (const [requestId, pending] of Object.entries(state.pendingById)) {
        if (pending.deviceId !== normalizedDeviceId) {
          continue;
        }
        const pendingRoles = resolveRequestedDeviceRoles(pending);
        if (!pendingRoles.includes(role)) {
          continue;
        }
        const nextPendingRoles = pendingRoles.filter((entry) => entry !== role);
        if (nextPendingRoles.length === 0) {
          delete state.pendingById[requestId];
          continue;
        }
        const pendingScopes = Array.isArray(pending.scopes)
          ? mergeDevicePairingScopes(
              ...nextPendingRoles.map((entry) => preserveDeviceRoleScopes(entry, pending.scopes)),
            )
          : undefined;
        state.pendingById[requestId] = {
          ...pending,
          role: nextPendingRoles[0],
          roles: nextPendingRoles,
          scopes: pendingScopes,
        };
      }

      const scopeBaseline = device.approvedScopes ?? device.scopes;
      const preservedScopes = Array.isArray(scopeBaseline)
        ? mergeDevicePairingScopes(
            ...remainingRoles.map((entry) => preserveDeviceRoleScopes(entry, scopeBaseline)),
          )
        : undefined;
      const next: PairedDevice = {
        ...device,
        role: remainingRoles[0],
        roles: remainingRoles,
        ...(preservedScopes !== undefined
          ? { scopes: preservedScopes, approvedScopes: preservedScopes }
          : {}),
        tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
      };
      if (role === "node") {
        // The node capability surface is bound to the node role; revoking the
        // role must revoke approved command exposure with it.
        delete next.nodeSurface;
        delete next.pendingNodeSurface;
      }
      state.pairedByDeviceId[normalizedDeviceId] = next;
      persist("both");
      return { deviceId: normalizedDeviceId, role, removedDevice: false };
    });
  });
}

/** Update non-auth metadata for a paired device presence/status refresh. */
export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<PairedDeviceMetadataPatch>,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    return mutatePairingState(baseDir, (state, persist) => {
      const normalizedDeviceId = normalizeDevicePairingId(deviceId);
      const existing = state.pairedByDeviceId[normalizedDeviceId];
      if (!existing) {
        return false;
      }
      const next = { ...existing };
      if ("displayName" in patch) {
        next.displayName = patch.displayName;
      }
      if ("operatorLabel" in patch) {
        next.operatorLabel = patch.operatorLabel;
      }
      if ("platform" in patch) {
        next.platform = patch.platform;
      }
      if ("clientId" in patch) {
        next.clientId = patch.clientId;
      }
      if ("clientMode" in patch) {
        next.clientMode = patch.clientMode;
      }
      if ("remoteIp" in patch) {
        next.remoteIp = patch.remoteIp;
      }
      if ("lastSeenAtMs" in patch) {
        next.lastSeenAtMs = patch.lastSeenAtMs;
      }
      if ("lastSeenReason" in patch) {
        next.lastSeenReason = patch.lastSeenReason;
      }
      state.pairedByDeviceId[normalizedDeviceId] = next;
      persist("paired");
      return true;
    });
  });
}

/** Update paired-device presence only while the authenticated node generation still owns it. */
export async function updatePairedDevicePresence(
  deviceId: string,
  patch: { lastSeenAtMs: number; lastSeenReason: string },
  expectedPairingGeneration: NodePairingGeneration,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const updated = updatePairedDevicePresenceInTransaction<boolean>(
      deviceId,
      baseDir,
      (device) => {
        const currentPairingGeneration = resolveNodePairingGeneration(device);
        if (
          !device ||
          expectedPairingGeneration.nodeId !== device.deviceId ||
          currentPairingGeneration?.key !== expectedPairingGeneration.key
        ) {
          return { value: false, persist: false };
        }
        return {
          value: true,
          persist: true,
          lastSeenAtMs: patch.lastSeenAtMs,
          lastSeenReason: patch.lastSeenReason,
        };
      },
    );
    // The row-scoped transaction owns cross-process generation validation. Keep
    // the outer lock so local full-snapshot writers cannot replay older presence.
    return updated;
  });
}
