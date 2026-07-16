import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function buildEmbeddedRunBlockedResult(input: {
  text: string;
  errorKind: NonNullable<EmbeddedAgentRunResult["meta"]["error"]>["kind"];
  errorMessage: string;
  durationMs: number;
  agentMeta: EmbeddedAgentMeta;
  attempt: EmbeddedRunAttemptResult;
  replayInvalid: boolean;
  finalPromptText?: string;
}): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: input.text, isError: true }],
    meta: {
      durationMs: input.durationMs,
      agentMeta: input.agentMeta,
      systemPromptReport: input.attempt.systemPromptReport,
      finalAssistantVisibleText: input.text,
      finalAssistantRawText: input.text,
      finalPromptText: input.finalPromptText,
      replayInvalid: input.replayInvalid,
      livenessState: "blocked",
      error: { kind: input.errorKind, message: input.errorMessage },
    },
  };
}
