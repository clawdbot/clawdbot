import { isChatStopCommandText } from "../gateway/chat-abort.js";

export type TuiPendingSubmit =
  | { phase: "sending"; runId: string; draftText: string }
  | { phase: "accepted"; runId: string; draftText: string | null };

export type TuiChatSubmitAdmission = "allowed" | "disconnected" | "pending";

type PendingSubmitState = { pendingSubmit: TuiPendingSubmit | null };

export function beginPendingSubmit(state: PendingSubmitState, runId: string, text: string): void {
  state.pendingSubmit = { phase: "sending", runId, draftText: text };
}

export function acceptPendingSubmit(params: {
  state: PendingSubmitState;
  provisionalRunId: string;
  acceptedRunId: string;
  preserveDraft: boolean;
}): boolean {
  const pending = params.state.pendingSubmit;
  if (!pending || pending.phase !== "sending" || pending.runId !== params.provisionalRunId) {
    return false;
  }
  params.state.pendingSubmit = {
    phase: "accepted",
    runId: params.acceptedRunId,
    draftText: params.preserveDraft ? pending.draftText : null,
  };
  return true;
}

export function clearPendingSubmit(state: PendingSubmitState, runId?: string): boolean {
  const pending = state.pendingSubmit;
  if (!pending || (runId !== undefined && pending.runId !== runId)) {
    return false;
  }
  state.pendingSubmit = null;
  return true;
}

export function clearPendingSubmitDraft(state: PendingSubmitState, runId: string): boolean {
  const pending = state.pendingSubmit;
  if (pending?.phase !== "accepted" || pending.runId !== runId || pending.draftText === null) {
    return false;
  }
  state.pendingSubmit = { ...pending, draftText: null };
  return true;
}

export function hasPendingSubmit(state: PendingSubmitState): boolean {
  return state.pendingSubmit !== null;
}

export function getPendingSubmitAcceptedRunId(state: PendingSubmitState): string | null {
  return state.pendingSubmit?.phase === "accepted" ? state.pendingSubmit.runId : null;
}

export function getPendingSubmitDraft(
  state: PendingSubmitState,
): { runId: string; text: string } | null {
  const pending = state.pendingSubmit;
  if (!pending || pending.draftText === null) {
    return null;
  }
  return { runId: pending.runId, text: pending.draftText };
}

export function reconcilePendingSubmitHistory(
  state: PendingSubmitState,
  reconciledRunIds: readonly string[],
): boolean {
  const runId = state.pendingSubmit?.runId;
  if (!runId || !new Set(reconciledRunIds).has(runId)) {
    return false;
  }
  // History proves the Gateway accepted this submit even if reconnect hid
  // its registration event. Release the admission gate or the idle TUI stays blocked.
  state.pendingSubmit = null;
  return true;
}

export function resolveTuiChatSubmitAdmission(params: {
  isConnected: boolean;
  activeChatRunId: string | null;
  pendingSubmit: TuiPendingSubmit | null;
  message: string;
}): TuiChatSubmitAdmission {
  if (!params.isConnected) {
    return "disconnected";
  }
  if (
    isChatStopCommandText(params.message) &&
    (params.activeChatRunId || params.pendingSubmit?.phase === "accepted")
  ) {
    return "allowed";
  }
  return params.pendingSubmit ? "pending" : "allowed";
}

export function disconnectedTuiChatSubmitMessage(local: boolean): string {
  return local
    ? "local runtime not ready — message not sent"
    : "not connected to gateway — message not sent";
}
