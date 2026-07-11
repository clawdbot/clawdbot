import type { PresenceEntry } from "../../api/types.ts";
// Builds the unified nodes/devices inventory shown on the Nodes page.
// The gateway exposes two overlapping views of the same machines: paired device
// records (roles + tokens) and the node catalog (caps + live links). This module
// joins them by id and groups duplicate pairings of the same client so the page
// renders one row per machine instead of one row per historical keypair.
import { normalizeOptionalString } from "../string-coerce.ts";
import type { PairedDevice } from "./index.ts";

export type NodeApprovalState =
  | "approved"
  | "pending-approval"
  | "pending-reapproval"
  | "unapproved";

/** Typed projection of one raw `node.list` row. */
export type NodeListEntry = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  modelIdentifier?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  approvalState?: NodeApprovalState;
  pendingRequestId?: string;
  connected: boolean;
  paired: boolean;
  connectedAtMs?: number;
  lastSeenAtMs?: number;
  approvedAtMs?: number;
};

export type NodesInventoryEntry = {
  id: string;
  name: string;
  displayName?: string;
  clientId?: string;
  clientMode?: string;
  platform?: string;
  version?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  roles: string[];
  scopes: string[];
  connected: boolean;
  autoApproved: boolean;
  lastSeenAtMs?: number;
  approvedAtMs?: number;
  presence?: PresenceEntry;
  device?: PairedDevice;
  node?: NodeListEntry;
};

/** One machine cluster: the freshest pairing plus superseded duplicates. */
export type NodesInventoryGroup = {
  key: string;
  name: string;
  primary: NodesInventoryEntry;
  duplicates: NodesInventoryEntry[];
};

const NODE_APPROVAL_STATES: ReadonlySet<string> = new Set([
  "approved",
  "pending-approval",
  "pending-reapproval",
  "unapproved",
]);

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

export function parseNodeListEntry(raw: Record<string, unknown>): NodeListEntry | null {
  const nodeId = normalizeOptionalString(raw.nodeId);
  if (!nodeId) {
    return null;
  }
  const approvalState = normalizeOptionalString(raw.approvalState);
  return {
    nodeId,
    displayName: normalizeOptionalString(raw.displayName),
    platform: normalizeOptionalString(raw.platform),
    version: normalizeOptionalString(raw.version),
    modelIdentifier: normalizeOptionalString(raw.modelIdentifier),
    clientId: normalizeOptionalString(raw.clientId),
    clientMode: normalizeOptionalString(raw.clientMode),
    remoteIp: normalizeOptionalString(raw.remoteIp),
    caps: stringList(raw.caps),
    commands: stringList(raw.commands),
    approvalState:
      approvalState && NODE_APPROVAL_STATES.has(approvalState)
        ? (approvalState as NodeApprovalState)
        : undefined,
    pendingRequestId: normalizeOptionalString(raw.pendingRequestId),
    connected: raw.connected === true,
    paired: raw.paired === true,
    connectedAtMs: optionalNumber(raw.connectedAtMs),
    lastSeenAtMs: optionalNumber(raw.lastSeenAtMs),
    approvedAtMs: optionalNumber(raw.approvedAtMs),
  };
}

function deviceRoles(device: PairedDevice): string[] {
  const roles = new Set<string>();
  for (const role of [...(device.roles ?? []), device.role]) {
    const normalized = normalizeOptionalString(role);
    if (normalized) {
      roles.add(normalized);
    }
  }
  return [...roles];
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (value !== undefined && (max === undefined || value > max)) {
      max = value;
    }
  }
  return max;
}

