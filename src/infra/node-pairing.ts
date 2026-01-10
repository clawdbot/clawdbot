import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type NodePairingPendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type NodePairingPairedNode = {
  nodeId: string;
  token: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  createdAtMs: number;
  approvedAtMs: number;
};

export type NodePairingList = {
  pending: NodePairingPendingRequest[];
  paired: NodePairingPairedNode[];
};

type NodePairingStateFile = {
  pendingById: Record<string, NodePairingPendingRequest>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;

function resolvePaths(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, "nodes");
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSONAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function pruneExpiredPending(
  pendingById: Record<string, NodePairingPendingRequest>,
  nowMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > PENDING_TTL_MS) {
      delete pendingById[id];
    }
  }
}

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release: (() => void) | undefined;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  const [pending, paired] = await Promise.all([
    readJSON<Record<string, NodePairingPendingRequest>>(pendingPath),
    readJSON<Record<string, NodePairingPairedNode>>(pairedPath),
  ]);
  const state: NodePairingStateFile = {
    pendingById: pending ?? {},
    pairedByNodeId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now());
  return state;
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  await Promise.all([
    writeJSONAtomic(pendingPath, state.pendingById),
    writeJSONAtomic(pairedPath, state.pairedByNodeId),
  ]);
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

export async function listNodePairing(
  baseDir?: string,
): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).sort((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByNodeId).sort(
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
  req: Omit<NodePairingPendingRequest, "requestId" | "ts" | "isRepair">,
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

    const existing = Object.values(state.pendingById).find(
      (p) => p.nodeId === nodeId,
    );
    if (existing) {
      return { status: "pending", request: existing, created: false };
    }

    const isRepair = Boolean(state.pairedByNodeId[nodeId]);
    const request: NodePairingPendingRequest = {
      requestId: randomUUID(),
      nodeId,
      displayName: req.displayName,
      platform: req.platform,
      version: req.version,
      deviceFamily: req.deviceFamily,
      modelIdentifier: req.modelIdentifier,
      caps: req.caps,
      commands: req.commands,
      permissions: req.permissions,
      remoteIp: req.remoteIp,
      silent: req.silent,
      isRepair,
      ts: Date.now(),
    };
    state.pendingById[request.requestId] = request;
    await persistState(state, baseDir);
    return { status: "pending", request, created: true };
  });
}

export async function approveNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; node: NodePairingPairedNode } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;

    const now = Date.now();
    const existing = state.pairedByNodeId[pending.nodeId];
    const node: NodePairingPairedNode = {
      nodeId: pending.nodeId,
      token: newToken(),
      displayName: pending.displayName,
      platform: pending.platform,
      version: pending.version,
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
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { requestId, nodeId: pending.nodeId };
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
  if (!node) return { ok: false };
  return node.token === token ? { ok: true, node } : { ok: false };
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<
    Omit<
      NodePairingPairedNode,
      "nodeId" | "token" | "createdAtMs" | "approvedAtMs"
    >
  >,
  baseDir?: string,
) {
  await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) return;

    const next: NodePairingPairedNode = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      platform: patch.platform ?? existing.platform,
      version: patch.version ?? existing.version,
      deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
      modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
      remoteIp: patch.remoteIp ?? existing.remoteIp,
      caps: patch.caps ?? existing.caps,
      commands: patch.commands ?? existing.commands,
      permissions: patch.permissions ?? existing.permissions,
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
    if (!existing) return null;
    const trimmed = displayName.trim();
    if (!trimmed) throw new Error("displayName required");
    const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return next;
  });
}
