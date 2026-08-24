import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkBlocker,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import { scheduleGatewaySigusr1Restart, type ScheduledRestart } from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR1
// restarts, while still allowing explicit deferral bypasses for operators.
type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  cronRuns: number;
  backgroundExecSessions: number;
  rootRequests: number;
  activeTasks: number;
  totalActive: number;
};
const SAFE_RESTART_BLOCKER_KINDS = [
  "queue",
  "reply",
  "embedded-run",
  "cron-run",
  "background-exec",
  "root-request",
  "task",
] as const satisfies readonly GatewayActiveWorkBlocker["kind"][];

const SAFE_RESTART_BLOCKER_KIND_SET: ReadonlySet<string> = new Set(SAFE_RESTART_BLOCKER_KINDS);

type SafeGatewayRestartBlocker = Omit<GatewayActiveWorkBlocker, "kind"> & {
  kind: (typeof SAFE_RESTART_BLOCKER_KINDS)[number];
};

function isSafeRestartBlocker(
  blocker: GatewayActiveWorkBlocker,
): blocker is SafeGatewayRestartBlocker {
  return SAFE_RESTART_BLOCKER_KIND_SET.has(blocker.kind);
}

type SafeRestartInspectors = Pick<
  GatewayActiveWorkInspectors,
  | "getQueueSize"
  | "getPendingReplies"
  | "getEmbeddedRuns"
  | "getCronRuns"
  | "getBackgroundExecSessions"
  | "getRootRequests"
  | "getActiveTasks"
  | "getTaskBlockers"
>;

// Restart preflight reports a restart-specific inventory, so every activity
// category outside SafeRestartInspectors is neutralized. Typing this as the exact
// complement makes a new category added to the shared snapshot fail to compile
// here until restart decides how to treat it, instead of silently appearing in
// this deprecated surface.
const NON_RESTART_INSPECTORS: Omit<GatewayActiveWorkInspectors, keyof SafeRestartInspectors> = {
  getSessionAdmissions: () => 0,
  getSessionMutations: () => 0,
  getChatRuns: () => 0,
  getQueuedTurns: () => 0,
  getTerminalPersistence: () => 0,
  getTerminalSessions: () => 0,
  getPluginParticipants: () => [],
};

type SafeGatewayRestartPreflight = {
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
    ...NON_RESTART_INSPECTORS,
  });
  const counts: SafeGatewayRestartCounts = {
    queueSize: snapshot.counts.queueSize,
    pendingReplies: snapshot.counts.pendingReplies,
    embeddedRuns: snapshot.counts.embeddedRuns,
    cronRuns: snapshot.counts.cronRuns,
    backgroundExecSessions: snapshot.counts.backgroundExecSessions,
    rootRequests: snapshot.counts.rootRequests,
    activeTasks: snapshot.counts.activeTasks,
    totalActive:
      snapshot.counts.queueSize +
      snapshot.counts.pendingReplies +
      snapshot.counts.embeddedRuns +
      snapshot.counts.cronRuns +
      snapshot.counts.backgroundExecSessions +
      snapshot.counts.rootRequests +
      snapshot.counts.activeTasks,
  };
  // Neutralized categories above cannot produce blockers, so this narrows rather
  // than filters. It replaces an unchecked cast that would have passed any future
  // blocker kind straight into this result.
  const blockers = snapshot.blockers.filter(isSafeRestartBlocker);

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

/** Schedule a gateway restart after collecting tracked active-work blockers. */
export function scheduleSafeGatewayRestart(
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
