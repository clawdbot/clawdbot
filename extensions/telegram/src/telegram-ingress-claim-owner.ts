// Telegram plugin module implements telegram ingress claim-owner identity.
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import type { ChannelIngressQueueCorruptClaim } from "openclaw/plugin-sdk/channel-outbound";
import type {
  ClaimedTelegramSpooledUpdate,
  TelegramSpooledUpdateClaimOwner,
} from "./telegram-ingress-spool.types.js";

// Liveness default: a claim older than its lease is never live-owner protected,
// so recovery can reclaim it even when the owner process still exists.
const TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS = 30 * 60 * 1000;

type TelegramSpooledClaimLivenessOptions = {
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
      const startedAt = childProcess
        .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          stdio: ["ignore", "pipe", "ignore"],
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

const TELEGRAM_SPOOLED_UPDATE_PROCESS_START_TIME = readProcessStartTime(process.pid);
// ownerId = pid:startToken:uuid. Starttime binds the PID to one process instance so
// Linux TIDs and recycled PIDs cannot impersonate a dead claim owner.
export const TELEGRAM_SPOOLED_UPDATE_PROCESS_ID = [
  process.pid,
  TELEGRAM_SPOOLED_UPDATE_PROCESS_START_TIME ?? "x",
  randomUUID(),
].join(":");

export function processPidFromOwnerId(ownerId: string): number {
  const pid = Number.parseInt(ownerId.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : -1;
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
  claim: TelegramSpooledUpdateClaimOwner,
  options?: { maxAgeMs?: number; now?: number },
): boolean {
  const now = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS;
  return now - claim.claimedAt < maxAgeMs;
}

function isClaimOwnerProcessInstanceLive(
  claim: Pick<TelegramSpooledUpdateClaimOwner, "processId" | "processPid">,
  options?: TelegramSpooledClaimLivenessOptions,
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

export function isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
  claim: ClaimedTelegramSpooledUpdate,
  options?: TelegramSpooledClaimLivenessOptions,
): boolean {
  return Boolean(
    claim.claim &&
    claim.claim.processId !== TELEGRAM_SPOOLED_UPDATE_PROCESS_ID &&
    claim.claim.processPid !== process.pid &&
    isFreshClaimOwner(claim.claim, options) &&
    isClaimOwnerProcessInstanceLive(claim.claim, options),
  );
}

export function isTelegramSpooledCorruptClaimOwnedByOtherLiveProcess(
  claim: ChannelIngressQueueCorruptClaim,
  options?: TelegramSpooledClaimLivenessOptions,
): boolean {
  const processId = claim.claim.ownerId;
  const processPid = processPidFromOwnerId(processId);
  const owner = { processId, processPid, claimedAt: claim.claim.claimedAt };
  if (processId === TELEGRAM_SPOOLED_UPDATE_PROCESS_ID) {
    return isFreshClaimOwner(owner, options);
  }
  return (
    processPid !== process.pid &&
    isFreshClaimOwner(owner, options) &&
    isClaimOwnerProcessInstanceLive(owner, options)
  );
}
