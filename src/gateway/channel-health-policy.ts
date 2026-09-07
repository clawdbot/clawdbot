// Gateway channel health policy.
// Evaluates channel lifecycle snapshots for restart/readiness decisions.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";

type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  restartPending?: boolean;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  activeRunStartedAt?: number | null;
  lastEventAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?: ChannelAccountSnapshot["lastDisconnect"];
  lastTransportActivityAt?: number | null;
  lastStartAt?: number | null;
  reconnectAttempts?: number;
  mode?: string;
  ingressUnavailable?: true;
  lifecycle?: "starting" | "ready" | "recovering" | "blocked" | "stopped";
  healthState?: string;
  terminalDisconnect?: boolean;
};

type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
  | "terminal-disconnect"
  | "blocked"
  | "busy"
  | "stuck"
  | "startup-connect-grace"
  | "reconnect-grace"
  | "disconnected"
  | "stale-socket"
  | "ingress-unavailable";

export type ChannelHealthEvaluation = {
  healthy: boolean;
  reason: ChannelHealthEvaluationReason;
};

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
};

/** Keep channel-authored terminal detail above the shared unhealthy projection. */
export function resolveChannelHealthState(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): string | undefined {
  const evaluation = evaluateChannelHealth(snapshot, policy);
  return !evaluation.healthy && !(snapshot.lifecycle === "blocked" && snapshot.healthState)
    ? evaluation.reason
    : snapshot.healthState;
}

type ChannelRestartReason =
  | "gave-up"
  | "stopped"
  | "stale-socket"
  | "stuck"
  | "disconnected"
  | "ingress-unavailable";

function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false && snapshot.linked !== false;
}

