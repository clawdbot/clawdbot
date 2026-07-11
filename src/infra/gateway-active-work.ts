// Collects process activity shared by restart and host-suspension decisions.
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../sessions/session-lifecycle-admission.js";
import { getSuspensionVisibleCronTaskRunCount } from "../tasks/cron-task-cancel.js";
import { getInspectableActiveTaskRestartBlockers } from "../tasks/task-registry.maintenance.js";
import {
  type ActiveTaskRestartBlocker,
  formatActiveTaskRestartBlocker,
} from "../tasks/task-restart-blocker.js";

export type GatewayActiveWorkCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  backgroundExecSessions: number;
  cronRuns: number;
  activeTasks: number;
  rootRequests: number;
  sessionAdmissions: number;
  sessionMutations: number;
  chatRuns: number;
  queuedTurns: number;
  terminalPersistence: number;
  terminalSessions: number;
  /** Compatibility aggregate. Categories can overlap; use individual counts for diagnostics. */
  totalActive: number;
};

export type GatewayActiveWorkBlocker = {
  kind:
    | "queue"
    | "reply"
    | "embedded-run"
    | "background-exec"
    | "cron-run"
    | "task"
    | "root-request"
    | "session-admission"
    | "session-mutation"
    | "chat-run"
    | "queued-turn"
    | "terminal-persistence"
    | "terminal-session";
  count: number;
  message: string;
  task?: ActiveTaskRestartBlocker;
};

export type GatewayActiveWorkSnapshot = {
  idle: boolean;
  counts: GatewayActiveWorkCounts;
  blockers: GatewayActiveWorkBlocker[];
};

export type GatewayActiveWorkInspectors = {
  getQueueSize: () => number;
  getPendingReplies: () => number;
  getEmbeddedRuns: () => number;
  getBackgroundExecSessions: () => number;
  getCronRuns: () => number;
  getActiveTasks: () => number;
  getTaskBlockers: () => ActiveTaskRestartBlocker[];
  getRootRequests: () => number;
  getSessionAdmissions: () => number;
  getSessionMutations: () => number;
  getChatRuns: () => number;
  getQueuedTurns: () => number;
  getTerminalPersistence: () => number;
  getTerminalSessions: () => number;
};

const defaultInspectors: GatewayActiveWorkInspectors = {
  getQueueSize: getTotalQueueSize,
  getPendingReplies: getTotalPendingReplies,
  getEmbeddedRuns: getActiveEmbeddedRunCount,
  getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
  getCronRuns: () => Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()),
  getActiveTasks: () => getInspectableActiveTaskRestartBlockers().length,
  getTaskBlockers: getInspectableActiveTaskRestartBlockers,
  getRootRequests: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }),
  getSessionAdmissions: getActiveSessionWorkAdmissionCount,
  getSessionMutations: getActiveSessionLifecycleMutationCount,
  getChatRuns: () => 0,
  getQueuedTurns: () => 0,
  getTerminalPersistence: () => 0,
  getTerminalSessions: () => 0,
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createGatewayActiveWorkSnapshot(
  inspectors: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkSnapshot {
  const resolved = { ...defaultInspectors, ...inspectors };
  const counts: GatewayActiveWorkCounts = {
    queueSize: normalizeCount(resolved.getQueueSize()),
    pendingReplies: normalizeCount(resolved.getPendingReplies()),
    embeddedRuns: normalizeCount(resolved.getEmbeddedRuns()),
    backgroundExecSessions: normalizeCount(resolved.getBackgroundExecSessions()),
    cronRuns: normalizeCount(resolved.getCronRuns()),
    activeTasks: normalizeCount(resolved.getActiveTasks()),
    rootRequests: normalizeCount(resolved.getRootRequests()),
    sessionAdmissions: normalizeCount(resolved.getSessionAdmissions()),
    sessionMutations: normalizeCount(resolved.getSessionMutations()),
    chatRuns: normalizeCount(resolved.getChatRuns()),
    queuedTurns: normalizeCount(resolved.getQueuedTurns()),
    terminalPersistence: normalizeCount(resolved.getTerminalPersistence()),
    terminalSessions: normalizeCount(resolved.getTerminalSessions()),
    totalActive: 0,
  };
  counts.totalActive = Object.entries(counts).reduce(
    (total, [key, count]) => (key === "totalActive" ? total : total + count),
    0,
  );

  const blockers: GatewayActiveWorkBlocker[] = [];
  const add = (count: number, kind: GatewayActiveWorkBlocker["kind"], message: string) => {
    if (count > 0) {
      blockers.push({ kind, count, message });
    }
  };
  add(counts.queueSize, "queue", `${counts.queueSize} queued or active operation(s)`);
  add(
    counts.pendingReplies,
    "reply",
    `${counts.pendingReplies} pending reply delivery operation(s)`,
  );
  add(counts.embeddedRuns, "embedded-run", `${counts.embeddedRuns} active embedded run(s)`);
  add(
    counts.backgroundExecSessions,
    "background-exec",
    `${counts.backgroundExecSessions} active background exec session(s)`,
  );
  add(counts.cronRuns, "cron-run", `${counts.cronRuns} active cron run(s)`);
  add(counts.rootRequests, "root-request", `${counts.rootRequests} active gateway request(s)`);
  add(
    counts.sessionAdmissions,
    "session-admission",
    `${counts.sessionAdmissions} admitted session turn(s)`,
  );
  add(
    counts.sessionMutations,
    "session-mutation",
    `${counts.sessionMutations} active session lifecycle mutation(s)`,
  );
  add(counts.chatRuns, "chat-run", `${counts.chatRuns} active chat run(s)`);
  add(counts.queuedTurns, "queued-turn", `${counts.queuedTurns} queued chat turn(s)`);
  add(
    counts.terminalPersistence,
    "terminal-persistence",
    `${counts.terminalPersistence} pending terminal session write(s)`,
  );
  add(
    counts.terminalSessions,
    "terminal-session",
    `${counts.terminalSessions} open terminal session(s)`,
  );

  if (counts.activeTasks > 0) {
    const taskBlockers = resolved.getTaskBlockers();
    if (taskBlockers.length === 0) {
      blockers.push({
        kind: "task",
        count: counts.activeTasks,
        message: `${counts.activeTasks} active background task run(s)`,
      });
    } else {
      const shownTaskBlockers = taskBlockers.slice(0, 8);
      for (const task of shownTaskBlockers) {
        blockers.push({
          kind: "task",
          count: 1,
          message: formatActiveTaskRestartBlocker(task),
          task,
        });
      }
      const omitted = counts.activeTasks - shownTaskBlockers.length;
      if (omitted > 0) {
        blockers.push({
          kind: "task",
          count: omitted,
          message: `${omitted} additional active background task run(s)`,
        });
      }
    }
  }

  return { idle: counts.totalActive === 0, counts, blockers };
}
