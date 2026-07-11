// Remote skill runtime helpers send skill refresh and snapshot state across remotes.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { listNodePairing, updatePairedNodeMetadata } from "../../infra/node-pairing.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";
import type { SkillEligibilityContext, SkillEntry } from "../types.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import { recordRemoteSkillNodeInfo, removeRemoteNodeSkills } from "./remote-skills.js";

type RemoteNodeRecord = {
  nodeId: string;
  connId?: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins: Set<string>;
  connected: boolean;
  remoteIp?: string;
};

type RemoteNodeProbeState = {
  signature: string;
  nextProbeAfterMs: number;
  failedProbeCount: number;
  bins?: Set<string>;
};

const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = new Map<string, RemoteNodeRecord>();
const remoteNodeProbeStates = new Map<string, RemoteNodeProbeState>();
type RemoteBinProbeInflight = {
  connId?: string;
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

function extractErrorMessage(err: unknown): string | undefined {
  if (!err) {
    return undefined;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.toString();
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return undefined;
    }
  }
  return undefined;
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

function isMacPlatform(platform?: string, deviceFamily?: string): boolean {
  const platformNorm = normalizeLowercaseStringOrEmpty(platform);
  const familyNorm = normalizeLowercaseStringOrEmpty(deviceFamily);
  if (platformNorm.includes("mac")) {
    return true;
  }
  if (platformNorm.includes("darwin")) {
    return true;
  }
  if (familyNorm === "mac") {
    return true;
  }
  return false;
}

function supportsSystemRun(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.run");
}

function supportsSystemWhich(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.which");
}

function upsertNode(record: {
  nodeId: string;
  connId?: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  remoteIp?: string;
  bins?: string[];
  connected?: boolean;
}) {
  const existing = remoteNodes.get(record.nodeId);
  const bins = new Set<string>(record.bins ?? existing?.bins ?? []);
  remoteNodes.set(record.nodeId, {
    nodeId: record.nodeId,
    connId: record.connId ?? existing?.connId,
    displayName: record.displayName ?? existing?.displayName,
    platform: record.platform ?? existing?.platform,
    deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
    commands: record.commands ?? existing?.commands,
    remoteIp: record.remoteIp ?? existing?.remoteIp,
    bins,
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
  signature: string;
  nowMs: number;
}): boolean {
  return (
    params.state?.signature === params.signature && params.nowMs < params.state.nextProbeAfterMs
  );
}

function restoreCachedRemoteNodeBins(nodeId: string): boolean {
  const node = remoteNodes.get(nodeId);
  const cachedBins = remoteNodeProbeStates.get(nodeId)?.bins;
  if (!node || !cachedBins || areBinSetsEqual(node.bins, cachedBins)) {
    return false;
  }
  node.bins = new Set(cachedBins);
  return true;
}

function isCurrentRemoteNodeConnection(nodeId: string, connId?: string): boolean {
  if (!connId) {
    return true;
  }
  const current = remoteNodes.get(nodeId);
  return Boolean(current && (!current.connId || current.connId === connId));
}

function markRemoteNodeProbeSuccess(params: {
  nodeId: string;
  connId?: string;
  signature: string;
  nowMs: number;
  bins: string[];
}): boolean {
  if (!isCurrentRemoteNodeConnection(params.nodeId, params.connId)) {
    return false;
  }
  remoteNodeProbeStates.set(params.nodeId, {
    signature: params.signature,
    nextProbeAfterMs: params.nowMs + REMOTE_BIN_PROBE_SUCCESS_TTL_MS,
    failedProbeCount: 0,
    bins: new Set(params.bins),
  });
  return true;
}

function markRemoteNodeProbeFailure(params: {
  nodeId: string;
  connId?: string;
  signature: string;
  nowMs: number;
}): boolean {
  if (!isCurrentRemoteNodeConnection(params.nodeId, params.connId)) {
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
    nextProbeAfterMs: params.nowMs + backoffMs,
    failedProbeCount,
  });
  return true;
}

export function setSkillsRemoteRegistry(registry: NodeRegistry | null) {
  remoteRegistry = registry;
  if (!registry) {
    remoteNodeProbeStates.clear();
  }
}

export async function primeRemoteSkillsCache() {
  try {
    const list = await listNodePairing();
    let sawMac = false;
    for (const node of list.paired) {
      upsertNode({
        nodeId: node.nodeId,
        displayName: node.displayName,
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
        remoteIp: node.remoteIp,
        bins: node.bins,
        connected: false,
      });
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
}) {
  const existing = remoteNodes.get(node.nodeId);
  if (
    node.connId &&
    existing?.connId !== node.connId &&
    !remoteNodeProbeStates.get(node.nodeId)?.bins
  ) {
    remoteNodeProbeStates.delete(node.nodeId);
  }
  upsertNode({ ...node, connected: true });
  recordRemoteSkillNodeInfo({
    nodeId: node.nodeId,
    connId: node.connId,
    displayName: node.displayName,
    commands: node.commands,
  });
}

export function recordRemoteNodeBins(nodeId: string, bins: string[]) {
  upsertNode({ nodeId, bins });
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

function collectRequiredBins(entries: SkillEntry[], targetPlatform: string): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const os = entry.metadata?.os ?? [];
    if (os.length > 0 && !os.includes(targetPlatform)) {
      continue;
    }
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    for (const bin of required) {
      if (bin.trim()) {
        bins.add(bin.trim());
      }
    }
    for (const bin of anyBins) {
      if (bin.trim()) {
        bins.add(bin.trim());
      }
    }
  }
  return [...bins];
}

function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

function parseBinProbePayload(payloadJSON: string | null | undefined, payload?: unknown): string[] {
  if (!payloadJSON && !payload) {
    return [];
  }
  try {
    const parsed = payloadJSON
      ? (JSON.parse(payloadJSON) as { stdout?: unknown; bins?: unknown })
      : (payload as { stdout?: unknown; bins?: unknown });
    if (Array.isArray(parsed.bins)) {
      return normalizeStringEntries(parsed.bins);
    }
    if (parsed.bins && typeof parsed.bins === "object") {
      return Object.entries(parsed.bins)
        .filter(([, resolvedPath]) => normalizeOptionalString(resolvedPath) !== undefined)
        .map(([bin]) => normalizeOptionalString(bin) ?? "")
        .filter(Boolean);
    }
    if (typeof parsed.stdout === "string") {
      return parsed.stdout
        .split(/\r?\n/)
        .map((line) => normalizeOptionalString(line) ?? "")
        .filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

function areBinSetsEqual(a: Set<string> | undefined, b: Set<string>): boolean {
  if (!a) {
    return false;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const bin of b) {
    if (!a.has(bin)) {
      return false;
    }
  }
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
  const connId = remoteRegistry?.get(params.nodeId)?.connId;
  const existing = remoteBinProbeInflight.get(params.nodeId);
  if (existing) {
    await existing.promise;
    if (existing.connId === connId) {
      return;
    }
  }
  const inflight: RemoteBinProbeInflight = {
    connId,
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
  const probeConnId = liveSession?.connId;
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
        connId: probeConnId,
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
        connId: probeConnId,
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
            command,
            params: { bins: binsList },
            timeoutMs,
          }
        : {
            nodeId: params.nodeId,
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
        connId: probeConnId,
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
    const recorded = markRemoteNodeProbeSuccess({
      nodeId: params.nodeId,
      connId: probeConnId,
      signature: probeSignature,
      nowMs: Date.now(),
      bins,
    });
    if (!recorded) {
      return;
    }
    const existingBins = remoteNodes.get(params.nodeId)?.bins;
    const nextBins = new Set(bins);
    const hasChanged = !areBinSetsEqual(existingBins, nextBins);
    recordRemoteNodeBins(params.nodeId, bins);
    if (!hasChanged) {
      return;
    }
    await updatePairedNodeMetadata(params.nodeId, { bins });
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  } catch (err) {
    const recorded = markRemoteNodeProbeFailure({
      nodeId: params.nodeId,
      connId: probeConnId,
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
  const macNodes = [...remoteNodes.values()].filter(
    (node) =>
      node.connected &&
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
  const connected = remoteRegistry.listConnected();
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
