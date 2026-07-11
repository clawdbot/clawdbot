import { normalizeOptionalString } from "../string-coerce.ts";

/** Local-only placeholder shown while a sent /btw side question awaits its result. */
export type ChatSideResultPending = {
  question: string;
  ts: number;
  /** Detached send run id, set once the send is acked; used to drop the card
   * when the run terminates without ever emitting a chat.side_result. */
  runId?: string;
};

export type ChatSideResult = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError: boolean;
  ts: number;
};

/**
 * Drops the pending BTW card without consuming its run. The run id is
 * recorded in the suppression set so late side_result/terminal events from
 * the abandoned run cannot reach the side-result card or the transcript.
 */
export function retirePendingChatSideQuestion(state: {
  chatSideResultPending?: ChatSideResultPending | null;
  chatSideResultTerminalRuns?: Set<string>;
}) {
  const runId = state.chatSideResultPending?.runId;
  if (runId) {
    state.chatSideResultTerminalRuns?.add(runId);
  }
  state.chatSideResultPending = null;
}

export function parseChatSideResult(payload: unknown): ChatSideResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind !== "btw") {
    return null;
  }
  const runId = normalizeOptionalString(candidate.runId);
  const sessionKey = normalizeOptionalString(candidate.sessionKey);
  const question = normalizeOptionalString(candidate.question);
  const text = normalizeOptionalString(candidate.text);
  if (!(runId && sessionKey && question && text)) {
    return null;
  }
  const agentId = normalizeOptionalString(candidate.agentId);
  return {
    kind: "btw",
    runId,
    sessionKey,
    ...(agentId ? { agentId } : {}),
    question,
    text,
    isError: candidate.isError === true,
    ts:
      typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : Date.now(),
  };
}
