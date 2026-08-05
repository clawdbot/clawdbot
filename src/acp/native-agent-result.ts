import type { agentCommandFromIngress } from "../agents/agent-command.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

export type AgentResult = Awaited<ReturnType<typeof agentCommandFromIngress>>;

function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const payload = part as {
        isCommentary?: unknown;
        isError?: unknown;
        isReasoning?: unknown;
        text?: unknown;
        visible?: unknown;
      };
      return payload.isCommentary !== true &&
        payload.isError !== true &&
        payload.isReasoning !== true &&
        payload.visible !== false &&
        typeof payload.text === "string"
        ? [payload.text]
        : [];
    })
    .filter(Boolean)
    .join("\n\n");
}

export function finalVisibleText(result: AgentResult | undefined): string {
  const text = result?.meta.finalAssistantVisibleText ?? payloadText(result?.payloads);
  const normalized = stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text);
  return isSilentReplyPayloadText(normalized) ? "" : normalized;
}

export function agentResultError(result: AgentResult | undefined): Error | undefined {
  if (!result) {
    return new Error("OpenClaw agent returned no result");
  }
  const errorPayload = result.payloads?.find(
    (payload) => (payload as { isError?: unknown }).isError === true,
  ) as { text?: unknown } | undefined;
  const message =
    result.meta.error?.message ??
    (typeof errorPayload?.text === "string" && errorPayload.text.trim()
      ? errorPayload.text.trim()
      : undefined);
  if (result.meta.stopReason === "timeout" || result.meta.timeoutPhase !== undefined) {
    return new Error(message ?? "OpenClaw agent timed out");
  }
  if (
    result.meta.aborted === true ||
    result.meta.stopReason === "error" ||
    result.meta.error !== undefined ||
    errorPayload
  ) {
    return new Error(message ?? "OpenClaw agent run failed");
  }
  return undefined;
}
