/**
 * Process-liveness identity for durable channel-ingress claims.
 *
 * ownerId = pid:startToken:uuid. Starttime binds the PID to one process instance so
 * Linux TIDs and recycled PIDs cannot impersonate a dead claim owner.
 */
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import type { ChannelIngressQueueClaim, ChannelIngressQueueCorruptClaim } from "./ingress-queue.js";

// Liveness default: a claim older than its lease is never live-owner protected,
// so recovery can reclaim it even when the owner process still exists.
export const INGRESS_CLAIM_LEASE_MS = 30 * 60 * 1000;

type IngressClaimOwnerIdentity = {
  processId: string;
  processPid: number;
  claimedAt: number;
};

type IngressClaimLivenessOptions = {
  maxAgeMs?: number;
  now?: number;
  /** Test seam for PID existence (including Linux TID impersonation). */
  processExists?: (pid: number) => boolean;
  /** Test seam for process start-time identity. */
  readProcessStartTime?: (pid: number) => number | null;
};

function readProcessStartTime(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "darwin") {
    try {
      // Bounded: this runs on shared channel/SDK init paths, so a hung /bin/ps must
      // not block startup. Timeout -> null -> "unknown liveness" (callers hold claims).
      const startedAt = childProcess
        .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          killSignal: "SIGKILL",
        })
        .trim();
      const startedAtMs = Date.parse(`${startedAt} UTC`);
      return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

const INGRESS_CLAIM_PROCESS_START_TIME = readProcessStartTime(process.pid);

export const INGRESS_CLAIM_PROCESS_ID = [
  process.pid,
  INGRESS_CLAIM_PROCESS_START_TIME ?? "x",
  randomUUID(),
].join(":");

/** Process-local live drain instance UUIDs (ownerId third field). */
const liveIngressDrainInstanceIds = new Set<string>();

