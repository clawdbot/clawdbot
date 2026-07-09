// Node capability-surface approvals, stored on paired device records.
// Device pairing (device-pairing.ts) owns connection auth; this module owns
// which capabilities/commands an operator approved for a node-role device
// (node command gating). Both share the devices store and its lock through
// withPairedDeviceRecords. The former standalone nodes/{pending,paired}.json
// store and its per-node token were retired; state-migrations.ts folds old
// rows into device records once.
import { randomUUID } from "node:crypto";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import {
  withPairedDeviceRecords,
  type PairedDevice,
  type PairedDevicePendingNodeSurface,
} from "./device-pairing.js";
import { type NodeApprovalScope, resolveNodePairApprovalScopes } from "./node-pairing-authz.js";
import { sameNodeApprovalSurfaceSet, sameNodePermissionSurface } from "./node-pairing-surface.js";

type NodeDeclaredSurface = {
  nodeId: string;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
};

/** Node-declared pairing surface before approval. */
export type NodePairingRequestInput = NodeDeclaredSurface & {
  silent?: boolean;
};

/** Pending node pairing request awaiting operator approval. */
export type NodePairingPendingRequest = NodePairingRequestInput & {
  requestId: string;
  silent?: boolean;
  ts: number;
};

export type NodePairingPendingSnapshot = Pick<NodePairingPendingRequest, "requestId" | "nodeId"> & {
  revision?: string;
};

/** Opaque claim preventing approval while a reconnect resolves stale pending state. */
export type NodePairingCleanupClaim = {
  baseDir: string | undefined;
  generation: number;
  nodeId: string;
  observed: NodePairingPendingSnapshot;
};

/** Pending request summary returned when a new approval surface supersedes older requests. */
export type NodePairingSupersededRequest = Pick<NodePairingPendingRequest, "requestId" | "nodeId">;

/** Result for creating or refreshing a pending node pairing request. */
export type RequestNodePairingResult = {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
  superseded?: NodePairingSupersededRequest[];
};

type NodePairingPendingEntry = NodePairingPendingRequest & {
  requiredApproveScopes: NodeApprovalScope[];
};

