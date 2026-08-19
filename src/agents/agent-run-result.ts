/** Minimal agent-run result projection shared by setup and diagnostic probes. */
export type AgentRunResultView = {
  payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
  meta?: {
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

export function extractAgentRunText(result: AgentRunResultView): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

export function extractAgentRunTerminalError(result: AgentRunResultView): string | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError === true)?.text?.trim();
  const livenessState = result.meta?.livenessState?.trim().toLowerCase();
  if (
    !errorPayload &&
    !result.meta?.error &&
    livenessState !== "blocked" &&
    livenessState !== "abandoned"
  ) {
    return undefined;
  }
  return (
    result.meta?.error?.message?.trim() ||
    errorPayload ||
    (livenessState ? `Inference ended in the ${livenessState} state.` : "Inference failed.")
  );
}

export function agentRunHasVisibleReply(result: AgentRunResultView): boolean {
  if (result.meta?.finalAssistantVisibleText?.trim()) {
    return true;
  }
  return (
    result.payloads?.some(
      (payload) =>
        payload.isError !== true && payload.isReasoning !== true && Boolean(payload.text?.trim()),
    ) === true
  );
}
