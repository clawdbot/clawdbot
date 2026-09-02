import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
/**
 * Causal attribution for subagent runs orphaned by a gateway death.
 *
 * A run that was in flight when the gateway process disappeared is only
 * discovered later, when a fresh boot sweeps the registry. The reap timestamp
 * is therefore an arbitrarily late clock reading: it includes however long the
 * host stayed down. Describing the run's lifetime with it produces a confident
 * lie — a 5-minute run that died in a 34-minute outage reads as a 40-minute
 * run, which is exactly the evidence that talked one earlier investigation into
 * diagnosing a timeout on a run whose timeout was disabled.
 *
 * This module turns boot-lifecycle history that is already persisted into a
 * specific, causal message. It records what it observed and what it merely
 * bounded, and it never computes elapsed time from the reap.
 */
import {
  type GatewayBootLifecycleSegment,
  isInferredHostBootId,
  readGatewayBootLifecycleSegments,
} from "../../../infra/gateway-boot-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentOrphanCause =
  /** Host boot id changed across the gap: the machine went down under us. */
  | "host_reboot"
  /** Host boot id held across the gap: the gateway process alone died. */
  | "gateway_process_death"
  /** The boot ended abruptly, but host continuity cannot be established. */
  | "gateway_restart";

export type SubagentOrphanDeathEvidence =
  /** The owning boot recorded when it stopped. Exact. */
  | "boot_completed"
  /** The run's own last recorded activity. A lower bound on the death. */
  | "last_activity"
  /** The successor boot's start. An upper bound on the death. */
  | "successor_boot_start";

export type SubagentOrphanElapsedBound = "exact" | "at_least" | "at_most";

export type SubagentOrphanAttribution = {
  cause: SubagentOrphanCause;
  /** The boot that owned the run and did not stop cleanly. */
  priorBootId: string;
  /** When the gateway came back. */
  restartedAtMs: number;
  /** Best evidence for when the run actually stopped executing. */
  diedAtMs: number;
  diedAtEvidence: SubagentOrphanDeathEvidence;
  /** Lifetime measured from the death, never from the reap. */
  elapsedMs: number;
  elapsedBound: SubagentOrphanElapsedBound;
  /** How long the gateway was absent before it could reap the run. */
  downtimeMs: number;
  /** True when the host-continuity verdict rests on the uptime fallback. */
  hostContinuityInferred: boolean;
  assistantMessageCount: number;
};

/**
 * A boot ended abruptly when it recorded neither a completion time nor an
 * outcome. Every deliberate stop — clean, forced, planned, safe-mode — writes
 * at least one of the two, so a clean shutdown can never be misattributed here.
 */
export function isAbruptGatewayBootEnd(segment: GatewayBootLifecycleSegment): boolean {
  return segment.completedAtMs === null && segment.outcome === null;
}

function resolveHostContinuity(
  prior: GatewayBootLifecycleSegment,
  successor: GatewayBootLifecycleSegment,
): { cause: SubagentOrphanCause; inferred: boolean } {
  if (!prior.hostBootId || !successor.hostBootId) {
    return { cause: "gateway_restart", inferred: false };
  }
  const inferred =
    isInferredHostBootId(prior.hostBootId) || isInferredHostBootId(successor.hostBootId);
  return {
    cause: prior.hostBootId === successor.hostBootId ? "gateway_process_death" : "host_reboot",
    inferred,
  };
}

/**
 * Picks the strongest available evidence for when the run stopped executing.
 * Preference order is by how tightly each bounds the death, not by convenience.
 */