function resolveObservedChannelTimestamp(value: unknown, now: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    !isFutureDateTimestampMs(value, { nowMs: now })
    ? value
    : null;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;
const CHANNEL_RECONNECT_GRACE_MS = 120_000;
// Keep these shared between the background health monitor and on-demand readiness
// probes so both surfaces evaluate channel lifecycle windows consistently.
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;

export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): ChannelHealthEvaluation {
  if (!isManagedAccount(snapshot)) {
    return { healthy: true, reason: "unmanaged" };
  }
  if (!snapshot.running && snapshot.terminalDisconnect) {
    return { healthy: false, reason: "terminal-disconnect" };
  }
  // Transport liveness and inbound admission are independent failure domains: a
  // channel can hold a healthy socket and still admit nothing. This outranks the
  // lifecycle windows below -- including not-running, which is the state a failed
  // ingress start actually lands in -- so the cause survives instead of collapsing
  // into a generic crash. Absence is "unknown", never "fine"; readiness owns its
  // own restart-backoff tolerance in server/readiness.ts.
  if (snapshot.ingressUnavailable === true) {
    return { healthy: false, reason: "ingress-unavailable" };
  }
  if (snapshot.lifecycle === "blocked") {
    return { healthy: false, reason: "blocked" };
  }
  const lastStartAt =
    typeof snapshot.lastStartAt === "number" && Number.isFinite(snapshot.lastStartAt)
      ? snapshot.lastStartAt
      : null;
  const currentLifecycleStarted =
    lastStartAt !== null && !isFutureDateTimestampMs(lastStartAt, { nowMs: policy.now });
  // Trust recorded starting/recovering only inside connect grace. Without a timestamp or after
  // the window, no progress is indistinguishable from a hang, so inference keeps restart authority.
  if (
    (snapshot.lifecycle === "starting" || snapshot.lifecycle === "recovering") &&
    currentLifecycleStarted &&
    policy.now - lastStartAt < policy.channelConnectGraceMs
  ) {
    return { healthy: true, reason: "startup-connect-grace" };
  }
  if (snapshot.lifecycle === "stopped") {
    return { healthy: false, reason: "not-running" };
  }
  if (!snapshot.running) {
    return { healthy: false, reason: "not-running" };
  }
  const activeRuns =
    typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns)
      ? Math.max(0, Math.trunc(snapshot.activeRuns))
      : 0;
  const isBusy = snapshot.busy === true || activeRuns > 0;
  const lastRunActivityAt = resolveObservedChannelTimestamp(snapshot.lastRunActivityAt, policy.now);
  const activeRunStartedAt = resolveObservedChannelTimestamp(
    snapshot.activeRunStartedAt,
    policy.now,
  );
  const lastTransportActivityAt = resolveObservedChannelTimestamp(
    snapshot.lastTransportActivityAt,
    policy.now,
  );
  const busyStateInitializedForLifecycle =
    lastStartAt == null || (lastRunActivityAt != null && lastRunActivityAt >= lastStartAt);

  // Runtime snapshots are patch-merged, so a restarted lifecycle can temporarily
  // inherit stale busy fields from the previous instance. Ignore busy short-circuit
  // until run activity is known to belong to the current lifecycle.
  if (isBusy) {
    if (!busyStateInitializedForLifecycle) {
      // Fall through to normal startup/disconnect checks below.
    } else {
      const runActivityAge =
        lastRunActivityAt == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, policy.now - lastRunActivityAt);
      const disconnectedRunStartAge =
        snapshot.connected === false && activeRunStartedAt != null
          ? Math.max(0, policy.now - activeRunStartedAt)
          : 0;
      const busyAge = Math.max(runActivityAge, disconnectedRunStartAge);
      if (busyAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
        return { healthy: true, reason: "busy" };
      }
      return { healthy: false, reason: "stuck" };
    }
  }
  if (snapshot.lifecycle === undefined && currentLifecycleStarted) {
    const upDuration = policy.now - lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    const lastDisconnectAt =
      snapshot.lastDisconnect && typeof snapshot.lastDisconnect !== "string"
        ? resolveObservedChannelTimestamp(snapshot.lastDisconnect.at, policy.now)
        : null;
    // A disconnect is current only when its producer recorded it inside this
    // account lifecycle; patch-merged timestamps from prior runs grant no grace.
    const disconnectBelongsToLifecycle =
      lastDisconnectAt != null && (lastStartAt == null || lastDisconnectAt >= lastStartAt);
    if (
      disconnectBelongsToLifecycle &&
      Math.max(0, policy.now - lastDisconnectAt) < CHANNEL_RECONNECT_GRACE_MS
    ) {
      return { healthy: true, reason: "reconnect-grace" };
    }
    return { healthy: false, reason: "disconnected" };
  }
  // App-level events are not socket liveness: quiet Slack/Discord workspaces can
  // go idle while their upstream clients maintain heartbeats internally.
  const shouldCheckStaleSocket = snapshot.connected === true && lastTransportActivityAt != null;
  if (shouldCheckStaleSocket) {
    if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
      if (currentLifecycleStarted && policy.now - lastStartAt <= policy.staleEventThresholdMs) {
        return { healthy: true, reason: "healthy" };
      }
      return { healthy: false, reason: "stale-socket" };
    }
    const eventAge = policy.now - lastTransportActivityAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }
  return { healthy: true, reason: "healthy" };
}

export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ChannelHealthEvaluation,
): ChannelRestartReason {
  // Restart reasons are intentionally coarse: downstream logs/UI need stable
  // categories, while detailed channel state stays in the health snapshot.
  if (evaluation.reason === "stale-socket") {
    return "stale-socket";
  }
  // Restarting is also the only way to re-prove ingress: `ingressUnavailable`
  // describes the last start attempt and is cleared by the next one. Naming the
  // reason keeps a repeating restart readable as dead inbound rather than "stuck".
  if (evaluation.reason === "ingress-unavailable") {
    return "ingress-unavailable";
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  if (evaluation.reason === "disconnected") {
    return "disconnected";
  }
  return "stuck";
}