/** Approved node record projected from the device's node surface (no auth material). */
export type NodePairingPairedNode = NodeDeclaredSurface & {
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type NodePairingList = {
  pending: NodePairingPendingEntry[];
  paired: NodePairingPairedNode[];
};

const OPERATOR_ROLE = "operator";

const activeCleanupRevisionClaims = new Map<string, Set<number>>();
let nextCleanupClaimGeneration = 0;

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function nodeSurfaceDevice(
  pairedByDeviceId: Record<string, PairedDevice>,
  nodeId: string,
): PairedDevice | null {
  return pairedByDeviceId[normalizeNodeId(nodeId)] ?? null;
}

function toPublicPendingRequest(
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): NodePairingPendingRequest {
  return {
    requestId: pending.requestId,
    nodeId: device.deviceId,
    clientId: pending.clientId ?? device.clientId,
    clientMode: pending.clientMode ?? device.clientMode,
    displayName: pending.displayName ?? device.displayName,
    platform: pending.platform ?? device.platform,
    version: pending.version,
    coreVersion: pending.coreVersion,
    uiVersion: pending.uiVersion,
    deviceFamily: pending.deviceFamily ?? device.deviceFamily,
    modelIdentifier: pending.modelIdentifier,
    caps: pending.caps,
    commands: pending.commands,
    permissions: pending.permissions,
    remoteIp: pending.remoteIp ?? device.remoteIp,
    silent: pending.silent,
    ts: pending.ts,
  };
}

function toPendingSnapshot(
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): NodePairingPendingSnapshot {
  return {
    requestId: pending.requestId,
    nodeId: device.deviceId,
    ...(pending.revision ? { revision: pending.revision } : {}),
  };
}

function toPendingEntry(
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): NodePairingPendingEntry {
  return {
    ...toPublicPendingRequest(device, pending),
    requiredApproveScopes: resolveNodePairApprovalScopes(pending.commands ?? []),
  };
}

function toPairedNode(device: PairedDevice): NodePairingPairedNode | null {
  const surface = device.nodeSurface;
  if (!surface) {
    return null;
  }
  return {
    nodeId: device.deviceId,
    clientId: device.clientId,
    clientMode: device.clientMode,
    // The surface name is the operator-facing node name (approval snapshot or
    // node.rename); reconnect metadata refreshes only touch the device name.
    displayName: surface.displayName ?? device.displayName,
    platform: device.platform,
    version: surface.version,
    coreVersion: surface.coreVersion,
    uiVersion: surface.uiVersion,
    deviceFamily: device.deviceFamily,
    modelIdentifier: surface.modelIdentifier,
    caps: surface.caps,
    commands: surface.commands,
    permissions: surface.permissions,
    remoteIp: device.remoteIp,
    bins: surface.bins,
    createdAtMs: surface.createdAtMs,
    approvedAtMs: surface.approvedAtMs,
    lastConnectedAtMs: surface.lastConnectedAtMs,
    lastSeenAtMs: device.lastSeenAtMs,
    lastSeenReason: device.lastSeenReason,
  };
}

function buildPendingNodeSurface(params: {
  req: NodePairingRequestInput;
}): PairedDevicePendingNodeSurface {
  return {
    requestId: randomUUID(),
    revision: randomUUID(),
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    displayName: params.req.displayName,
    platform: params.req.platform,
    version: params.req.version,
    coreVersion: params.req.coreVersion,
    uiVersion: params.req.uiVersion,
    deviceFamily: params.req.deviceFamily,
    modelIdentifier: params.req.modelIdentifier,
    caps: normalizeArrayBackedTrimmedStringList(params.req.caps),
    commands: normalizeArrayBackedTrimmedStringList(params.req.commands),
    permissions: params.req.permissions,
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    ts: Date.now(),
  };
}

function refreshPendingNodeSurface(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
): PairedDevicePendingNodeSurface {
  return {
    ...existing,
    revision: randomUUID(),
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    version: incoming.version ?? existing.version,
    coreVersion: incoming.coreVersion ?? existing.coreVersion,
    uiVersion: incoming.uiVersion ?? existing.uiVersion,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: incoming.modelIdentifier ?? existing.modelIdentifier,
    caps: normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps,
    commands: normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands,
    permissions: incoming.permissions ?? existing.permissions,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // Preserve interactive visibility if either request needs attention.
    silent: Boolean(existing.silent && incoming.silent),
    ts: Date.now(),
  };
}

function samePendingApprovalSurface(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
): boolean {
  const incomingCaps = normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps;
  const incomingCommands =
    normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands;
  const incomingPermissions = incoming.permissions ?? existing.permissions;
  return (
    // Metadata-only reconnects may refresh one pending request; approval-surface changes supersede.
    sameNodeApprovalSurfaceSet(existing.caps, incomingCaps) &&
    sameNodeApprovalSurfaceSet(existing.commands, incomingCommands) &&
    sameNodePermissionSurface(existing.permissions, incomingPermissions)
  );
}

function samePendingReconnectMetadata(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
): boolean {
  return (
    (incoming.clientId ?? existing.clientId) === existing.clientId &&
    (incoming.clientMode ?? existing.clientMode) === existing.clientMode &&
    (incoming.displayName ?? existing.displayName) === existing.displayName &&
    (incoming.platform ?? existing.platform) === existing.platform &&
    (incoming.version ?? existing.version) === existing.version &&
    (incoming.coreVersion ?? existing.coreVersion) === existing.coreVersion &&
    (incoming.uiVersion ?? existing.uiVersion) === existing.uiVersion &&
    (incoming.deviceFamily ?? existing.deviceFamily) === existing.deviceFamily &&
    (incoming.modelIdentifier ?? existing.modelIdentifier) === existing.modelIdentifier &&
    (incoming.remoteIp ?? existing.remoteIp) === existing.remoteIp &&
    Boolean(existing.silent && incoming.silent) === Boolean(existing.silent)
  );
}

function buildCleanupRevisionClaimKey(
  baseDir: string | undefined,
  observed: NodePairingPendingSnapshot,
): string {
  return `${baseDir ?? ""}\0${observed.nodeId}\0${observed.requestId}\0${observed.revision ?? ""}`;
}

function addCleanupClaim(claim: NodePairingCleanupClaim): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  const generations = activeCleanupRevisionClaims.get(key) ?? new Set<number>();
  generations.add(claim.generation);
  activeCleanupRevisionClaims.set(key, generations);
}

function cleanupClaimIsActive(claim: NodePairingCleanupClaim): boolean {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  return activeCleanupRevisionClaims.get(key)?.has(claim.generation) === true;
}

function removeCleanupClaim(claim: NodePairingCleanupClaim): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  const generations = activeCleanupRevisionClaims.get(key);
  generations?.delete(claim.generation);
  if (!generations || generations.size === 0) {
    activeCleanupRevisionClaims.delete(key);
  }
}

function invalidateCleanupClaimsThrough(
  claim: NodePairingCleanupClaim,
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, toPendingSnapshot(device, pending));
  const generations = activeCleanupRevisionClaims.get(key);
  if (!generations) {
    return;
  }
  for (const generation of generations) {
    if (generation <= claim.generation) {
      generations.delete(generation);
    }
  }
  if (generations.size === 0) {
    activeCleanupRevisionClaims.delete(key);
  }
}