function buildEntry(
  id: string,
  device?: PairedDevice,
  node?: NodeListEntry,
  presence?: PresenceEntry,
): NodesInventoryEntry {
  const roles = device ? deviceRoles(device) : [];
  if (node?.paired && !roles.includes("node")) {
    // Legacy nodes/paired.json rows have no device record; they are still nodes.
    roles.push("node");
  }
  const operatorLabel = normalizeOptionalString(device?.operatorLabel);
  const displayName =
    normalizeOptionalString(device?.displayName) ?? normalizeOptionalString(node?.displayName);
  const clientId = normalizeOptionalString(device?.clientId) ?? node?.clientId;
  return {
    id,
    // Display precedence: operator label, then client display name, then client id, then device id.
    name: operatorLabel ?? displayName ?? clientId ?? id,
    displayName,
    clientId,
    clientMode: normalizeOptionalString(device?.clientMode) ?? node?.clientMode,
    platform:
      normalizeOptionalString(presence?.platform) ??
      normalizeOptionalString(device?.platform) ??
      node?.platform,
    version: normalizeOptionalString(presence?.version) ?? node?.version,
    modelIdentifier: normalizeOptionalString(presence?.modelIdentifier) ?? node?.modelIdentifier,
    remoteIp: normalizeOptionalString(device?.remoteIp) ?? node?.remoteIp,
    roles,
    scopes: stringList(device?.scopes),
    // Server-computed device/node connectivity accounts for multiple live
    // connections sharing one device id; one disconnect beacon cannot.
    connected: node?.connected === true || device?.connected === true,
    autoApproved:
      device?.approvedVia === "silent" ||
      device?.approvedVia === "trusted-cidr" ||
      device?.approvedVia === "ssh-verified",
    lastSeenAtMs: maxDefined(
      device?.lastSeenAtMs,
      node?.lastSeenAtMs,
      node?.connectedAtMs,
      optionalNumber(presence?.ts),
    ),
    approvedAtMs: maxDefined(device?.approvedAtMs, node?.approvedAtMs),
    presence,
    device,
    node,
  };
}

function groupKey(entry: NodesInventoryEntry): string {
  const name = entry.displayName?.trim().toLowerCase();
  if (name) {
    return `name:${name}`;
  }
  const clientId = entry.clientId?.trim().toLowerCase();
  const clientMode = entry.clientMode?.trim().toLowerCase();
  if (clientId || clientMode) {
    return `client:${clientId ?? ""}:${clientMode ?? ""}`;
  }
  // No usable identity metadata: never merge with other anonymous records.
  return `id:${entry.id}`;
}

function entryRecency(entry: NodesInventoryEntry): number {
  return entry.lastSeenAtMs ?? entry.approvedAtMs ?? 0;
}

function compareEntries(left: NodesInventoryEntry, right: NodesInventoryEntry): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const recency = entryRecency(right) - entryRecency(left);
  if (recency !== 0) {
    return recency;
  }
  return left.id.localeCompare(right.id);
}

function compareGroups(left: NodesInventoryGroup, right: NodesInventoryGroup): number {
  const order = compareEntries(left.primary, right.primary);
  if (order !== 0) {
    return order;
  }
  return left.name.localeCompare(right.name);
}

/** Joins paired devices with node catalog rows and groups duplicate pairings. */
export function buildNodesInventory(params: {
  paired: PairedDevice[];
  nodes: Array<Record<string, unknown>>;
  presence?: PresenceEntry[];
}): NodesInventoryGroup[] {
  const nodesById = new Map<string, NodeListEntry>();
  for (const raw of params.nodes) {
    const node = parseNodeListEntry(raw);
    if (node) {
      nodesById.set(node.nodeId, node);
    }
  }
  const presenceById = new Map<string, PresenceEntry>();
  for (const presence of params.presence ?? []) {
    for (const rawId of [presence.deviceId, presence.instanceId]) {
      const id = normalizeOptionalString(rawId)?.toLowerCase();
      if (id) {
        presenceById.set(id, presence);
      }
    }
  }
  const entries: NodesInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const device of params.paired) {
    const id = normalizeOptionalString(device.deviceId);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    entries.push(buildEntry(id, device, nodesById.get(id), presenceById.get(id.toLowerCase())));
  }
  for (const [id, node] of nodesById) {
    if (!seen.has(id)) {
      entries.push(buildEntry(id, undefined, node, presenceById.get(id.toLowerCase())));
    }
  }

  const groupsByKey = new Map<string, NodesInventoryEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const bucket = groupsByKey.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      groupsByKey.set(key, [entry]);
    }
  }

  const groups: NodesInventoryGroup[] = [];
  for (const [key, bucket] of groupsByKey) {
    const sorted = bucket.toSorted(compareEntries);
    const primary = sorted[0];
    groups.push({
      key,
      name: primary.name,
      primary,
      duplicates: sorted.slice(1),
    });
  }
  return groups.toSorted(compareGroups);
}

