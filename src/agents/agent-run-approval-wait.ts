import { onAgentEventForRun } from "../infra/agent-events.js";

export type AgentRunApprovalWait = {
  pending: boolean;
  pausedMs: number;
  onChange?: (pending: boolean) => void;
  dispose: () => void;
};

export function observeAgentRunApprovalWait(params: {
  runId?: string;
  sessionId?: string;
}): AgentRunApprovalWait {
  const approvals = new Set<string>();
  let pausedAtMs = 0;
  let completedPausedMs = 0;
  let unsubscribe = () => {};
  const state: AgentRunApprovalWait = {
    pending: false,
    // Include an open interval so each exec/wait can take its own baseline;
    // time spent parked before that call never becomes execution credit.
    get pausedMs() {
      return completedPausedMs + (state.pending ? Math.max(0, performance.now() - pausedAtMs) : 0);
    },
    dispose: () => {
      unsubscribe();
      state.onChange = undefined;
    },
  };
  if (!params.runId) {
    return state;
  }
  // Lifecycle facts pause scheduling only; the original admitted run retains all authority.
  unsubscribe = onAgentEventForRun(params.runId, (event) => {
    if (
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      (params.sessionId && event.sessionId && event.sessionId !== params.sessionId)
    ) {
      return;
    }
    const approvalId = event.data.approvalId;
    if (typeof approvalId !== "string" || !approvalId) {
      return;
    }
    if (event.data.phase === "waiting-approval") {
      approvals.add(approvalId);
    } else if (event.data.phase === "approval-resolved") {
      approvals.delete(approvalId);
    } else {
      return;
    }
    const pending = approvals.size > 0;
    if (pending === state.pending) {
      return;
    }
    if (pending) {
      pausedAtMs = performance.now();
    } else {
      completedPausedMs += Math.max(0, performance.now() - pausedAtMs);
    }
    state.pending = pending;
    state.onChange?.(pending);
  });
  return state;
}