export function processPidFromOwnerId(ownerId: string): number {
  const pid = Number.parseInt(ownerId.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : -1;
}

/** Instance UUID from ownerId `pid:startToken:uuid`. */
function processInstanceIdFromOwnerId(ownerId: string): string | null {
  const parts = ownerId.split(":");
  if (parts.length < 3) {
    return null;
  }
  const instanceId = parts[2];
  return instanceId && instanceId.length > 0 ? instanceId : null;
}

/** Mint a unique per-drain ownerId (`pid:startToken:uuid`). Caller registers via drain. */
export function createIngressDrainOwnerId(): string {
  return [process.pid, INGRESS_CLAIM_PROCESS_START_TIME ?? "x", randomUUID()].join(":");
}

export function registerLiveIngressDrainInstance(ownerId: string): void {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  if (instanceId) {
    liveIngressDrainInstanceIds.add(instanceId);
  }
}

export function deregisterLiveIngressDrainInstance(ownerId: string): void {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  if (instanceId) {
    liveIngressDrainInstanceIds.delete(instanceId);
  }
}

/**
 * True when a same-process drain instance still holds this ownerId.
 * Recovery must not steal claims from a live peer drain on the same queue.
 */
export function isLiveLocalIngressDrainOwner(ownerId: string): boolean {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  return instanceId != null && liveIngressDrainInstanceIds.has(instanceId);
}

// Canonical ownerId: pid:startToken:uuid. startToken is a numeric starttime, or
// the explicit "x" sentinel when the writer cannot supply one (win32).
type OwnerStartToken =
  | { kind: "numeric"; value: number }
  | { kind: "existence-only" }
  | { kind: "missing" };

function parseOwnerStartToken(ownerId: string): OwnerStartToken {
  const parts = ownerId.split(":");
  // Legacy pid:uuid owners (pre start-token releases) carry no instance binding.
  // Keep existence-based liveness for them: reclaiming a fresh claim from a live
  // old-version worker during a rolling upgrade would double-dispatch its update.
  if (parts.length === 2) {
    return { kind: "existence-only" };
  }
  if (parts.length < 2) {
    return { kind: "missing" };
  }
  const startField = parts[1] ?? "";
  // Explicit "x": writer ran on a platform with no readable starttime (win32).
  if (startField === "x") {
    return { kind: "existence-only" };
  }
  const starttime = Number(startField);
  if (Number.isSafeInteger(starttime) && starttime >= 0) {
    return { kind: "numeric", value: starttime };
  }
  return { kind: "missing" };
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

function isFreshClaimOwner(
  claim: Pick<IngressClaimOwnerIdentity, "claimedAt">,
  options?: { maxAgeMs?: number; now?: number },
): boolean {
  const now = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? INGRESS_CLAIM_LEASE_MS;
  return now - claim.claimedAt < maxAgeMs;
}

function isClaimOwnerProcessInstanceLive(
  claim: Pick<IngressClaimOwnerIdentity, "processId" | "processPid">,
  options?: IngressClaimLivenessOptions,
): boolean {
  const exists = options?.processExists ?? processExists;
  const readStart = options?.readProcessStartTime ?? readProcessStartTime;
  if (!exists(claim.processPid)) {
    return false;
  }
  const startToken = parseOwnerStartToken(claim.processId);
  if (startToken.kind === "missing") {
    // Legacy/malformed owner ids have no process-instance binding; reclaim.
    return false;
  }
  if (startToken.kind === "existence-only") {
    // Legacy or `x` owners cannot prove instance identity. Fall back to
    // processExists-only liveness — the pre-starttime lease contract — instead
    // of stealing a fresh claim from a possibly live worker.
    return true;
  }
  const actualStart = readStart(claim.processPid);
  if (actualStart === null) {
    // Starttime unreadable while the PID appears live. Keep lease protection
    // via process existence so a readable-starttime peer is not stolen mid-run.
    return true;
  }
  return actualStart === startToken.value;
}

function toOwnerIdentity(claim: { ownerId: string; claimedAt: number }): IngressClaimOwnerIdentity {
  return {
    processId: claim.ownerId,
    processPid: processPidFromOwnerId(claim.ownerId),
    claimedAt: claim.claimedAt,
  };
}

type IngressClaimOwnerSource =
  | { claim?: IngressClaimOwnerIdentity | null }
  | Pick<ChannelIngressQueueClaim<unknown>, "claim">;

function resolveOwnerIdentity(claim: IngressClaimOwnerSource): IngressClaimOwnerIdentity | null {
  const raw = claim.claim;
  if (!raw) {
    return null;
  }
  if ("ownerId" in raw) {
    return toOwnerIdentity(raw);
  }
  return {
    processId: raw.processId,
    processPid: raw.processPid,
    claimedAt: raw.claimedAt,
  };
}

/** True when another live process still holds a fresh claim on this event. */
export function isIngressClaimOwnedByOtherLiveProcess(
  claim: IngressClaimOwnerSource,
  options?: IngressClaimLivenessOptions,
): boolean {
  const owner = resolveOwnerIdentity(claim);
  if (!owner) {
    return false;
  }
  return (
    owner.processId !== INGRESS_CLAIM_PROCESS_ID &&
    owner.processPid !== process.pid &&
    isFreshClaimOwner(owner, options) &&
    isClaimOwnerProcessInstanceLive(owner, options)
  );
}

/** True when a corrupt claimed row is still live-owned by this or another process. */
export function isIngressCorruptClaimOwnedByOtherLiveProcess(
  claim: ChannelIngressQueueCorruptClaim,
  options?: IngressClaimLivenessOptions,
): boolean {
  const owner = toOwnerIdentity(claim.claim);
  if (owner.processId === INGRESS_CLAIM_PROCESS_ID) {
    return isFreshClaimOwner(owner, options);
  }
  return (
    owner.processPid !== process.pid &&
    isFreshClaimOwner(owner, options) &&
    isClaimOwnerProcessInstanceLive(owner, options)
  );
}
