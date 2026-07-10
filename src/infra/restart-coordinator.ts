import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkBlocker,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import { scheduleGatewaySigusr1Restart, type ScheduledRestart } from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR1
// restarts, while still allowing explicit deferral bypasses for operators.
export type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  cronRuns: number;
  activeTasks: number;
  totalActive: number;
};
export type SafeGatewayRestartBlocker = Omit<GatewayActiveWorkBlocker, "kind"> & {
  kind: "queue" | "reply" | "embedded-run" | "cron-run" | "task";
};

type SafeRestartInspectors = Pick<
  GatewayActiveWorkInspectors,
  | "getQueueSize"
  | "getPendingReplies"
  | "getEmbeddedRuns"
  | "getCronRuns"
  | "getActiveTasks"
  | "getTaskBlockers"
>;

export type SafeGatewayRestartPreflight = {
  safe: boolean;
  counts: SafeGatewayRestartCounts;
  blockers: SafeGatewayRestartBlocker[];
  summary: string;
};

export type SafeGatewayRestartRequestResult = {
  ok: true;
  status: "scheduled" | "deferred" | "coalesced";
  preflight: SafeGatewayRestartPreflight;
  restart: ScheduledRestart;
};

export function createSafeGatewayRestartPreflight(
  inspectors: Partial<SafeRestartInspectors> = {},
): SafeGatewayRestartPreflight {
  const snapshot = createGatewayActiveWorkSnapshot({
    ...inspectors,
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  });
  const counts: SafeGatewayRestartCounts = {
    queueSize: snapshot.counts.queueSize,
    pendingReplies: snapshot.counts.pendingReplies,
    embeddedRuns: snapshot.counts.embeddedRuns,
    cronRuns: snapshot.counts.cronRuns,
    activeTasks: snapshot.counts.activeTasks,
    totalActive:
      snapshot.counts.queueSize +
      snapshot.counts.pendingReplies +
      snapshot.counts.embeddedRuns +
      snapshot.counts.cronRuns +
      snapshot.counts.activeTasks,
  };
  const blockers = snapshot.blockers as SafeGatewayRestartBlocker[];

  const summary =
    blockers.length === 0
      ? "safe to restart now"
      : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`;
  return {
    safe: counts.totalActive === 0,
    counts,
    blockers,
    summary,
  };
}

/** Schedule a gateway restart after collecting queue/reply/task blockers. */
export function requestSafeGatewayRestart(
  opts: {
    reason?: string;
    delayMs?: number;
    skipDeferral?: boolean;
    preservePendingEmitHooks?: boolean;
    inspect?: Partial<SafeRestartInspectors>;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  const skipDeferral = opts.skipDeferral === true;
  const restart = scheduleGatewaySigusr1Restart({
    delayMs: opts.delayMs ?? 0,
    reason: opts.reason ?? "gateway.restart.safe",
    ...(opts.preservePendingEmitHooks === true || skipDeferral
      ? { preservePendingEmitHooksOnDeferralBypass: true }
      : {}),
    ...(skipDeferral ? { skipDeferral: true } : {}),
  });
  const status = restart.coalesced
    ? "coalesced"
    : skipDeferral || preflight.safe
      ? "scheduled"
      : "deferred";
  return {
    ok: true,
    status,
    preflight,
    restart,
  };
}
