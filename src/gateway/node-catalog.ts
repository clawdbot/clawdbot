// Gateway node catalog builder.
// Merges paired devices, approved node records, and live websocket sessions.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import {
  sameNodeApprovalSurfaceSet,
  sameNodePermissionSurface,
} from "../infra/node-pairing-surface.js";
import type { NodePairingPairedNode, NodePairingPendingRequest } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";

type KnownNodeDevicePairingSource = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type KnownNodeApprovedSource = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type KnownNodePendingSource = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
};

type KnownNodeEntry = {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  pendingNodePairing?: KnownNodePendingSource;
  live?: NodeSession;
  effective: NodeListNode;
};

type KnownNodeCatalog = {
  entriesById: Map<string, KnownNodeEntry>;
};

function uniqueSortedStrings(...items: Array<readonly unknown[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}

// Catalog scalars come from blind-cast pairing records, so coerce every formatter-facing optional
// string scalar to a trimmed string or undefined: a non-string would crash `nodes status`/`nodes
// list` formatters (.trim(), sanitizeTerminalText/stripAnsi). Scalar analog of uniqueSortedStrings.
function firstNormalizedString(...values: unknown[]): string | undefined {
  // Treat a non-string (or empty) higher-priority value as ABSENT and fall through, instead of
  // letting `find` pick the first non-null value and normalize it to undefined — which would
  // suppress a valid lower-priority string. Return the first value that yields a trimmed string.
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

// Blind-cast pairing records can carry a non-string id; a node with no addressable string
// id is unusable and would crash the id-based catalog sort/format, so drop it entirely.
function hasAddressableId(value: unknown): boolean {
  return normalizeOptionalString(value) !== undefined;
}

function buildDevicePairingSource(entry: PairedDevice): KnownNodeDevicePairingSource {
  return {
    nodeId: entry.deviceId,
    displayName: entry.displayName,
    platform: entry.platform,
    clientId: entry.clientId,
    clientMode: entry.clientMode,
    remoteIp: entry.remoteIp,
    approvedAtMs: entry.approvedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
    lastSeenReason: entry.lastSeenReason,
  };
}

function buildApprovedNodeSource(entry: NodePairingPairedNode): KnownNodeApprovedSource {
  return {
    nodeId: entry.nodeId,
    displayName: entry.displayName,
    platform: entry.platform,
    version: entry.version,
    coreVersion: entry.coreVersion,
    uiVersion: entry.uiVersion,
    remoteIp: entry.remoteIp,
    deviceFamily: entry.deviceFamily,
    modelIdentifier: entry.modelIdentifier,
    caps: entry.caps ?? [],
    commands: entry.commands ?? [],
    permissions: entry.permissions,
    approvedAtMs: entry.approvedAtMs,
    lastConnectedAtMs: entry.lastConnectedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
    lastSeenReason: entry.lastSeenReason,
  };
}

function buildPendingNodeSource(entry: NodePairingPendingRequest): KnownNodePendingSource {
  return {
    requestId: entry.requestId,
    nodeId: entry.nodeId,
    displayName: entry.displayName,
    platform: entry.platform,
    version: entry.version,
    coreVersion: entry.coreVersion,
    uiVersion: entry.uiVersion,
    clientId: entry.clientId,
    clientMode: entry.clientMode,
    remoteIp: entry.remoteIp,
    deviceFamily: entry.deviceFamily,
    modelIdentifier: entry.modelIdentifier,
    caps: uniqueSortedStrings(entry.caps),
    commands: uniqueSortedStrings(entry.commands),
    permissions: entry.permissions,
  };
}

function resolveCurrentPendingNodePairing(params: {
  pending?: KnownNodePendingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
}): KnownNodePendingSource | undefined {
  const { pending, nodePairing, live } = params;
  if (!pending || !live) {
    return pending;
  }
  const declaredPermissions =
    !nodePairing && live.declaredPermissions === undefined
      ? pending.permissions
      : live.declaredPermissions;
  return sameNodeApprovalSurfaceSet(pending.caps, live.declaredCaps) &&
    sameNodeApprovalSurfaceSet(pending.commands, live.declaredCommands) &&
    sameNodePermissionSurface(pending.permissions, declaredPermissions)
    ? pending
    : undefined;
}

function resolveEffectiveLastSeen(params: {
  live?: NodeSession;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
}): { lastSeenAtMs?: number; lastSeenReason?: string } {
  // Live connected time is the freshest signal; stored last-seen values fill in
  // disconnected rows without letting stale device-pairing data override nodes.
  const candidates: Array<{ atMs: number; reason?: string }> = [
    params.live?.connectedAtMs ? { atMs: params.live.connectedAtMs, reason: "connect" } : undefined,
    params.nodePairing?.lastSeenAtMs
      ? { atMs: params.nodePairing.lastSeenAtMs, reason: params.nodePairing.lastSeenReason }
      : undefined,
    params.nodePairing?.lastConnectedAtMs
      ? { atMs: params.nodePairing.lastConnectedAtMs, reason: "connect" }
      : undefined,
    params.devicePairing?.lastSeenAtMs
      ? { atMs: params.devicePairing.lastSeenAtMs, reason: params.devicePairing.lastSeenReason }
      : undefined,
  ].filter((entry) => entry !== undefined);
  let newest: { atMs: number; reason?: string } | undefined;
  for (const candidate of candidates) {
    if (!newest || candidate.atMs > newest.atMs) {
      newest = candidate;
    }
  }
  if (!newest) {
    return {};
  }
  return {
    lastSeenAtMs: newest.atMs,
    lastSeenReason: normalizeOptionalString(newest.reason),
  };
}

function buildEffectiveKnownNode(entry: {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  pendingNodePairing?: KnownNodePendingSource;
  live?: NodeSession;
}): NodeListNode {
  const { nodeId, devicePairing, nodePairing, pendingNodePairing, live } = entry;
  const lastSeen = resolveEffectiveLastSeen({ live, devicePairing, nodePairing });
  return {
    nodeId,
    displayName: firstNormalizedString(
      live?.displayName,
      nodePairing?.displayName,
      devicePairing?.displayName,
      pendingNodePairing?.displayName,
    ),
    platform: firstNormalizedString(
      live?.platform,
      nodePairing?.platform,
      devicePairing?.platform,
      pendingNodePairing?.platform,
    ),
    version: firstNormalizedString(
      live?.version,
      nodePairing?.version,
      pendingNodePairing?.version,
    ),
    coreVersion: firstNormalizedString(
      live?.coreVersion,
      nodePairing?.coreVersion,
      pendingNodePairing?.coreVersion,
    ),
    uiVersion: firstNormalizedString(
      live?.uiVersion,
      nodePairing?.uiVersion,
      pendingNodePairing?.uiVersion,
    ),
    clientId: firstNormalizedString(
      live?.clientId,
      devicePairing?.clientId,
      pendingNodePairing?.clientId,
    ),
    clientMode: firstNormalizedString(
      live?.clientMode,
      devicePairing?.clientMode,
      pendingNodePairing?.clientMode,
    ),
    deviceFamily: firstNormalizedString(
      live?.deviceFamily,
      nodePairing?.deviceFamily,
      pendingNodePairing?.deviceFamily,
    ),
    modelIdentifier: firstNormalizedString(
      live?.modelIdentifier,
      nodePairing?.modelIdentifier,
      pendingNodePairing?.modelIdentifier,
    ),
    remoteIp: firstNormalizedString(
      live?.remoteIp,
      nodePairing?.remoteIp,
      devicePairing?.remoteIp,
      pendingNodePairing?.remoteIp,
    ),
    caps: live ? uniqueSortedStrings(live.caps) : uniqueSortedStrings(nodePairing?.caps),
    commands: live
      ? uniqueSortedStrings(live.commands)
      : uniqueSortedStrings(nodePairing?.commands),
    nodePluginTools: live?.nodePluginTools,
    pathEnv: live?.pathEnv,
    permissions: live?.permissions ?? nodePairing?.permissions,
    approvalState: pendingNodePairing
      ? nodePairing
        ? "pending-reapproval"
        : "pending-approval"
      : nodePairing
        ? "approved"
        : "unapproved",
    pendingRequestId: pendingNodePairing?.requestId,
    pendingDeclaredCaps: pendingNodePairing?.caps,
    pendingDeclaredCommands: pendingNodePairing?.commands,
    pendingDeclaredPermissions: pendingNodePairing?.permissions,
    connectedAtMs: live?.connectedAtMs,
    lastActiveAtMs: live?.lastActiveAtMs,
    presenceUpdatedAtMs: live?.presenceUpdatedAtMs,
    lastSeenAtMs: lastSeen.lastSeenAtMs,
    lastSeenReason: lastSeen.lastSeenReason,
    approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
    paired: Boolean(devicePairing ?? nodePairing),
    connected: Boolean(live),
  };
}

function compareKnownNodes(left: NodeListNode, right: NodeListNode): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const leftName = normalizeLowercaseStringOrEmpty(left.displayName ?? left.nodeId);
  const rightName = normalizeLowercaseStringOrEmpty(right.displayName ?? right.nodeId);
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

/** Builds a node catalog keyed by node id from pairing stores and live sessions. */
export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  pairedNodes?: readonly NodePairingPairedNode[];
  pendingNodes?: readonly NodePairingPendingRequest[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  const devicePairingById = new Map(
    params.pairedDevices
      .filter(
        (entry) => hasAddressableId(entry.deviceId) && hasEffectivePairedDeviceRole(entry, "node"),
      )
      .map((entry) => [entry.deviceId, buildDevicePairingSource(entry)]),
  );
  const nodePairingById = new Map(
    (params.pairedNodes ?? [])
      .filter((entry) => hasAddressableId(entry.nodeId))
      .map((entry) => [entry.nodeId, buildApprovedNodeSource(entry)]),
  );
  const pendingNodePairingById = new Map<string, KnownNodePendingSource>();
  // listNodePairing returns newest requests first; keep the current approval action per node.
  for (const entry of params.pendingNodes ?? []) {
    if (!hasAddressableId(entry.nodeId)) {
      continue;
    }
    if (!pendingNodePairingById.has(entry.nodeId)) {
      pendingNodePairingById.set(entry.nodeId, buildPendingNodeSource(entry));
    }
  }
  const liveById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
  const nodeIds = new Set<string>([
    ...devicePairingById.keys(),
    ...nodePairingById.keys(),
    ...pendingNodePairingById.keys(),
    ...liveById.keys(),
  ]);
  const entriesById = new Map<string, KnownNodeEntry>();
  for (const nodeId of nodeIds) {
    const devicePairing = devicePairingById.get(nodeId);
    const nodePairing = nodePairingById.get(nodeId);
    const live = liveById.get(nodeId);
    const pendingNodePairing = resolveCurrentPendingNodePairing({
      pending: pendingNodePairingById.get(nodeId),
      nodePairing,
      live,
    });
    entriesById.set(nodeId, {
      nodeId,
      devicePairing,
      nodePairing,
      pendingNodePairing,
      live,
      effective: buildEffectiveKnownNode({
        nodeId,
        devicePairing,
        nodePairing,
        pendingNodePairing,
        live,
      }),
    });
  }
  return { entriesById };
}

/** Lists known nodes with connected nodes first and deterministic display ordering. */
export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.entriesById.values()]
    .map((entry) => entry.effective)
    .toSorted(compareKnownNodes);
}

/** Returns the merged catalog entry for diagnostics that need source details. */
export function getKnownNodeEntry(
  catalog: KnownNodeCatalog,
  nodeId: string,
): KnownNodeEntry | null {
  return catalog.entriesById.get(nodeId) ?? null;
}

/** Returns the effective node row shown to gateway clients. */
export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
