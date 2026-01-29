import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MoltbotConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Check if a user message is purely a tool result (not a new user turn).
 */
function isToolResultMessage(msg: AgentMessage): boolean {
  if (msg.role !== "user") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  // A tool result message contains only tool_result blocks
  return (
    content.length > 0 &&
    content.every((block) => {
      if (!block || typeof block !== "object") return false;
      const type = (block as { type?: unknown }).type;
      return type === "tool_result";
    })
  );
}

function extractToolUseIdsFromAssistant(msg: AgentMessage): string[] {
  if (msg.role !== "assistant") return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown };
    if (
      (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") &&
      typeof rec.id === "string"
    ) {
      ids.push(rec.id);
    }
  }
  return ids;
}

function extractToolUseIdFromResult(msg: AgentMessage): string | null {
  if (msg.role !== "user") return null;
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const block = content[0] as { tool_use_id?: unknown; toolCallId?: unknown };
  const id = block.tool_use_id ?? block.toolCallId;
  return typeof id === "string" ? id : null;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 * Tool result messages are not counted as new user turns.
 *
 * CRITICAL: When truncating, we must preserve tool_use + tool_result pairs.
 * A tool_result that follows its tool_use belongs to the same logical turn,
 * even if they're separated by assistant responses.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) return messages;

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !isToolResultMessage(msg)) {
      userCount++;
      if (userCount > limit) {
        break;
      }
      lastUserIndex = i;
    }
  }

  if (lastUserIndex === 0 || lastUserIndex === messages.length) {
    return messages;
  }

  const slice = messages.slice(lastUserIndex);

  const positionsToAdd = new Set<number>();
  for (let i = 0; i < slice.length; i++) {
    const msg = slice[i];
    if (isToolResultMessage(msg)) {
      const toolId = extractToolUseIdFromResult(msg);
      if (toolId) {
        let j = lastUserIndex + i - 1;
        for (; j >= 0; j--) {
          const prev = messages[j];
          const toolIds = extractToolUseIdsFromAssistant(prev);
          if (toolIds.includes(toolId)) {
            positionsToAdd.add(j);
            break;
          }
        }
      }
    }
  }

  if (positionsToAdd.size === 0) {
    return slice;
  }

  const minPositionToAdd = Math.min(...positionsToAdd);
  const result: AgentMessage[] = [];
  for (let i = minPositionToAdd; i < messages.length; i++) {
    const inSlice = i >= lastUserIndex;
    const inPositionsToAdd = positionsToAdd.has(i);
    if (inSlice || inPositionsToAdd) {
      result.push(messages[i]);
    }
  }
  return result;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: MoltbotConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) return undefined;

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) return undefined;

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") return undefined;

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) return undefined;
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: MoltbotConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") return undefined;
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
