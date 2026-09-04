/** Agent-run result projections shared by execution owners and diagnostic probes. */
import { isReplyPayloadTerminalContent, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/** Adds an owner-bounded, redacted diagnostic without discarding returned work. */
export function appendAgentRunFailure(
  result: EmbeddedAgentRunResult,
  diagnostic: string,
): EmbeddedAgentRunResult {
  const primaryError = result.meta.error;
  // Preserve interruptions and delivery evidence. A replacement also owns a fresh
  // fallback classification rather than mutating an already-classified result.
  return {
    ...result,
    payloads: [...(result.payloads ?? []), { text: diagnostic, isError: true }],
    meta: {
      ...result.meta,
      replayInvalid: true,
      error: {
        ...primaryError,
        kind: primaryError?.kind ?? "incomplete_turn",
        message: primaryError ? `${primaryError.message}\n${diagnostic}` : diagnostic,
        // Incomplete-turn fallbackSafe otherwise overrides replayInvalid.
        fallbackSafe: false,
      },
    },
  };
}

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
