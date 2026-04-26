import { randomUUID } from "node:crypto";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import { normalizeArrayBackedTrimmedStringList } from "../shared/string-normalization.js";
import { type NodeApprovalScope, resolveNodePairApprovalScopes } from "./node-pairing-authz.js";
import {
  createAsyncLock,
  pruneExpiredPending,
  readDurableJsonFile,
  reconcilePendingPairingRequests,
  resolvePairingPaths,
  writeJsonAtomic,
} from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

export type NodeDeclaredSurface = {
  nodeId: string;
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

export type NodeApprovedSurface = NodeDeclaredSurface;

export type NodePairingRequestInput = NodeDeclaredSurface & {
  silent?: boolean;
};

export type NodePairingPendingRequest = NodePairingRequestInput & {
  requestId: string;
  silent?: boolean;
  ts: number;
};

export type NodePairingPendingEntry = NodePairingPendingRequest & {
  requiredApproveScopes: NodeApprovalScope[];
};

export type NodePairingPairedNode = NodeApprovedSurface & {
  token: string;
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
};

export type NodePairingList = {
  pending: NodePairingPendingEntry[];
  paired: NodePairingPairedNode[];
};

type NodePairingStateFile = {
  pendingById: Record<string, NodePairingPendingRequest>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ROLE = "operator";

const withLock = createAsyncLock();

function buildPendingNodePairingRequest(params: {
  requestId?: string;
  req: NodePairingRequestInput;
}): NodePairingPendingRequest {
  return {
    requestId: params.requestId ?? randomUUID(),
    nodeId: params.req.nodeId,
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

function refreshPendingNodePairingRequest(
  existing: NodePairingPendingRequest,
  incoming: NodePairingRequestInput,
): NodePairingPendingRequest {
  return {
    ...existing,
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

function resolveNodeApprovalRequiredScopes(
  pending: NodePairingPendingRequest,
): NodeApprovalScope[] {
  const commands = Array.isArray(pending.commands) ? pending.commands : [];
  return resolveNodePairApprovalScopes(commands);
}

function toPendingNodePairingEntry(pending: NodePairingPendingRequest): NodePairingPendingEntry {
  return {
    ...pending,
    requiredApproveScopes: resolveNodeApprovalRequiredScopes(pending),
  };
}

type ApprovedNodePairingResult = { requestId: string; node: NodePairingPairedNode };
type ForbiddenNodePairingResult = { status: "forbidden"; missingScope: string };
type ApproveNodePairingResult = ApprovedNodePairingResult | ForbiddenNodePairingResult | null;

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  const [pending, paired] = await Promise.all([
    readDurableJsonFile<Record<string, NodePairingPendingRequest>>(pendingPath),
    readDurableJsonFile<Record<string, NodePairingPairedNode>>(pairedPath),
  ]);
  const state: NodePairingStateFile = {
    pendingById: pending ?? {},
    pairedByNodeId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  await Promise.all([
    writeJsonAtomic(pendingPath, state.pendingById),
    writeJsonAtomic(pairedPath, state.pairedByNodeId),
  ]);
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return generatePairingToken();
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById)
    .toSorted((a, b) => b.ts - a.ts)
    .map(toPendingNodePairingEntry);
  const paired = Object.values(state.pairedByNodeId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedNode(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const state = await loadState(baseDir);
  return state.pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}

export async function requestNodePairing(
  req: NodePairingRequestInput,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      throw new Error("nodeId required");
    }
    const pendingForNode = Object.values(state.pendingById)
      .filter((pending) => pending.nodeId === nodeId)
      .toSorted((left, right) => right.ts - left.ts);
    return await reconcilePendingPairingRequests({
      pendingById: state.pendingById,
      existing: pendingForNode,
      incoming: {
        ...req,
        nodeId,
      },
      canRefreshSingle: () => true,
      refreshSingle: (existing, incoming) => refreshPendingNodePairingRequest(existing, incoming),
      buildReplacement: ({ existing, incoming }) =>
        buildPendingNodePairingRequest({
          req: {
            ...incoming,
            silent: Boolean(
              incoming.silent && existing.every((pending) => pending.silent === true),
            ),
          },
        }),
      persist: async () => await persistState(state, baseDir),
    });
  });
}

export async function approveNodePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveNodePairingResult> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requiredScopes = resolveNodeApprovalRequiredScopes(pending);
    const missingScope = resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: requiredScopes,
      allowedScopes: options.callerScopes ?? [],
    });
    if (missingScope) {
      return { status: "forbidden", missingScope };
    }

    const now = Date.now();
    const existing = state.pairedByNodeId[pending.nodeId];
    const node: NodePairingPairedNode = {
      nodeId: pending.nodeId,
      token: newToken(),
      displayName: pending.displayName,
      platform: pending.platform,
      version: pending.version,
      coreVersion: pending.coreVersion,
      uiVersion: pending.uiVersion,
      deviceFamily: pending.deviceFamily,
      modelIdentifier: pending.modelIdentifier,
      caps: pending.caps,
      commands: pending.commands,
      permissions: pending.permissions,
      remoteIp: pending.remoteIp,
      createdAtMs: existing?.createdAtMs ?? now,
      approvedAtMs: now,
    };

    delete state.pendingById[requestId];
    state.pairedByNodeId[pending.nodeId] = node;
    await persistState(state, baseDir);
    return { requestId, node };
  });
}

export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return await withLock(async () => {
    return await rejectPendingPairingRequest<
      NodePairingPendingRequest,
      NodePairingStateFile,
      "nodeId"
    >({
      requestId,
      idKey: "nodeId",
      loadState: () => loadState(baseDir),
      persistState: (state) => persistState(state, baseDir),
      getId: (pending: NodePairingPendingRequest) => pending.nodeId,
    });
  });
}

export async function verifyNodeToken(
  nodeId: string,
  token: string,
  baseDir?: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const state = await loadState(baseDir);
  const normalized = normalizeNodeId(nodeId);
  const node = state.pairedByNodeId[normalized];
  if (!node) {
    return { ok: false };
  }
  return verifyPairingToken(token, node.token) ? { ok: true, node } : { ok: false };
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
) {
  await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return;
    }

    const next: NodePairingPairedNode = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      platform: patch.platform ?? existing.platform,
      version: patch.version ?? existing.version,
      coreVersion: patch.coreVersion ?? existing.coreVersion,
      uiVersion: patch.uiVersion ?? existing.uiVersion,
      deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
      modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
      remoteIp: patch.remoteIp ?? existing.remoteIp,
      caps: patch.caps ?? existing.caps,
      commands: patch.commands ?? existing.commands,
      bins: patch.bins ?? existing.bins,
      permissions: patch.permissions ?? existing.permissions,
      lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
    };

    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
  });
}

export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("displayName required");
    }
    const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return next;
  });
}
