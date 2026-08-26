/**
 * Pure OpenAI Responses `call_*`/`fc_*` tool-call-id shape helpers.
 *
 * Moved out of embedded-agent-helpers/openai.ts (the AgentMessage[]-walking
 * caller lives in src/agents and imports from packages/ai, so the reverse
 * import direction is not available) so the continuation transport can
 * recognize its own cached raw ids after this same reshaping and restore
 * them on a replayed wire request -- see openai-responses-continuation.ts.
 */
import { sha256Hex } from "./transport-utils.js";

export const OPENAI_RESPONSES_ID_MAX_LENGTH = 64;
export const OPENAI_RESPONSES_CALL_ID_RE = /^call_[A-Za-z0-9_-]{1,59}$/;
export const OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE = /^fc_[A-Za-z0-9_-]{1,61}$/;

export function splitOpenAIFunctionCallPairing(id: string): {
  callId: string;
  itemId?: string;
} {
  const separator = id.indexOf("|");
  if (separator <= 0 || separator >= id.length - 1) {
    return { callId: id };
  }
  return {
    callId: id.slice(0, separator),
    itemId: id.slice(separator + 1),
  };
}

function shortOpenAIResponsesIdHash(id: string): string {
  return sha256Hex(id).slice(0, 10);
}

function sanitizeOpenAIResponsesIdTail(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeOpenAIResponsesIdPart(params: {
  value: string;
  prefix: "call_" | "fc_";
  isValid: (value: string) => boolean;
}): string {
  const trimmed = params.value.trim();
  if (params.isValid(trimmed)) {
    return trimmed;
  }

  const rawTail = trimmed.startsWith(params.prefix) ? trimmed.slice(params.prefix.length) : trimmed;
  const hash = shortOpenAIResponsesIdHash(trimmed || params.prefix);
  const maxTailLength = OPENAI_RESPONSES_ID_MAX_LENGTH - params.prefix.length;
  const hashSuffix = `_${hash}`;
  const safeTail = sanitizeOpenAIResponsesIdTail(rawTail);
  const clippedBase = safeTail.slice(0, Math.max(1, maxTailLength - hashSuffix.length));
  const tail = `${clippedBase || "id"}${hashSuffix}`.slice(0, maxTailLength);
  return `${params.prefix}${tail}`;
}

/** Same shaping `normalizeOpenAIResponsesToolCallIds` applies to a replayed `call_id`/`call_id|fc_id` pair. */
export function normalizeOpenAIResponsesFunctionCallId(id: string): string {
  const { callId, itemId } = splitOpenAIFunctionCallPairing(id);
  const normalizedCallId = normalizeOpenAIResponsesIdPart({
    value: itemId ? `${callId}|${itemId}` : callId,
    prefix: "call_",
    isValid: (value) => OPENAI_RESPONSES_CALL_ID_RE.test(value),
  });

  if (!itemId) {
    return normalizedCallId;
  }

  const normalizedItemId = normalizeOpenAIResponsesIdPart({
    value: itemId,
    prefix: "fc_",
    isValid: (value) => OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE.test(value),
  });
  return `${normalizedCallId}|${normalizedItemId}`;
}

export function shouldNormalizeOpenAIResponsesToolCallId(id: string): boolean {
  const pairing = splitOpenAIFunctionCallPairing(id);
  if (!OPENAI_RESPONSES_CALL_ID_RE.test(pairing.callId)) {
    return true;
  }
  if (pairing.itemId === undefined) {
    return false;
  }
  return !OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE.test(pairing.itemId);
}
