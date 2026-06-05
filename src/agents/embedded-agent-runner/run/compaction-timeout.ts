/**
 * Computes run timeout behavior while compaction is in progress.
 */
import type { AgentMessage } from "../../runtime/index.js";

/** Timeout state used to distinguish normal run deadlines from compaction stalls. */
export type CompactionTimeoutSignal = {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
};

/** Flags only run-timeout events that overlap pending, retrying, or active compaction work. */
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) {
    return false;
  }
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

/**
 * Grants a single timeout grace window when compaction is still responsible for
 * the delay. A second timeout, or a timeout unrelated to compaction, aborts the
 * run instead of extending indefinitely.
 */
export function resolveRunTimeoutDuringCompaction(params: {
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
  graceAlreadyUsed: boolean;
}): "extend" | "abort" {
  if (!params.isCompactionPendingOrRetrying && !params.isCompactionInFlight) {
    return "abort";
  }
  return params.graceAlreadyUsed ? "abort" : "extend";
}

/** Effective run timeout after adding the one-time compaction grace budget. */
export function resolveRunTimeoutWithCompactionGraceMs(params: {
  runTimeoutMs: number;
  compactionTimeoutMs: number;
}): number {
  return params.runTimeoutMs + params.compactionTimeoutMs;
}

/** Candidate transcript snapshots available when a timeout fires during compaction. */
export type SnapshotSelectionParams = {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
};

/** Snapshot chosen for retry/replay after a compaction-related timeout. */
export type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  switch (message?.role) {
    case "user":
    case "toolResult":
    case "branchSummary":
    case "compactionSummary":
    case "custom":
      return true;
    case "bashExecution":
      return message.excludeFromContext !== true;
    default:
      return false;
  }
}

// Drop trailing assistant/tool-call-only fragments before retrying. Those tails
// are not safe continuation points because replay could resume after an
// incomplete action instead of a user, tool-result, or summary boundary.
function trimToContinuableTail(messages: AgentMessage[]): AgentMessage[] | null {
  let end = messages.length;
  while (end > 0 && !canContinueFromMessage(messages[end - 1])) {
    end -= 1;
  }
  return end > 0 ? messages.slice(0, end) : null;
}

/**
 * Selects the transcript snapshot used after a compaction timeout. Prefer the
 * pre-compaction view when it can be continued cleanly; otherwise fall back to a
 * trimmed current snapshot so retry does not replay past an unsafe tail.
 */
export function selectCompactionTimeoutSnapshot(
  params: SnapshotSelectionParams,
): SnapshotSelection {
  if (!params.timedOutDuringCompaction) {
    return {
      messagesSnapshot: params.currentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  if (params.preCompactionSnapshot) {
    const continuablePreCompactionSnapshot = trimToContinuableTail(params.preCompactionSnapshot);
    if (continuablePreCompactionSnapshot) {
      return {
        messagesSnapshot: continuablePreCompactionSnapshot,
        sessionIdUsed: params.preCompactionSessionId,
        source: "pre-compaction",
      };
    }
  }

  const continuableCurrentSnapshot = trimToContinuableTail(params.currentSnapshot);
  if (continuableCurrentSnapshot) {
    return {
      messagesSnapshot: continuableCurrentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  return {
    messagesSnapshot: [],
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