function resolveDeathEvidence(params: {
  prior: GatewayBootLifecycleSegment;
  successor: GatewayBootLifecycleSegment;
  runStartedAtMs: number;
  lastActivityAtMs?: number;
}): { diedAtMs: number; evidence: SubagentOrphanDeathEvidence; bound: SubagentOrphanElapsedBound } {
  if (typeof params.prior.completedAtMs === "number") {
    return {
      diedAtMs: params.prior.completedAtMs,
      evidence: "boot_completed",
      bound: "exact",
    };
  }
  const lastActivityAtMs = params.lastActivityAtMs;
  // Strictly after the start: the start itself says nothing about how long the
  // run survived, and treating it as evidence would report a 0s lifetime — a
  // more confident claim than the honest "at most, up to the restart".
  if (
    typeof lastActivityAtMs === "number" &&
    Number.isFinite(lastActivityAtMs) &&
    lastActivityAtMs > params.runStartedAtMs &&
    lastActivityAtMs <= params.successor.startedAtMs
  ) {
    return { diedAtMs: lastActivityAtMs, evidence: "last_activity", bound: "at_least" };
  }
  // The gateway was certainly gone by the time its successor started. That is a
  // real bound; the reap timestamp is not one at all.
  return {
    diedAtMs: params.successor.startedAtMs,
    evidence: "successor_boot_start",
    bound: "at_most",
  };
}

/**
 * Correlates an orphaned run against boot history.
 *
 * Returns null when the evidence does not support a claim — no boot owned the
 * run, the owning boot is still running, or the owning boot stopped in a way
 * somebody recorded. Callers keep their existing wording in that case rather
 * than inventing a cause.
 */
export function resolveSubagentOrphanAttribution(params: {
  runStartedAtMs: number;
  lastActivityAtMs?: number;
  assistantMessageCount?: number;
  boots: readonly GatewayBootLifecycleSegment[];
  currentBootId?: string;
}): SubagentOrphanAttribution | null {
  if (!Number.isFinite(params.runStartedAtMs)) {
    return null;
  }
  const boots = params.boots.toSorted((left, right) => left.startedAtMs - right.startedAtMs);
  let priorIndex = -1;
  for (let index = 0; index < boots.length; index += 1) {
    const segment = boots[index];
    if (segment && segment.startedAtMs <= params.runStartedAtMs) {
      priorIndex = index;
    }
  }
  const prior = priorIndex >= 0 ? boots[priorIndex] : undefined;
  if (!prior) {
    return null;
  }
  // The live boot cannot have orphaned its own in-flight work by restarting.
  if (params.currentBootId && prior.bootId === params.currentBootId) {
    return null;
  }
  if (!isAbruptGatewayBootEnd(prior)) {
    return null;
  }
  const successor = boots[priorIndex + 1];
  if (!successor) {
    return null;
  }
  if (
    typeof params.lastActivityAtMs === "number" &&
    params.lastActivityAtMs > successor.startedAtMs
  ) {
    // Run-written activity after the successor boot disproves that this run
    // died with the prior boot. Preserve the generic recovery wording.
    return null;
  }

  const death = resolveDeathEvidence({
    prior,
    successor,
    runStartedAtMs: params.runStartedAtMs,
    lastActivityAtMs: params.lastActivityAtMs,
  });
  const continuity = resolveHostContinuity(prior, successor);
  return {
    cause: continuity.cause,
    priorBootId: prior.bootId,
    restartedAtMs: successor.startedAtMs,
    diedAtMs: death.diedAtMs,
    diedAtEvidence: death.evidence,
    elapsedMs: Math.max(0, death.diedAtMs - params.runStartedAtMs),
    elapsedBound: death.bound,
    downtimeMs: Math.max(0, successor.startedAtMs - death.diedAtMs),
    hostContinuityInferred: continuity.inferred,
    assistantMessageCount: Math.max(0, params.assistantMessageCount ?? 0),
  };
}

/** formatDurationCompact drops sub-second and zero spans; a duration clause still needs words. */
function describeDuration(ms: number): string {
  return formatDurationCompact(ms) ?? "under 1s";
}

function describeCause(attribution: SubagentOrphanAttribution): string {
  switch (attribution.cause) {
    case "host_reboot":
      return "host rebooted under the gateway";
    case "gateway_process_death":
      return "gateway process died while the host stayed up";
    default:
      return "gateway restarted";
  }
}

function describeElapsed(attribution: SubagentOrphanAttribution): string {
  const duration = describeDuration(attribution.elapsedMs);
  if (attribution.elapsedBound === "at_least") {
    return `at least ${duration}`;
  }
  if (attribution.elapsedBound === "at_most") {
    return `at most ${duration}`;
  }
  return duration;
}

