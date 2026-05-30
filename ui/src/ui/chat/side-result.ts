import { normalizeOptionalString } from "../string-coerce.ts";

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
  return {
    kind: "btw",
    runId,
    sessionKey,
    ...(normalizeOptionalString(candidate.agentId)
      ? { agentId: normalizeOptionalString(candidate.agentId) }
      : {}),
    question,
    text,
    isError: candidate.isError === true,
    ts:
      typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : Date.now(),
  };
}
