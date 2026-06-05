/**
 * Normalizes OpenAI Responses reasoning/tool-call history for safe replay.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "../runtime/index.js";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

type OpenAIToolCallBlock = {
  type?: unknown;
  id?: unknown;
};

type OpenAIReasoningSignature = {
  id: string;
  type: string;
};

type DowngradeOpenAIReasoningBlocksOptions = {
  dropReplayableReasoning?: boolean;
};

const OPENAI_RESPONSES_ID_MAX_LENGTH = 64;
const OPENAI_RESPONSES_CALL_ID_RE = /^call_[A-Za-z0-9_-]{1,59}$/;
const OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE = /^fc_[A-Za-z0-9_-]{1,61}$/;

function parseOpenAIReasoningSignature(value: unknown): OpenAIReasoningSignature | null {
  if (!value) {
    return null;
  }
  let candidate: { id?: unknown; type?: unknown } | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      candidate = JSON.parse(trimmed) as { id?: unknown; type?: unknown };
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    candidate = value as { id?: unknown; type?: unknown };
  }
  if (!candidate) {
    return null;
  }
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const type = typeof candidate.type === "string" ? candidate.type : "";
  if (!id.startsWith("rs_")) {
    return null;
  }
  if (type === "reasoning" || type.startsWith("reasoning.")) {
    return { id, type };
  }
  return null;
}

function hasFollowingNonThinkingBlock(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
  index: number,
): boolean {
  for (let i = index + 1; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "thinking") {
      return true;
    }
  }
  return false;
}

function splitOpenAIFunctionCallPairing(id: string): {
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

function isOpenAIToolCallType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

function shortOpenAIResponsesIdHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
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

function normalizeOpenAIResponsesFunctionCallId(id: string): string {
  const { callId, itemId } = splitOpenAIFunctionCallPairing(id);
  const normalizedCallId = normalizeOpenAIResponsesIdPart({
    value: callId,
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

function shouldNormalizeOpenAIResponsesToolCallId(id: string): boolean {
  const pairing = splitOpenAIFunctionCallPairing(id);
  if (!OPENAI_RESPONSES_CALL_ID_RE.test(pairing.callId)) {
    return true;
  }
  if (pairing.itemId === undefined) {
    return false;
  }
  return !OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE.test(pairing.itemId);
}

function createOpenAIResponsesToolCallIdResolver(): {
  resolveAssistantId: (id: string) => string;
  resolveToolResultId: (id: string) => string;
} {
  const rewrittenByOriginalId = new Map<string, string>();

  return {
    resolveAssistantId(id: string): string {
      const rewritten = rewrittenByOriginalId.get(id);
      if (rewritten) {
        return rewritten;
      }
      if (!shouldNormalizeOpenAIResponsesToolCallId(id)) {
        return id;
      }
      const normalized = normalizeOpenAIResponsesFunctionCallId(id);
      rewrittenByOriginalId.set(id, normalized);
      return normalized;
    },
    resolveToolResultId(id: string): string {
      const rewritten = rewrittenByOriginalId.get(id);
      if (rewritten) {
        return rewritten;
      }
      if (!shouldNormalizeOpenAIResponsesToolCallId(id)) {
        return id;
      }
      const normalized = normalizeOpenAIResponsesFunctionCallId(id);
      rewrittenByOriginalId.set(id, normalized);
      return normalized;
    },
  };
}

/**
 * OpenAI Responses rejects replayed `function_call.call_id`,
 * `function_call.id`, and matching `function_call_output.call_id` values
 * that exceed its 64-char `call_*` / `fc_*` shape. pi-ai skips its own
 * normalizer for same-model replay, then splits persisted `call_id|fc_id`
 * pairs directly into the provider payload, so OpenClaw must normalize here.
 */
export function normalizeOpenAIResponsesToolCallIds(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const resolver = createOpenAIResponsesToolCallIdResolver();
  const rewrittenMessages: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      rewrittenMessages.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        rewrittenMessages.push(msg);
        continue;
      }

      let assistantChanged = false;
      const nextContent = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const nextId = resolver.resolveAssistantId(toolCallBlock.id);
        if (nextId === toolCallBlock.id) {
          return block;
        }
        assistantChanged = true;
        return {
          ...(block as unknown as Record<string, unknown>),
          id: nextId,
        } as typeof block;
      });

      if (!assistantChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push({ ...assistantMsg, content: nextContent } as AgentMessage);
      continue;
    }

    if (role === "toolResult") {
      const toolResult = msg as Extract<AgentMessage, { role: "toolResult" }> & {
        toolUseId?: unknown;
      };
      let toolResultChanged = false;
      const updates: Record<string, string> = {};

      if (typeof toolResult.toolCallId === "string") {
        const nextToolCallId = resolver.resolveToolResultId(toolResult.toolCallId);
        if (nextToolCallId !== toolResult.toolCallId) {
          updates.toolCallId = nextToolCallId;
          toolResultChanged = true;
        }
      }

      if (typeof toolResult.toolUseId === "string") {
        const nextToolUseId = resolver.resolveToolResultId(toolResult.toolUseId);
        if (nextToolUseId !== toolResult.toolUseId) {
          updates.toolUseId = nextToolUseId;
          toolResultChanged = true;
        }
      }

      if (!toolResultChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push({ ...toolResult, ...updates } as AgentMessage);
      continue;
    }

    rewrittenMessages.push(msg);
  }

  return changed ? rewrittenMessages : messages;
}

/**
 * OpenAI can reject replayed `function_call` items with an `fc_*` id if the
 * matching `reasoning` item is absent in the same assistant turn.
 *
 * When that pairing is missing, strip the `|fc_*` suffix from tool call ids so
 * shared model runtime omits `function_call.id` on replay.
 */