function describeEvidence(attribution: SubagentOrphanAttribution): string {
  switch (attribution.diedAtEvidence) {
    case "boot_completed":
      return "from the recorded boot end";
    case "last_activity":
      return "from the run's last recorded activity";
    default:
      return "bounded by the next boot's start";
  }
}

/**
 * Renders the attribution as the run's recorded error. Every clause is
 * something the database can back: the cause, when the gateway came back, which
 * boot died, how long the run really lived, and how much of the apparent delay
 * was the gateway simply being absent.
 */
export function formatSubagentOrphanErrorMessage(attribution: SubagentOrphanAttribution): string {
  const restartedAt = new Date(attribution.restartedAtMs).toISOString();
  const inferredNote = attribution.hostContinuityInferred
    ? " [host continuity inferred from uptime, not kernel boot id]"
    : "";
  const messages =
    attribution.assistantMessageCount === 1
      ? "1 assistant message recorded"
      : `${attribution.assistantMessageCount} assistant messages recorded`;
  const downtime =
    attribution.diedAtEvidence === "successor_boot_start"
      ? ""
      : `; gateway absent ${describeDuration(attribution.downtimeMs)} before the run could be reaped`;
  return (
    `${describeCause(attribution)} at ${restartedAt} ` +
    `(previous boot ${attribution.priorBootId} ended without a clean stop); ` +
    `run orphaned after ${describeElapsed(attribution)} ${describeEvidence(attribution)}, ` +
    `${messages}${downtime}${inferredNote}`
  );
}

// Boot rows only change when the gateway boots, so the sweeper reads them once
// and reuses the snapshot instead of hitting the state DB per orphaned run.
const BOOT_SEGMENT_CACHE_TTL_MS = 60_000;
// Boot lifecycle rows are pruned at 24h; look back far enough to see all of them.
const BOOT_SEGMENT_LOOKBACK_MS = 48 * 60 * 60_000;
// Attribution needs the complete retained window. The shared reader defaults to
// 64 for ordinary diagnostics, which can omit the owning boot after a rapid
// crash/restart sequence.
const BOOT_SEGMENT_ATTRIBUTION_LIMIT = 2_147_483_647;
let cachedBootSegments: { loadedAtMs: number; segments: GatewayBootLifecycleSegment[] } | undefined;

export function loadGatewayBootSegmentsForAttribution(
  nowMs = Date.now(),
): GatewayBootLifecycleSegment[] {
  if (cachedBootSegments && nowMs - cachedBootSegments.loadedAtMs < BOOT_SEGMENT_CACHE_TTL_MS) {
    return cachedBootSegments.segments;
  }
  const segments = readGatewayBootLifecycleSegments({
    sinceMs: nowMs - BOOT_SEGMENT_LOOKBACK_MS,
    limit: BOOT_SEGMENT_ATTRIBUTION_LIMIT,
  });
  cachedBootSegments = { loadedAtMs: nowMs, segments };
  return segments;
}

export function resetGatewayBootSegmentCacheForTests(): void {
  cachedBootSegments = undefined;
}

/**
 * The run's last recorded activity, used as a lower bound on its death.
 *
 * Only timestamps written *by the run* count. The reap time and the archive
 * deadline are clock readings taken by whoever found the corpse.
 */
export function resolveSubagentRunLastActivityMs(entry: SubagentRunRecord): number | undefined {
  const candidates = [
    entry.completion?.capturedAt,
    entry.completion?.fallbackCapturedAt,
    entry.execution.interruptedAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  // Deliberately excludes execution.startedAt: the start is when the clock
  // began, not proof the run was still alive at any later point.
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/**
 * Counts what the run is recorded as having produced.
 *
 * The registry persists captured result text rather than a transcript, so this
 * distinguishes "produced something" from "produced nothing" and does not claim
 * a precise count it cannot support. Zero here is the fact the notification
 * path gates on: a run that died having said nothing is the one case the
 * spawning session cannot recover from on its own.
 */
export function countRecordedSubagentAssistantMessages(entry: SubagentRunRecord): number {
  let count = 0;
  if (entry.completion?.resultText?.trim()) {
    count += 1;
  }
  if (entry.completion?.fallbackResultText?.trim()) {
    count += 1;
  }
  return count;
}
