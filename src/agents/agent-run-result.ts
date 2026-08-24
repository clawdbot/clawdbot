/** Minimal agent-run result projection shared by setup and diagnostic probes. */
import { isReplyPayloadTerminalContent, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";

export type AgentRunResultView = {
  payloads?: Array<ReplyPayload & { visible?: boolean }>;
  meta?: {
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

export function extractAgentRunText(result: AgentRunResultView): string | undefined {
  const visibleText = result.meta?.finalAssistantVisibleText?.trim();
  if (visibleText) {
    return isSilentReplyPayloadText(visibleText) ? undefined : visibleText;
  }
  return (
    result.payloads
      ?.filter(
        (payload) =>
          payload.visible !== false &&
          payload.isError !== true &&
          isReplyPayloadTerminalContent(payload),
      )
      .map((payload) => payload.text?.trim())
      .filter((text): text is string => Boolean(text) && !isSilentReplyPayloadText(text))
      .join("\n") || undefined
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
  return Boolean(extractAgentRunText(result));
}
