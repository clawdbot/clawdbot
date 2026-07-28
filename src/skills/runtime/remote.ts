// Remote skill runtime helpers send skill refresh and snapshot state across remotes.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry, NodeSession } from "../../gateway/node-registry.js";
import { listNodePairing, updatePairedNodeBins } from "../../infra/node-pairing.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";
import type { SkillEligibilityContext } from "../types.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import {
  areBinSetsEqual,
  buildBinProbeScript,
  collectRequiredBins,
  extractErrorMessage,
  isMacPlatform,
  parseBinProbePayload,
  supportsSystemRun,
  supportsSystemWhich,
} from "./remote-probe-utils.js";
import {
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  setRemoteSkillConnectionReconciler,
} from "./remote-skills.js";

type RemoteNodeRecord = {
  nodeId: string;
  connId?: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins: Set<string>;
  pairingGeneration?: string;
  connected: boolean;
  remoteIp?: string;
};

type RemoteNodeProbeState = {
  signature: string;
  pairingGeneration: string;
  nextProbeAfterMs: number;
  failedProbeCount: number;
  bins?: Set<string>;
};

const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = new Map<string, RemoteNodeRecord>();
const remoteNodeProbeStates = new Map<string, RemoteNodeProbeState>();
type RemoteNodeOwner = {
  connId?: string;
  pairingGeneration: string;
};
type RemoteBinProbeInflight = RemoteNodeOwner & {
  promise: Promise<void>;
};

const remoteBinProbeInflight = new Map<string, RemoteBinProbeInflight>();
let remoteRegistry: NodeRegistry | null = null;
const REMOTE_BIN_PROBE_SUCCESS_TTL_MS = 30 * 60 * 1000;
const REMOTE_BIN_PROBE_FAILURE_BASE_BACKOFF_MS = 15_000;
const REMOTE_BIN_PROBE_FAILURE_MAX_BACKOFF_MS = 5 * 60 * 1000;

function describeNode(nodeId: string): string {
  const record = remoteNodes.get(nodeId);
  const name = record?.displayName?.trim();
  const base = name && name !== nodeId ? `${name} (${nodeId})` : nodeId;
  const ip = record?.remoteIp?.trim();
  return ip ? `${base} @ ${ip}` : base;
}

type RemoteBinProbeLogContext = {
  command?: string;
  timeoutMs?: number;
  requiredBinCount?: number;
};

