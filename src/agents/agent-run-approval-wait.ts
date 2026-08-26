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
  let unsubscribe = () => {};
  const state: AgentRunApprovalWait = {
    pending: false,
    pausedMs: 0,
    dispose: () => {
      unsubscribe();
      state.onChange = undefined;
    },
  };
  const runId = params.runId;
  if (!runId) {
    return state;
  }
  // Lifecycle facts pause scheduling only; the original admitted run retains all authority.
  unsubscribe = onAgentEventForRun(runId, (event) => {
    if (
      event.runId !== runId ||
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
      pausedAtMs = Date.now();
    } else {
      state.pausedMs += Date.now() - pausedAtMs;
    }
    state.pending = pending;
    state.onChange?.(pending);
  });
  return state;
}