function pendingHasActiveCleanupClaim(
  baseDir: string | undefined,
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): boolean {
  const key = buildCleanupRevisionClaimKey(baseDir, toPendingSnapshot(device, pending));
  return (activeCleanupRevisionClaims.get(key)?.size ?? 0) > 0;
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const pending: NodePairingPendingEntry[] = [];
    const paired: NodePairingPairedNode[] = [];
    for (const device of Object.values(pairedByDeviceId)) {
      if (device.pendingNodeSurface) {
        pending.push(toPendingEntry(device, device.pendingNodeSurface));
      }
      const node = toPairedNode(device);
      if (node) {
        paired.push(node);
      }
    }
    pending.sort((a, b) => b.ts - a.ts);
    paired.sort((a, b) => b.approvedAtMs - a.approvedAtMs);
    return { value: { pending, paired }, persist: false };
  });
}

/** Snapshot pairing state and claim current pending revisions for one paired reconnect. */
export async function beginNodePairingConnect(
  nodeId: string,
  baseDir?: string,
): Promise<{
  pairedNode: NodePairingPairedNode | null;
  cleanupClaim?: NodePairingCleanupClaim;
}> {
  return await withPairedDeviceRecords<{
    pairedNode: NodePairingPairedNode | null;
    cleanupClaim?: NodePairingCleanupClaim;
  }>(baseDir, (pairedByDeviceId) => {
    const device = nodeSurfaceDevice(pairedByDeviceId, nodeId);
    const pairedNode = device ? toPairedNode(device) : null;
    const pending = device?.pendingNodeSurface;
    if (!device || !pairedNode || !pending) {
      return { value: { pairedNode }, persist: false };
    }
    const claim: NodePairingCleanupClaim = {
      baseDir,
      generation: ++nextCleanupClaimGeneration,
      nodeId: device.deviceId,
      observed: toPendingSnapshot(device, pending),
    };
    addCleanupClaim(claim);
    return { value: { pairedNode, cleanupClaim: claim }, persist: false };
  });
}

/** Release a reconnect cleanup claim without changing pending pairing state. */
export async function releaseNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<void> {
  removeCleanupClaim(claim);
}

/** Delete pending revisions claimed by a reconnect after hello succeeds. */
export async function finalizeNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<NodePairingSupersededRequest[]> {
  if (!cleanupClaimIsActive(claim)) {
    return [];
  }
  try {
    return await withPairedDeviceRecords(claim.baseDir, (pairedByDeviceId) => {
      const device = nodeSurfaceDevice(pairedByDeviceId, claim.nodeId);
      const pending = device?.pendingNodeSurface;
      if (!device || !pending) {
        return { value: [], persist: false };
      }
      if (
        claim.observed.requestId !== pending.requestId ||
        claim.observed.revision !== pending.revision
      ) {
        return { value: [], persist: false };
      }
      delete device.pendingNodeSurface;
      return {
        value: [{ requestId: pending.requestId, nodeId: device.deviceId }],
        persist: true,
      };
    });
  } finally {
    removeCleanupClaim(claim);
  }
}

/** Create or refresh the pending node-surface request for operator approval. */
export async function requestNodePairing(
  req: NodePairingRequestInput,
  baseDir?: string,
): Promise<RequestNodePairingResult> {
  const nodeId = normalizeNodeId(req.nodeId);
  if (!nodeId) {
    throw new Error("nodeId required");
  }
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = nodeSurfaceDevice(pairedByDeviceId, nodeId);
    if (!device) {
      // Node surface approvals attach to paired devices; connect paths always
      // complete device pairing before requesting a surface, so a missing
      // record means the caller skipped the auth handshake.
      throw new Error("node pairing requires a paired device");
    }
    const existing = device.pendingNodeSurface;
    if (existing && samePendingApprovalSurface(existing, { ...req, nodeId })) {
      const refreshed = refreshPendingNodeSurface(existing, req);
      device.pendingNodeSurface = refreshed;
      return {
        value: {
          status: "pending" as const,
          request: toPublicPendingRequest(device, refreshed),
          created: false,
        },
        persist: true,
      };
    }
    const replacement = buildPendingNodeSurface({ req: { ...req, nodeId } });
    device.pendingNodeSurface = replacement;
    const superseded = existing ? [{ requestId: existing.requestId, nodeId }] : [];
    const result: RequestNodePairingResult = {
      status: "pending",
      request: toPublicPendingRequest(device, replacement),
      created: true,
      ...(superseded.length > 0 ? { superseded } : {}),
    };
    return { value: result, persist: true };
  });
}