function resolveRemoteBinProbeLogContext(
  nodeId: string,
  context?: RemoteBinProbeLogContext,
): { label: string; details: string } {
  const details = [
    context?.command ? `command=${context.command}` : undefined,
    typeof context?.timeoutMs === "number" ? `timeoutMs=${context.timeoutMs}` : undefined,
    typeof context?.requiredBinCount === "number"
      ? `requiredBins=${context.requiredBinCount}`
      : undefined,
    `connected=${remoteNodes.get(nodeId)?.connected === true ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join(" ");
  return { label: describeNode(nodeId), details };
}

function logRemoteBinProbeFailure(
  nodeId: string,
  err: unknown,
  context?: RemoteBinProbeLogContext,
  phase: "preflight" | "probe" = "probe",
) {
  const message = extractErrorMessage(err);
  const { label, details } = resolveRemoteBinProbeLogContext(nodeId, context);
  if (phase === "preflight") {
    log.info(
      `remote bin probe skipped: node connectivity unavailable (${label}; ${details}): ${
        message ?? "unknown"
      }`,
    );
    return;
  }
  // Node unavailable errors (not connected or disconnected mid-operation) are expected
  // when nodes have transient connections - log at info level instead of warn
  if (message?.includes("node not connected") || message?.includes("node disconnected")) {
    log.info(`remote bin probe skipped: node unavailable (${label}; ${details})`);
    return;
  }
  if (message?.includes("invoke timed out") || message?.includes("timeout")) {
    log.warn(
      `remote bin probe timed out (${label}; ${details}); check node connectivity for ${label}`,
    );
    return;
  }
  log.warn(`remote bin probe error (${label}; ${details}): ${message ?? "unknown"}`);
}

function upsertNode(
  record: {
    nodeId: string;
    connId?: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    commands?: string[];
    remoteIp?: string;
    bins?: string[];
    pairingGeneration?: string;
    connected?: boolean;
  },
  options?: { pairingGenerationAuthoritative?: boolean },
) {
  const existing = remoteNodes.get(record.nodeId);
  const pairingGeneration = options?.pairingGenerationAuthoritative
    ? record.pairingGeneration
    : (record.pairingGeneration ?? existing?.pairingGeneration);
  const pairingGenerationChanged = Boolean(
    options?.pairingGenerationAuthoritative &&
    existing &&
    existing.pairingGeneration !== record.pairingGeneration,
  );
  const bins = new Set<string>(
    record.bins ?? (pairingGenerationChanged ? [] : (existing?.bins ?? [])),
  );
  remoteNodes.set(record.nodeId, {
    nodeId: record.nodeId,
    connId: record.connId ?? existing?.connId,
    displayName: record.displayName ?? existing?.displayName,
    platform: record.platform ?? existing?.platform,
    deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
    commands: record.commands ?? existing?.commands,
    remoteIp: record.remoteIp ?? existing?.remoteIp,
    bins,
    ...(pairingGeneration ? { pairingGeneration } : {}),
    connected: record.connected ?? existing?.connected ?? false,
  });
}

function clearRemoteNodeBins(nodeId: string): boolean {
  const existing = remoteNodes.get(nodeId);
  if (!existing || existing.bins.size === 0) {
    return false;
  }
  existing.bins = new Set();
  return true;
}

function buildRemoteProbeSignature(params: {
  command: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins: string[];
}): string {
  return JSON.stringify([
    params.command,
    normalizeLowercaseStringOrEmpty(params.platform),
    normalizeLowercaseStringOrEmpty(params.deviceFamily),
    [...(params.commands ?? [])].toSorted(),
    params.bins.toSorted(),
  ]);
}

function shouldSkipRemoteNodeProbe(params: {
  state: RemoteNodeProbeState | undefined;
  pairingGeneration: string;
  signature: string;
  nowMs: number;
}): boolean {
  return (
    params.state?.pairingGeneration === params.pairingGeneration &&
    params.state.signature === params.signature &&
    params.nowMs < params.state.nextProbeAfterMs
  );
}

function restoreCachedRemoteNodeBins(nodeId: string): boolean {
  const node = remoteNodes.get(nodeId);
  const state = remoteNodeProbeStates.get(nodeId);
  const cachedBins = state?.bins;
  if (
    !node ||
    state?.pairingGeneration !== node.pairingGeneration ||
    !cachedBins ||
    areBinSetsEqual(node.bins, cachedBins)
  ) {
    return false;
  }
  node.bins = new Set(cachedBins);
  return true;
}

function sameRemoteNodeOwner(left: RemoteNodeOwner, right: RemoteNodeOwner): boolean {
  return left.connId === right.connId && left.pairingGeneration === right.pairingGeneration;
}

function isCurrentRemoteNodeOwner(nodeId: string, owner: RemoteNodeOwner): boolean {
  const current = remoteNodes.get(nodeId);
  return Boolean(
    current &&
    current.pairingGeneration === owner.pairingGeneration &&
    (!owner.connId || !current.connId || current.connId === owner.connId),
  );
}

function markRemoteNodeProbeSuccess(params: {
  nodeId: string;
  owner: RemoteNodeOwner;
  signature: string;
  nowMs: number;
  bins: string[];
}): boolean {
  if (!isCurrentRemoteNodeOwner(params.nodeId, params.owner)) {
    return false;
  }
  remoteNodeProbeStates.set(params.nodeId, {
    signature: params.signature,
    pairingGeneration: params.owner.pairingGeneration,
    nextProbeAfterMs: params.nowMs + REMOTE_BIN_PROBE_SUCCESS_TTL_MS,
    failedProbeCount: 0,
    bins: new Set(params.bins),
  });
  return true;
}

function markRemoteNodeProbeFailure(params: {
  nodeId: string;
  owner: RemoteNodeOwner;
  signature: string;
  nowMs: number;
}): boolean {
  if (!isCurrentRemoteNodeOwner(params.nodeId, params.owner)) {
    return false;
  }
  const existing = remoteNodeProbeStates.get(params.nodeId);
  const failedProbeCount =
    existing?.signature === params.signature ? existing.failedProbeCount + 1 : 1;
  const backoffMs = Math.min(
    REMOTE_BIN_PROBE_FAILURE_MAX_BACKOFF_MS,
    REMOTE_BIN_PROBE_FAILURE_BASE_BACKOFF_MS * 2 ** (failedProbeCount - 1),
  );
  remoteNodeProbeStates.set(params.nodeId, {
    signature: params.signature,
    pairingGeneration: params.owner.pairingGeneration,
    nextProbeAfterMs: params.nowMs + backoffMs,
    failedProbeCount,
  });
  return true;
}

function remoteConnectionKey(nodeId: string, connId: string): string {
  return `${nodeId}\0${connId}`;
}

function listCurrentRemoteSessions(): NodeSession[] {
  return remoteRegistry?.listCurrentConnectedSync() ?? [];
}

function listCurrentRemoteConnectionKeys(): ReadonlySet<string> | undefined {
  if (!remoteRegistry) {
    return undefined;
  }
  return new Set(
    listCurrentRemoteSessions().map((node) => remoteConnectionKey(node.nodeId, node.connId)),
  );
}

export function setSkillsRemoteRegistry(registry: NodeRegistry | null) {
  remoteRegistry = registry;
  setRemoteSkillConnectionReconciler(registry ? () => listCurrentRemoteConnectionKeys() : null);
  if (!registry) {
    remoteNodeProbeStates.clear();
  }
}

export async function primeRemoteSkillsCache() {
  try {
    const { paired } = await listNodePairing(undefined, { includePairingGeneration: true });
    let sawMac = false;
    for (const node of paired) {
      if (!node.pairingGeneration) {
        continue;
      }
      upsertNode(
        {
          nodeId: node.nodeId,
          displayName: node.displayName,
          platform: node.platform,
          deviceFamily: node.deviceFamily,
          commands: node.commands,
          remoteIp: node.remoteIp,
          bins: node.bins,
          pairingGeneration: node.pairingGeneration,
          connected: false,
        },
        { pairingGenerationAuthoritative: true },
      );
      if (
        node.bins &&
        node.bins.length > 0 &&
        isMacPlatform(node.platform, node.deviceFamily) &&
        supportsSystemRun(node.commands)
      ) {
        sawMac = true;
      }
    }
    if (sawMac) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  } catch (err) {
    log.warn(`failed to prime remote skills cache: ${String(err)}`);
  }
}

export function recordRemoteNodeInfo(node: {
  nodeId: string;
  connId?: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  remoteIp?: string;
  pairingGeneration?: string;
}) {
  const existing = remoteNodes.get(node.nodeId);
  const pairingGenerationChanged = Boolean(
    existing && existing.pairingGeneration !== node.pairingGeneration,
  );
  if (
    pairingGenerationChanged ||
    (node.connId &&
      existing?.connId !== node.connId &&
      !remoteNodeProbeStates.get(node.nodeId)?.bins)
  ) {
    remoteNodeProbeStates.delete(node.nodeId);
  }
  upsertNode({ ...node, connected: true }, { pairingGenerationAuthoritative: true });
  recordRemoteSkillNodeInfo({
    nodeId: node.nodeId,
    connId: node.connId,
    displayName: node.displayName,
    commands: node.commands,
  });
}

export function recordRemoteNodeBins(nodeId: string, bins: string[], pairingGeneration: string) {
  upsertNode({ nodeId, bins, pairingGeneration });
}

export function removeRemoteNodeInfo(nodeId: string) {
  const existing = remoteNodes.get(nodeId);
  remoteNodes.delete(nodeId);
  removeRemoteNodeSkills(nodeId);
  const probeState = remoteNodeProbeStates.get(nodeId);
  if (probeState && !probeState.bins) {
    // A new connection is a new recovery opportunity. Keep successful bin
    // snapshots across reconnects, but never carry failure backoff forward.
    remoteNodeProbeStates.delete(nodeId);
  }
  if (
    existing &&
    isMacPlatform(existing.platform, existing.deviceFamily) &&
    supportsSystemRun(existing.commands)
  ) {
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
}

/** Remove remote projections only while they still belong to the invalidated connection. */
export function removeRemoteNodeInfoForConnection(nodeId: string, connId: string): boolean {
  if (remoteNodes.get(nodeId)?.connId !== connId) {
    return false;
  }
  removeRemoteNodeInfo(nodeId);
  return true;
}

export async function refreshRemoteNodeBins(params: {
  nodeId: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  cfg: OpenClawConfig;
  timeoutMs?: number;
  readinessDelayMs?: number;
}) {
  const session = remoteRegistry?.get(params.nodeId);
  if (!session?.pairingGeneration) {
    return;
  }
  const owner: RemoteNodeOwner = {
    connId: session.connId,
    pairingGeneration: session.pairingGeneration,
  };
  const existing = remoteBinProbeInflight.get(params.nodeId);
  if (existing) {
    await existing.promise;
    if (sameRemoteNodeOwner(existing, owner)) {
      return;
    }
  }
  const inflight: RemoteBinProbeInflight = {
    ...owner,
    promise: Promise.resolve(),
  };
  const run = refreshRemoteNodeBinsUncoalesced(params).finally(() => {
    if (remoteBinProbeInflight.get(params.nodeId) === inflight) {
      remoteBinProbeInflight.delete(params.nodeId);
    }
  });
  inflight.promise = run;
  remoteBinProbeInflight.set(params.nodeId, inflight);
  await run;
}

async function refreshRemoteNodeBinsUncoalesced(params: {
  nodeId: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  cfg: OpenClawConfig;
  timeoutMs?: number;
  readinessDelayMs?: number;
}) {
  const readinessDelayMs = params.readinessDelayMs ?? 0;
  if (readinessDelayMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, readinessDelayMs);
    });
  }
  if (!remoteRegistry) {
    return;
  }
  // Pairing can replace the command surface while the connect-time readiness
  // delay is pending. Probe the live session so that approval refresh is not lost.
  const liveSession = remoteRegistry.get(params.nodeId);
  if (!liveSession?.pairingGeneration) {
    return;
  }
  const probeOwner: RemoteNodeOwner = {
    connId: liveSession.connId,
    pairingGeneration: liveSession.pairingGeneration,
  };
  const platform = liveSession?.platform ?? params.platform;
  const deviceFamily = liveSession?.deviceFamily ?? params.deviceFamily;
  const commands = liveSession?.commands ?? params.commands;
  if (!isMacPlatform(platform, deviceFamily)) {
    return;
  }
  const canWhich = supportsSystemWhich(commands);
  const canRun = supportsSystemRun(commands);
  if (!canWhich && !canRun) {
    return;
  }

  const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
  const requiredBins = new Set<string>();
  for (const workspaceDir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
    for (const bin of collectRequiredBins(entries, "darwin")) {
      requiredBins.add(bin);
    }
  }
  if (requiredBins.size === 0) {
    return;
  }

  const binsList = [...requiredBins];
  const timeoutMs = params.timeoutMs ?? 15_000;
  const command = canWhich ? "system.which" : "system.run";
  const probeSignature = buildRemoteProbeSignature({
    command,
    platform,
    deviceFamily,
    commands,
    bins: binsList,
  });
  const nowMs = Date.now();
  if (
    shouldSkipRemoteNodeProbe({
      state: remoteNodeProbeStates.get(params.nodeId),
      pairingGeneration: probeOwner.pairingGeneration,
      signature: probeSignature,
      nowMs,
    })
  ) {
    if (restoreCachedRemoteNodeBins(params.nodeId)) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
    return;
  }
  const logContext = { command, timeoutMs, requiredBinCount: binsList.length };
  const connectivityTimeoutMs = Math.min(timeoutMs, 2_000);
  if (typeof remoteRegistry.checkConnectivity === "function") {
    const preflightConnId = remoteRegistry.get(params.nodeId)?.connId;
    let connectivity: Awaited<ReturnType<typeof remoteRegistry.checkConnectivity>>;
    try {
      connectivity = await remoteRegistry.checkConnectivity(params.nodeId, connectivityTimeoutMs);
    } catch (err) {
      const recorded = markRemoteNodeProbeFailure({
        nodeId: params.nodeId,
        owner: probeOwner,
        signature: probeSignature,
        nowMs: Date.now(),
      });
      if (!recorded) {
        return;
      }
      const cleared = clearRemoteNodeBins(params.nodeId);
      logRemoteBinProbeFailure(
        params.nodeId,
        err,
        {
          command: "websocket.ping",
          timeoutMs: connectivityTimeoutMs,
          requiredBinCount: binsList.length,
        },
        "preflight",
      );
      if (cleared) {
        bumpSkillsSnapshotVersion({ reason: "remote-node" });
      }
      return;
    }
    if (!connectivity.ok) {
      const latestSession = remoteRegistry.get(params.nodeId);
      if (preflightConnId && latestSession && latestSession.connId !== preflightConnId) {
        await refreshRemoteNodeBinsUncoalesced({
          nodeId: latestSession.nodeId,
          platform: latestSession.platform,
          deviceFamily: latestSession.deviceFamily,
          commands: latestSession.commands,
          cfg: params.cfg,
          timeoutMs: params.timeoutMs,
        });
        return;
      }
      const recorded = markRemoteNodeProbeFailure({
        nodeId: params.nodeId,
        owner: probeOwner,
        signature: probeSignature,
        nowMs: Date.now(),
      });
      if (!recorded) {
        return;
      }
      const cleared = clearRemoteNodeBins(params.nodeId);
      logRemoteBinProbeFailure(
        params.nodeId,
        connectivity.error.message,
        {
          command: "websocket.ping",
          timeoutMs: connectivityTimeoutMs,
          requiredBinCount: binsList.length,
        },
        "preflight",
      );
      if (cleared) {
        bumpSkillsSnapshotVersion({ reason: "remote-node" });
      }
      return;
    }
  }
  try {
    const res = await remoteRegistry.invoke(
      canWhich
        ? {
            nodeId: params.nodeId,
            expectedPairingGeneration: probeOwner.pairingGeneration,
            command,
            params: { bins: binsList },
            timeoutMs,
          }
        : {
            nodeId: params.nodeId,
            expectedPairingGeneration: probeOwner.pairingGeneration,
            command,
            params: {
              command: ["/bin/sh", "-lc", buildBinProbeScript(binsList)],
            },
            timeoutMs,
          },
    );
    if (!res.ok) {
      const recorded = markRemoteNodeProbeFailure({
        nodeId: params.nodeId,
        owner: probeOwner,
        signature: probeSignature,
        nowMs: Date.now(),
      });
      if (!recorded) {
        return;
      }
      const cleared = clearRemoteNodeBins(params.nodeId);
      logRemoteBinProbeFailure(params.nodeId, res.error?.message ?? "unknown", logContext);
      if (cleared) {
        bumpSkillsSnapshotVersion({ reason: "remote-node" });
      }
      return;
    }
    const bins = parseBinProbePayload(res.payloadJSON, res.payload);
    if (!isCurrentRemoteNodeOwner(params.nodeId, probeOwner)) {
      return;
    }
    const existingBins = remoteNodes.get(params.nodeId)?.bins;
    const nextBins = new Set(bins);
    const hasChanged = !areBinSetsEqual(existingBins, nextBins);
    if (hasChanged) {
      const persisted = await updatePairedNodeBins(params.nodeId, bins, {
        nodeId: params.nodeId,
        key: probeOwner.pairingGeneration,
      });
      if (!persisted) {
        return;
      }
    }
    const recorded = markRemoteNodeProbeSuccess({
      nodeId: params.nodeId,
      owner: probeOwner,
      signature: probeSignature,
      nowMs: Date.now(),
      bins,
    });
    if (!recorded) {
      return;
    }
    recordRemoteNodeBins(params.nodeId, bins, probeOwner.pairingGeneration);
    if (hasChanged) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  } catch (err) {
    const recorded = markRemoteNodeProbeFailure({
      nodeId: params.nodeId,
      owner: probeOwner,
      signature: probeSignature,
      nowMs: Date.now(),
    });
    if (!recorded) {
      return;
    }
    const cleared = clearRemoteNodeBins(params.nodeId);
    logRemoteBinProbeFailure(params.nodeId, err, logContext);
    if (cleared) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  }
}

export function getRemoteSkillEligibility(options?: {
  advertiseExecNode?: boolean;
}): SkillEligibilityContext["remote"] | undefined {
  const currentConnections = listCurrentRemoteConnectionKeys();
  const macNodes = [...remoteNodes.values()].filter(
    (node) =>
      node.connected &&
      (!currentConnections ||
        (node.connId !== undefined &&
          currentConnections.has(remoteConnectionKey(node.nodeId, node.connId)))) &&
      isMacPlatform(node.platform, node.deviceFamily) &&
      supportsSystemRun(node.commands),
  );
  if (macNodes.length === 0) {
    return undefined;
  }
  const bins = new Set<string>();
  for (const node of macNodes) {
    for (const bin of node.bins) {
      bins.add(bin);
    }
  }
  const labels = macNodes.map((node) => node.displayName ?? node.nodeId).filter(Boolean);
  const note =
    options?.advertiseExecNode === false
      ? undefined
      : labels.length > 0
        ? `Remote macOS node available (${labels.join(", ")}). Run macOS-only skills via exec host=node on that node.`
        : "Remote macOS node available. Run macOS-only skills via exec host=node on that node.";
  return {
    platforms: ["darwin"],
    hasBin: (bin) => bins.has(bin),
    hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
    ...(note ? { note } : {}),
  };
}

export async function refreshRemoteBinsForConnectedNodes(cfg: OpenClawConfig) {
  if (!remoteRegistry) {
    return;
  }
  const connected = listCurrentRemoteSessions();
  for (const node of connected) {
    try {
      await refreshRemoteNodeBins({
        nodeId: node.nodeId,
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
        cfg,
      });
    } catch (err) {
      // A failed node must not abort refreshes for the remaining connected nodes.
      log.warn(`failed to refresh remote bins for ${describeNode(node.nodeId)}: ${String(err)}`);
    }
  }
}
