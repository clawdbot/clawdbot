import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getInspectableActiveTaskRestartBlockers,
  type ActiveTaskRestartBlocker,
} from "../tasks/task-registry.maintenance.js";
import { scheduleGatewaySigusr1Restart, type ScheduledRestart } from "./restart.js";

export type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  activeTasks: number;
  totalActive: number;
};

export type SafeGatewayRestartBlocker = {
  kind: "queue" | "reply" | "embedded-run" | "task";
  count: number;
  message: string;
  task?: ActiveTaskRestartBlocker;
};

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

type SafeRestartInspectors = {
  getQueueSize: () => number;
  getPendingReplies: () => number;
  getEmbeddedRuns: () => number;
  getActiveTasks: () => number;
  getTaskBlockers: () => ActiveTaskRestartBlocker[];
};

const defaultInspectors: SafeRestartInspectors = {
  getQueueSize: getTotalQueueSize,
  getPendingReplies: getTotalPendingReplies,
  getEmbeddedRuns: getActiveEmbeddedRunCount,
  getActiveTasks: () => getInspectableActiveTaskRestartBlockers().length,
  getTaskBlockers: getInspectableActiveTaskRestartBlockers,
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatTaskBlocker(task: ActiveTaskRestartBlocker): string {
  return [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
    task.title ? `title=${task.title.slice(0, 80)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function createFallbackTaskBlocker(count: number): SafeGatewayRestartBlocker {
  return {
    kind: "task",
    count,
    message: `${count} active background task run(s)`,
  };
}

export function createSafeGatewayRestartPreflight(
  inspectors: Partial<SafeRestartInspectors> = {},
): SafeGatewayRestartPreflight {
  const resolved = { ...defaultInspectors, ...inspectors };
  const counts: SafeGatewayRestartCounts = {
    queueSize: normalizeCount(resolved.getQueueSize()),
    pendingReplies: normalizeCount(resolved.getPendingReplies()),
    embeddedRuns: normalizeCount(resolved.getEmbeddedRuns()),
    activeTasks: normalizeCount(resolved.getActiveTasks()),
    totalActive: 0,
  };
  counts.totalActive =
    counts.queueSize + counts.pendingReplies + counts.embeddedRuns + counts.activeTasks;

  const blockers: SafeGatewayRestartBlocker[] = [];
  if (counts.queueSize > 0) {
    blockers.push({
      kind: "queue",
      count: counts.queueSize,
      message: `${counts.queueSize} queued or active operation(s)`,
    });
  }
  if (counts.pendingReplies > 0) {
    blockers.push({
      kind: "reply",
      count: counts.pendingReplies,
      message: `${counts.pendingReplies} pending reply delivery operation(s)`,
    });
  }
  if (counts.embeddedRuns > 0) {
    blockers.push({
      kind: "embedded-run",
      count: counts.embeddedRuns,
      message: `${counts.embeddedRuns} active embedded run(s)`,
    });
  }
  if (counts.activeTasks > 0) {
    const taskBlockers = resolved.getTaskBlockers();
    if (taskBlockers.length === 0) {
      blockers.push(createFallbackTaskBlocker(counts.activeTasks));
    } else {
      for (const task of taskBlockers.slice(0, 8)) {
        blockers.push({
          kind: "task",
          count: 1,
          message: formatTaskBlocker(task),
          task,
        });
      }
      const omitted = counts.activeTasks - taskBlockers.length;
      if (omitted > 0) {
        blockers.push(createFallbackTaskBlocker(omitted));
      }
    }
  }

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

export function requestSafeGatewayRestart(
  opts: {
    reason?: string;
    delayMs?: number;
    skipDeferral?: boolean;
    inspect?: Partial<SafeRestartInspectors>;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  const skipDeferral = opts.skipDeferral === true;
  const restart = scheduleGatewaySigusr1Restart({
    delayMs: opts.delayMs ?? 0,
    reason: opts.reason ?? "gateway.restart.safe",
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
