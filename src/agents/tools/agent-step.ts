import crypto from "node:crypto";

import { callGateway } from "../../gateway/call.js";
import { extractAssistantText, stripToolMessages } from "./sessions-helpers.js";

export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
}): Promise<string | undefined> {
  const history = (await callGateway({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  })) as { messages?: unknown[] };
  const filtered = stripToolMessages(
    Array.isArray(history?.messages) ? history.messages : [],
  );
  const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  return last ? extractAssistantText(last) : undefined;
}

export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  lane?: string;
}): Promise<string | undefined> {
  const stepIdem = crypto.randomUUID();
  const response = (await callGateway({
    method: "agent",
    params: {
      message: params.message,
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      lane: params.lane ?? "nested",
      extraSystemPrompt: params.extraSystemPrompt,
    },
    timeoutMs: 10_000,
  })) as { runId?: string; acceptedAt?: number };

  const stepRunId =
    typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const stepWaitMs = Math.min(params.timeoutMs, 60_000);
  const wait = (await callGateway({
    method: "agent.wait",
    params: {
      runId: resolvedRunId,
      timeoutMs: stepWaitMs,
    },
    timeoutMs: stepWaitMs + 2000,
  })) as { status?: string };
  if (wait?.status !== "ok") return undefined;
  return await readLatestAssistantReply({ sessionKey: params.sessionKey });
}