export function downgradeOpenAIFunctionCallReasoningPairs(
  messages: AgentMessage[],
): AgentMessage[] {
  let changed = false;
  const rewrittenMessages: AgentMessage[] = [];
  let pendingRewrittenIds: Map<string, string> | null = null;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      pendingRewrittenIds = null;
      rewrittenMessages.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        pendingRewrittenIds = null;
        rewrittenMessages.push(msg);
        continue;
      }

      const localRewrittenIds = new Map<string, string>();
      let seenReplayableReasoning = false;
      let assistantChanged = false;
      const nextContent = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }

        const thinkingBlock = block as OpenAIThinkingBlock;
        if (
          thinkingBlock.type === "thinking" &&
          parseOpenAIReasoningSignature(thinkingBlock.thinkingSignature)
        ) {
          seenReplayableReasoning = true;
          return block;
        }

        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const pairing = splitOpenAIFunctionCallPairing(toolCallBlock.id);
        if (seenReplayableReasoning || !pairing.itemId || !pairing.itemId.startsWith("fc_")) {
          return block;
        }

        assistantChanged = true;
        localRewrittenIds.set(toolCallBlock.id, pairing.callId);
        return {
          ...(block as unknown as Record<string, unknown>),
          id: pairing.callId,
        } as typeof block;
      });

      pendingRewrittenIds = localRewrittenIds.size > 0 ? localRewrittenIds : null;
      if (!assistantChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push({ ...assistantMsg, content: nextContent } as AgentMessage);
      continue;
    }

    if (role === "toolResult" && pendingRewrittenIds && pendingRewrittenIds.size > 0) {
      const toolResult = msg as Extract<AgentMessage, { role: "toolResult" }> & {
        toolUseId?: unknown;
      };
      let toolResultChanged = false;
      const updates: Record<string, string> = {};

      if (typeof toolResult.toolCallId === "string") {
        const nextToolCallId = pendingRewrittenIds.get(toolResult.toolCallId);
        if (nextToolCallId && nextToolCallId !== toolResult.toolCallId) {
          updates.toolCallId = nextToolCallId;
          toolResultChanged = true;
        }
      }

      if (typeof toolResult.toolUseId === "string") {
        const nextToolUseId = pendingRewrittenIds.get(toolResult.toolUseId);
        if (nextToolUseId && nextToolUseId !== toolResult.toolUseId) {
          updates.toolUseId = nextToolUseId;
          toolResultChanged = true;
        }
      }

      if (!toolResultChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push({
        ...toolResult,
        ...updates,
      } as AgentMessage);
      continue;
    }

    pendingRewrittenIds = null;
    rewrittenMessages.push(msg);
  }

  return changed ? rewrittenMessages : messages;
}

/**
 * Extracts the Responses `phase` (commentary/final_answer) from a v1 textSignature, if present.
 * Used when dropping the paired msg_* id so phase metadata can be preserved independently.
 */
function extractTextSignaturePhase(signature: string): "commentary" | "final_answer" | undefined {
  if (!signature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
    if (parsed.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) {
      return parsed.phase;
    }
  } catch {
    // Not a structured signature; nothing to preserve.
  }
  return undefined;
}

/**
 * OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
 * without the required following item, or stale encrypted reasoning after a model route switch.
 *
 * OpenClaw persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
 * is incomplete or no longer replay-safe, drop the block to keep history usable.
 */
export function downgradeOpenAIReasoningBlocks(
  messages: AgentMessage[],
  options: DowngradeOpenAIReasoningBlocksOptions = {},
): AgentMessage[] {
  let anyChanged = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      out.push(msg);
      continue;
    }

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      out.push(msg);
      continue;
    }

    let changed = false;
    let droppedReplayableReasoning = false;
    type AssistantContentBlock = (typeof assistantMsg.content)[number];

    const nextContent: AssistantContentBlock[] = [];
    for (let i = 0; i < assistantMsg.content.length; i++) {
      const block = assistantMsg.content[i];
      if (!block || typeof block !== "object") {
        nextContent.push(block as AssistantContentBlock);
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      const signature = parseOpenAIReasoningSignature(record.thinkingSignature);
      if (!signature) {
        nextContent.push(block);
        continue;
      }
      if (options.dropReplayableReasoning) {
        changed = true;
        droppedReplayableReasoning = true;
        continue;
      }
      if (hasFollowingNonThinkingBlock(assistantMsg.content, i)) {
        nextContent.push(block);
        continue;
      }
      changed = true;
    }

    if (!changed) {
      out.push(msg);
      continue;
    }

    anyChanged = true;
    if (nextContent.length === 0) {
      continue;
    }

    // When a replayable reasoning (rs_*) item is dropped after a model/fallback
    // switch, its paired assistant message id (msg_*) must be dropped too. The
    // Responses transport replays msg_* from a text block textSignature, so an
    // orphaned msg_* without its rs_* makes providers like Azure reject the next
    // turn (issue #88019). Drop the id from the signature, but keep any phase
    // metadata (commentary/final_answer) so the Responses phase contract survives.
    const finalContent = droppedReplayableReasoning
      ? nextContent.map((contentBlock) => {
          if (!contentBlock || typeof contentBlock !== "object") {
            return contentBlock;
          }
          if (contentBlock.type !== "text" || contentBlock.textSignature === undefined) {
            return contentBlock;
          }
          const phase = extractTextSignaturePhase(contentBlock.textSignature);
          const { textSignature: _droppedTextSignature, ...rest } = contentBlock;
          return phase !== undefined
            ? { ...rest, textSignature: JSON.stringify({ v: 1, phase }) }
            : rest;
        })
      : nextContent;

    out.push({ ...assistantMsg, content: finalContent } as AgentMessage);
  }

  return anyChanged ? out : messages;
}