/**
 * Duplicate entries safe to bulk-remove: superseded, not currently connected,
 * and either auto-approved (silent local / trusted-CIDR / SSH-verified), so the
 * client re-pairs without user action, or a frozen pre-provenance device row.
 * Owner/QR-approved duplicates keep their per-entry Remove button. Node-only
 * catalog rows are never sweep-eligible without a device pairing record.
 *
 * Deliberate tradeoff: groups key on display metadata because no machine
 * identity survives a key rotation. Two distinct same-named trusted-CIDR
 * machines can therefore land in one group and the offline one may be swept —
 * accepted because the sweep is admin-confirmed and a wrongly removed
 * auto-approved client is re-admitted automatically by the same policy on
 * reconnect. Pre-provenance duplicates cannot be auto-pruned server-side, so
 * the same explicit admin confirmation is their cleanup boundary.
 */
export function listStaleInventoryEntries(groups: NodesInventoryGroup[]): NodesInventoryEntry[] {
  return groups.flatMap((group) =>
    group.duplicates.filter(
      (entry) =>
        !entry.connected &&
        (entry.autoApproved ||
          (entry.device !== undefined && entry.device.approvedVia === undefined)),
    ),
  );
}

/** Returns the Gateway self beacon, when present in the current snapshot. */
export function findGatewayPresence(presence: PresenceEntry[]): PresenceEntry | undefined {
  return presence.find((entry) => normalizeOptionalString(entry.mode)?.toLowerCase() === "gateway");
}

/**
 * Live presence beacons with no pairing or node-catalog row, e.g. clients on
 * shared token/password auth without a device identity. They were visible on
 * the retired Instances page; without this the merged Devices page would hide
 * live connections that the gateway intentionally tracks.
 */
export function listUnpairedPresence(
  presence: PresenceEntry[],
  groups: NodesInventoryGroup[],
): PresenceEntry[] {
  const knownIds = new Set<string>();
  for (const group of groups) {
    for (const entry of [group.primary, ...group.duplicates]) {
      knownIds.add(entry.id.toLowerCase());
    }
  }
  return presence.filter((entry) => {
    if (normalizeOptionalString(entry.mode)?.toLowerCase() === "gateway") {
      return false;
    }
    // Recently disconnected beacons linger for the presence TTL; only live
    // connections earn a row here.
    if (normalizeOptionalString(entry.reason)?.toLowerCase() === "disconnect") {
      return false;
    }
    const ids = [entry.deviceId, entry.instanceId]
      .map((id) => normalizeOptionalString(id)?.toLowerCase())
      .filter((id): id is string => id !== undefined);
    // Text-only system-event beacons carry no client identity; they are notes,
    // not live connections, and would render as bogus "unknown client" rows.
    if (
      ids.length === 0 &&
      !normalizeOptionalString(entry.host) &&
      !normalizeOptionalString(entry.mode)
    ) {
      return false;
    }
    return !ids.some((id) => knownIds.has(id));
  });
}

/** Which pairing stores a removal must touch for this entry. */
export function resolveInventoryRemoval(entry: NodesInventoryEntry): {
  removeNode: boolean;
  removeDevice: boolean;
} {
  const hasNodeRole = entry.roles.includes("node");
  const nonNodeRoles = entry.roles.filter((role) => role !== "node");
  return {
    removeNode: hasNodeRole || entry.node?.paired === true,
    // node.pair.remove deletes node-only device rows itself; only records with
    // other roles (or tokenless records) need the device-level removal too.
    removeDevice: Boolean(entry.device) && (nonNodeRoles.length > 0 || entry.roles.length === 0),
  };
}
