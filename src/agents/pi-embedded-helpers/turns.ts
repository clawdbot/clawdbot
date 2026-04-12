import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";

type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolCall" | "functionCall" | "toolResult" | "tool";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
  toolCallId?: string;
};

function isToolCallBlock(block: AnthropicContentBlock): boolean {
  return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}

function isThinkingLikeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function isAbortedAssistantTurn(message: AgentMessage): boolean {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return stopReason === "aborted" || stopReason === "error";
}

function extractToolResultMatchIds(record: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of [
    record.toolUseId,
    record.toolCallId,
    record.tool_use_id,
    record.tool_call_id,
    record.callId,
    record.call_id,
  ]) {
    const id = normalizeOptionalString(value);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function extractToolResultMatchName(record: Record<string, unknown>): string | null {
  return normalizeOptionalString(record.toolName) ?? normalizeOptionalString(record.name) ?? null;
}

function collectAnyToolResultIds(message: AgentMessage): Set<string> {
  const ids = new Set<string>();
  const role = (message as { role?: unknown }).role;
  if (role === "toolResult") {
    const toolResultId = extractToolResultId(
      message as Extract<AgentMessage, { role: "toolResult" }>,
    );
    if (toolResultId) {
      ids.add(toolResultId);
    }
  } else if (role === "tool") {
    const record = message as unknown as Record<string, unknown>;
    for (const id of extractToolResultMatchIds(record)) {
      ids.add(id);
    }
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return ids;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "toolResult" && record.type !== "tool") {
      continue;
    }
    for (const id of extractToolResultMatchIds(record)) {
      ids.add(id);
    }
  }

  return ids;
}

function collectTrustedToolResultMatches(message: AgentMessage): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  const role = (message as { role?: unknown }).role;
  const addMatch = (ids: Iterable<string>, toolName: string | null) => {
    for (const id of ids) {
      const bucket = matches.get(id) ?? new Set<string>();
      if (toolName) {
        bucket.add(toolName);
      }
      matches.set(id, bucket);
    }
  };

  if (role === "toolResult") {
    const record = message as unknown as Record<string, unknown>;
    addMatch(
      [
        ...extractToolResultMatchIds(record),
        ...(() => {
          const canonicalId = extractToolResultId(
            message as Extract<AgentMessage, { role: "toolResult" }>,
          );
          return canonicalId ? [canonicalId] : [];
        })(),
      ],
      extractToolResultMatchName(record),
    );
  } else if (role === "tool") {
    const record = message as unknown as Record<string, unknown>;
    addMatch(extractToolResultMatchIds(record), extractToolResultMatchName(record));
  }

  return matches;
}

function collectFutureToolResultMatches(
  messages: AgentMessage[],
  startIndex: number,
): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role === "assistant") {
      break;
    }
    for (const [id, toolNames] of collectTrustedToolResultMatches(candidate)) {
      const bucket = matches.get(id) ?? new Set<string>();
      for (const toolName of toolNames) {
        bucket.add(toolName);
      }
      matches.set(id, bucket);
    }
  }
  return matches;
}

function collectFutureToolResultIds(messages: AgentMessage[], startIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role === "assistant") {
      break;
    }
    for (const id of collectAnyToolResultIds(candidate)) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Strips dangling tool-call blocks from assistant messages when no later
 * tool-result span before the next assistant turn resolves them.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (msgRole !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg as {
      content?: AnthropicContentBlock[];
    };
    const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    if (originalContent.length === 0) {
      result.push(msg);
      continue;
    }
    if (
      extractToolCallsFromAssistant(msg as Extract<AgentMessage, { role: "assistant" }>).length ===
      0
    ) {
      result.push(msg);
      continue;
    }
    const hasThinking = originalContent.some((block) => isThinkingLikeBlock(block));
    const validToolResultMatches = collectFutureToolResultMatches(messages, i);
    const validToolUseIds = collectFutureToolResultIds(messages, i);

    if (hasThinking) {
      const allToolCallsResolvable = originalContent.every((block) => {
        if (!block || !isToolCallBlock(block)) {
          return true;
        }
        const blockId = normalizeOptionalString(block.id);
        const blockName = normalizeOptionalString(block.name);
        if (!blockId || !blockName) {
          return false;
        }
        const matchingToolNames = validToolResultMatches.get(blockId);
        if (!matchingToolNames) {
          return false;
        }
        return matchingToolNames.size === 0 || matchingToolNames.has(blockName);
      });
      if (allToolCallsResolvable) {
        result.push(msg);
      } else {
        result.push({
          ...assistantMsg,
          content: isAbortedAssistantTurn(msg)
            ? []
            : ([{ type: "text", text: "[tool calls omitted]" }] as AnthropicContentBlock[]),
        } as AgentMessage);
      }
      continue;
    }

    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (!isToolCallBlock(block)) {
        return true;
      }
      const blockId = normalizeOptionalString(block.id);
      return blockId ? validToolUseIds.has(blockId) : false;
    });

    if (filteredContent.length === originalContent.length) {
      result.push(msg);
      continue;
    }

    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...assistantMsg,
        content: isAbortedAssistantTurn(msg)
          ? []
          : ([{ type: "text", text: "[tool calls omitted]" }] as AnthropicContentBlock[]),
      } as AgentMessage);
    } else {
      result.push({
        ...assistantMsg,
        content: filteredContent,
      } as AgentMessage);
    }
  }

  return result;
}

function validateTurnsWithConsecutiveMerge<TRole extends "assistant" | "user">(params: {
  messages: AgentMessage[];
  role: TRole;
  merge: (
    previous: Extract<AgentMessage, { role: TRole }>,
    current: Extract<AgentMessage, { role: TRole }>,
  ) => Extract<AgentMessage, { role: TRole }>;
}): AgentMessage[] {
  const { messages, role, merge } = params;
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === role) {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: TRole }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastTyped = lastMsg as Extract<AgentMessage, { role: TRole }>;
        result[result.length - 1] = merge(lastTyped, currentMsg);
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

function mergeConsecutiveAssistantTurns(
  previous: Extract<AgentMessage, { role: "assistant" }>,
  current: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];
  return {
    ...previous,
    content: mergedContent,
    ...(current.usage && { usage: current.usage }),
    ...(current.stopReason && { stopReason: current.stopReason }),
    ...(current.errorMessage && {
      errorMessage: current.errorMessage,
    }),
  };
}

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
}

export function mergeConsecutiveUserTurns(
  previous: Extract<AgentMessage, { role: "user" }>,
  current: Extract<AgentMessage, { role: "user" }>,
): Extract<AgentMessage, { role: "user" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];

  return {
    ...current,
    content: mergedContent,
    timestamp: current.timestamp ?? previous.timestamp,
  };
}

/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also strips dangling tool_use blocks that lack corresponding tool_result blocks.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // First, strip dangling tool-call blocks from assistant messages.
  const stripped = stripDanglingAnthropicToolUses(messages);

  return validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