/** Reuse an unchanged reconnect request without refreshing or writing pairing state. */
export async function reusePendingNodePairingForReconnect(
  req: NodePairingRequestInput,
  cleanupClaim: NodePairingCleanupClaim | undefined,
  baseDir?: string,
): Promise<RequestNodePairingResult | null> {
  const nodeId = normalizeNodeId(req.nodeId);
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = nodeSurfaceDevice(pairedByDeviceId, nodeId);
    const pending = device?.pendingNodeSurface;
    if (
      device &&
      pending &&
      samePendingApprovalSurface(pending, { ...req, nodeId }) &&
      samePendingReconnectMetadata(pending, req)
    ) {
      // The unchanged reconnect supersedes older cleanup ownership without
      // refreshing the request or writing pairing state.
      if (cleanupClaim) {
        invalidateCleanupClaimsThrough(cleanupClaim, device, pending);
      }
      return {
        value: {
          status: "pending" as const,
          request: toPublicPendingRequest(device, pending),
          created: false,
        },
        persist: false,
      };
    }
    return { value: null, persist: false };
  });
}

type ApprovedNodePairingResult = { requestId: string; node: NodePairingPairedNode };
type ForbiddenNodePairingResult = { status: "forbidden"; missingScope: string };
type ApproveNodePairingResult = ApprovedNodePairingResult | ForbiddenNodePairingResult | null;

/** Approve a pending node request when caller scopes cover the requested command surface. */
export async function approveNodePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveNodePairingResult> {
  return await withPairedDeviceRecords<ApproveNodePairingResult>(baseDir, (pairedByDeviceId) => {
    const device = Object.values(pairedByDeviceId).find(
      (entry) => entry.pendingNodeSurface?.requestId === requestId,
    );
    const pending = device?.pendingNodeSurface;
    if (!device || !pending) {
      return { value: null, persist: false };
    }
    // A paired reconnect has atomically observed this revision as stale.
    // Approval can resume if the handshake fails and releases its claim.
    if (pendingHasActiveCleanupClaim(baseDir, device, pending)) {
      return { value: null, persist: false };
    }
    const requiredScopes = resolveNodePairApprovalScopes(pending.commands ?? []);
    const missingScope = resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: requiredScopes,
      allowedScopes: options.callerScopes ?? [],
    });
    if (missingScope) {
      return { value: { status: "forbidden" as const, missingScope }, persist: false };
    }

    const now = Date.now();
    device.nodeSurface = {
      displayName: pending.displayName,
      version: pending.version,
      coreVersion: pending.coreVersion,
      uiVersion: pending.uiVersion,
      modelIdentifier: pending.modelIdentifier,
      caps: pending.caps,
      commands: pending.commands,
      permissions: pending.permissions,
      bins: device.nodeSurface?.bins,
      createdAtMs: device.nodeSurface?.createdAtMs ?? now,
      approvedAtMs: now,
      lastConnectedAtMs: device.nodeSurface?.lastConnectedAtMs,
    };
    delete device.pendingNodeSurface;
    const node = toPairedNode(device);
    if (!node) {
      return { value: null, persist: false };
    }
    return { value: { requestId, node }, persist: true };
  });
}

/** Reject a pending node pairing request. */
export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = Object.values(pairedByDeviceId).find(
      (entry) => entry.pendingNodeSurface?.requestId === requestId,
    );
    if (!device) {
      return { value: null, persist: false };
    }
    delete device.pendingNodeSurface;
    return { value: { requestId, nodeId: device.deviceId }, persist: true };
  });
}

/** Update runtime node-surface metadata (connect stamps, remote skill bins). */
export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: { lastConnectedAtMs?: number; bins?: string[] },
  baseDir?: string,
): Promise<boolean> {
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = nodeSurfaceDevice(pairedByDeviceId, nodeId);
    if (!device?.nodeSurface) {
      return { value: false, persist: false };
    }
    device.nodeSurface = {
      ...device.nodeSurface,
      ...(patch.lastConnectedAtMs !== undefined
        ? { lastConnectedAtMs: patch.lastConnectedAtMs }
        : {}),
      ...(patch.bins !== undefined ? { bins: patch.bins } : {}),
    };
    return { value: true, persist: true };
  });
}

/** Rename a paired node display name while preserving approval metadata. */
export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const trimmed = displayName.trim();
  if (!trimmed) {
    throw new Error("displayName required");
  }
  return await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = nodeSurfaceDevice(pairedByDeviceId, nodeId);
    if (!device?.nodeSurface) {
      return { value: null, persist: false };
    }
    device.nodeSurface = { ...device.nodeSurface, displayName: trimmed };
    return { value: toPairedNode(device), persist: true };
  });
}
