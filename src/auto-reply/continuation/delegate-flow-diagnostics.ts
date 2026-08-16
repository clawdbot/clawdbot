import type {
  DiagnosticContinuationQueueHistoryPoint,
  DiagnosticContinuationQueueMetrics,
  DiagnosticContinuationQueueOwnerSample,
} from "../../infra/diagnostic-events.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { PendingContinuationDelegate } from "./types.js";

const CONTINUATION_QUEUE_HISTORY_LIMIT = 8;

export function describeDelegateState(stateJson: unknown): string {
  if (!stateJson || typeof stateJson !== "object" || Array.isArray(stateJson)) {
    return `stateType=${Array.isArray(stateJson) ? "array" : typeof stateJson}`;
  }
  return `stateType=object keyCount=${Object.keys(stateJson).length}`;
}

type ContinuationQueueDiagnosticDeps = {
  listFlows: () => TaskFlowRecord[];
  isContinuationDelegateFlow: (flow: TaskFlowRecord) => boolean;
  isPostCompactionDelegateFlow: (flow: TaskFlowRecord) => boolean;
  decodeDelegateFlow: (flow: TaskFlowRecord) => PendingContinuationDelegate | undefined;
  delegateDueAt: (flow: TaskFlowRecord, delegate: PendingContinuationDelegate) => number;
};

function countFlowsChangedSince(
  flows: TaskFlowRecord[],
  status: TaskFlowRecord["status"],
  since: number | undefined,
  now: number,
): number {
  if (since === undefined) {
    return 0;
  }
  return flows.filter((flow) => {
    const changedAt = flow.endedAt ?? flow.updatedAt;
    return flow.status === status && changedAt > since && changedAt <= now;
  }).length;
}

function createEmptyOwnerQueueSample(sessionKey: string): DiagnosticContinuationQueueOwnerSample {
  return {
    sessionKey,
    pendingQueued: 0,
    pendingRunnable: 0,
    pendingScheduled: 0,
    stagedPostCompaction: 0,
    invalidQueued: 0,
    totalQueued: 0,
  };
}

function noteOwnerQueuedFlow(
  owner: DiagnosticContinuationQueueOwnerSample,
  flow: TaskFlowRecord,
  now: number,
): void {
  owner.totalQueued += 1;
  const queuedAgeMs = Math.max(0, now - flow.createdAt);
  owner.oldestQueuedAgeMs = Math.max(owner.oldestQueuedAgeMs ?? 0, queuedAgeMs);
  owner.newestQueuedAgeMs =
    owner.newestQueuedAgeMs === undefined
      ? queuedAgeMs
      : Math.min(owner.newestQueuedAgeMs, queuedAgeMs);
}

export function createContinuationQueueDiagnostics(deps: ContinuationQueueDiagnosticDeps): {
  sample: (now?: number) => DiagnosticContinuationQueueMetrics | undefined;
  reset: () => void;
} {
  let lastSampleAt: number | undefined;
  const history: DiagnosticContinuationQueueHistoryPoint[] = [];

  const sample = (now = Date.now()): DiagnosticContinuationQueueMetrics | undefined => {
    const flows = deps.listFlows().filter(deps.isContinuationDelegateFlow);
    const intervalMs = lastSampleAt !== undefined ? Math.max(0, now - lastSampleAt) : undefined;
    const previousSampleAt = lastSampleAt;
    const enqueuedSinceLastSample =
      previousSampleAt === undefined
        ? 0
        : flows.filter((flow) => flow.createdAt > previousSampleAt && flow.createdAt <= now).length;
    const drainedSinceLastSample = countFlowsChangedSince(
      flows,
      "succeeded",
      previousSampleAt,
      now,
    );
    const failedSinceLastSample = countFlowsChangedSince(flows, "failed", previousSampleAt, now);

    const owners = new Map<string, DiagnosticContinuationQueueOwnerSample>();
    let pendingQueued = 0;
    let pendingRunnable = 0;
    let pendingScheduled = 0;
    let stagedPostCompaction = 0;
    let invalidQueued = 0;

    for (const flow of flows) {
      if (flow.status !== "queued") {
        continue;
      }
      const owner = owners.get(flow.ownerKey) ?? createEmptyOwnerQueueSample(flow.ownerKey);
      owners.set(flow.ownerKey, owner);
      noteOwnerQueuedFlow(owner, flow, now);

      if (deps.isPostCompactionDelegateFlow(flow)) {
        stagedPostCompaction += 1;
        owner.stagedPostCompaction += 1;
        continue;
      }

      pendingQueued += 1;
      owner.pendingQueued += 1;
      const delegate = deps.decodeDelegateFlow(flow);
      if (!delegate) {
        invalidQueued += 1;
        owner.invalidQueued += 1;
        continue;
      }
      if (deps.delegateDueAt(flow, delegate) <= now) {
        pendingRunnable += 1;
        owner.pendingRunnable += 1;
      } else {
        pendingScheduled += 1;
        owner.pendingScheduled += 1;
      }
    }

    const totalQueued = pendingQueued + stagedPostCompaction;
    history.push({
      sampledAt: now,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      totalQueued,
      pendingRunnable,
      pendingScheduled,
      stagedPostCompaction,
      invalidQueued,
      enqueued: enqueuedSinceLastSample,
      drained: drainedSinceLastSample,
      failed: failedSinceLastSample,
    });
    if (history.length > CONTINUATION_QUEUE_HISTORY_LIMIT) {
      history.splice(0, history.length - CONTINUATION_QUEUE_HISTORY_LIMIT);
    }
    lastSampleAt = now;

    if (
      flows.length === 0 &&
      totalQueued === 0 &&
      enqueuedSinceLastSample === 0 &&
      drainedSinceLastSample === 0 &&
      failedSinceLastSample === 0
    ) {
      return undefined;
    }

    const rateFields =
      intervalMs !== undefined && intervalMs > 0
        ? {
            enqueueRatePerMinute: (enqueuedSinceLastSample * 60_000) / intervalMs,
            drainRatePerMinute: (drainedSinceLastSample * 60_000) / intervalMs,
            failedRatePerMinute: (failedSinceLastSample * 60_000) / intervalMs,
          }
        : {};

    return {
      sampledAt: now,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      totalQueued,
      pendingQueued,
      pendingRunnable,
      pendingScheduled,
      stagedPostCompaction,
      invalidQueued,
      enqueuedSinceLastSample,
      drainedSinceLastSample,
      failedSinceLastSample,
      ...rateFields,
      topQueues: [...owners.values()]
        .toSorted(
          (a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey),
        )
        .slice(0, 8),
      queueDepthHistory: [...history],
    };
  };

  return {
    sample,
    reset: () => {
      lastSampleAt = undefined;
      history.length = 0;
    },
  };
}
