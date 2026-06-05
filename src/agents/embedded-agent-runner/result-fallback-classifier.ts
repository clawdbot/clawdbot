/**
 * Classifies embedded-agent run results for model fallback decisions.
 */
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { classifyFailoverReason } from "../embedded-agent-helpers/errors.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { isGpt5ModelId } from "../gpt5-prompt-overlay.js";
import type { ModelFallbackResultClassification } from "../model-fallback.js";
import { hasOutboundDeliveryEvidence, hasVisibleAgentPayload } from "./delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/**
 * Classifies embedded-agent terminal results for model fallback decisions.
 *
 * The classifier only flags failed invisible outcomes; delivered messages, deliberate silent
 * replies, hook blocks, and aborts must not trigger another model attempt.
 */
const EMPTY_TERMINAL_REPLY_RE = /Agent couldn't generate a response/i;
const PLAN_ONLY_TERMINAL_REPLY_RE = /Agent stopped after repeated plan-only turns/i;

function isEmbeddedAgentRunResult(value: unknown): value is EmbeddedAgentRunResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "meta" in value &&
    (value as { meta?: unknown }).meta &&
    typeof (value as { meta?: unknown }).meta === "object",
  );
}

function hasDeliberateSilentTerminalReply(result: EmbeddedAgentRunResult): boolean {
  if (result.meta.error?.kind === "hook_block") {
    return true;
  }
  return [result.meta.finalAssistantRawText, result.meta.finalAssistantVisibleText].some(
    (text) => typeof text === "string" && isSilentReplyPayloadText(text),
  );
}

function classifyHarnessResult(params: {
  provider: string;
  model: string;
  result: EmbeddedAgentRunResult;
}): ModelFallbackResultClassification {
  switch (params.result.meta.agentHarnessResultClassification) {
    case "empty":
      return {
        message: `${params.provider}/${params.model} ended without a visible assistant reply`,
        reason: "format",
        code: "empty_result",
      };
    case "reasoning-only":
      return {
        message: `${params.provider}/${params.model} ended with reasoning only`,
        reason: "format",
        code: "reasoning_only_result",
      };
    case "planning-only":
      return {
        message: `${params.provider}/${params.model} exhausted plan-only retries without taking action`,
        reason: "format",
        code: "planning_only_result",
      };
    default:
      return null;
  }
}

/** Maps provider error payloads to fallback-safe business reasons. */
function classifyBusinessDenialErrorPayloadReason(
  errorText: string,
  provider: string,
): Extract<FailoverReason, "auth" | "auth_permanent" | "billing"> | null {
  if (!errorText.trim()) {
    return null;
  }
  const failoverReason = classifyFailoverReason(errorText, { provider });
  switch (failoverReason) {
    case "auth":
    case "auth_permanent":
    case "billing":
      return failoverReason;
    default:
      return null;
  }
}

/** Returns a fallback classification when an embedded run failed without user-visible output. */
export function classifyEmbeddedAgentRunResultForModelFallback(params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}): ModelFallbackResultClassification {
  if (!isEmbeddedAgentRunResult(params.result)) {
    return null;
  }
  if (
    params.result.meta.aborted ||
    params.hasDirectlySentBlockReply === true ||
    params.hasBlockReplyPipelineOutput === true ||
    hasVisibleAgentPayload(params.result, {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    })
  ) {
    return null;
  }
  if (hasOutboundDeliveryEvidence(params.result)) {
    return null;
  }
  if (params.result.meta.error?.kind === "hook_block") {
    // Hook blocks intentionally suppress normal agent output. Retrying on another model would
    // bypass a policy decision rather than recover a malformed model result.
    return null;
  }

  const harnessClassification = classifyHarnessResult({
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  if (harnessClassification) {
    return harnessClassification;
  }

  const payloads = params.result.payloads ?? [];
  const errorText = payloads
    .filter((payload) => payload?.isError === true)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .join("\n");
  if (EMPTY_TERMINAL_REPLY_RE.test(errorText)) {
    return {
      message: `${params.provider}/${params.model} ended with an incomplete terminal response`,
      reason: "format",
      code: "incomplete_result",
    };
  }
  const failoverReason = classifyBusinessDenialErrorPayloadReason(errorText, params.provider);
  if (failoverReason) {
    return {
      message: `${params.provider}/${params.model} ended with a provider error: ${errorText}`,
      reason: failoverReason,
      code: "embedded_error_payload",
      rawError: errorText,
    };
  }

  if (!isGpt5ModelId(params.model)) {
    return null;
  }

  if (payloads.length === 0 && hasDeliberateSilentTerminalReply(params.result)) {
    return null;
  }
  if (payloads.length === 0) {
    return {
      message: `${params.provider}/${params.model} ended without a visible assistant reply`,
      reason: "format",
      code: "empty_result",
    };
  }
  if (payloads.every((payload) => payload.isReasoning === true)) {
    return {
      message: `${params.provider}/${params.model} ended with reasoning only`,
      reason: "format",
      code: "reasoning_only_result",
    };
  }

  if (PLAN_ONLY_TERMINAL_REPLY_RE.test(errorText)) {
    return {
      message: `${params.provider}/${params.model} exhausted plan-only retries without taking action`,
      reason: "format",
      code: "planning_only_result",
    };
  }
  if (!EMPTY_TERMINAL_REPLY_RE.test(errorText)) {
    return null;
  }

  return {
    message: `${params.provider}/${params.model} ended with an incomplete terminal response`,
    reason: "format",
    code: "incomplete_result",
  };
}
