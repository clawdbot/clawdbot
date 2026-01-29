import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MoltbotConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Check if an assistant message has tool calls that need results
 */
function hasToolCalls(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
  if (!Array.isArray(assistant.content)) return false;

  return assistant.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const rec = block as { type?: unknown; id?: unknown };
    return (
      (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") &&
      typeof rec.id === "string" &&
      rec.id
    );
  });
}

/**
 * Count consecutive tool result messages following the given index
 */
function countFollowingToolResults(messages: AgentMessage[], startIndex: number): number {
  let count = 0;
  for (let i = startIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "toolResult") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 *
 * IMPORTANT: This function is tool-call-aware. If slicing would separate an
 * assistant message with tool calls from its tool results, it adjusts the
 * slice boundary to include the complete assistant + tool results sequence.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) return messages;

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        // Before slicing at lastUserIndex, check if the message immediately before
        // the slice point is a toolResult. If so, we need to include its corresponding
        // assistant to avoid breaking the tool call/result pairing.
        let sliceIndex = lastUserIndex;

        // Only adjust if there's actually a toolResult at the boundary
        if (lastUserIndex > 0 && messages[lastUserIndex - 1].role === "toolResult") {
          // Walk back through consecutive tool result messages to find the assistant
          let j = lastUserIndex - 1;
          while (j >= 0 && messages[j].role === "toolResult") {
            j--;
          }

          // If we found an assistant with tool calls immediately before the tool results,
          // we need to include it to avoid breaking the tool call/result pairing.
          if (j >= 0 && hasToolCalls(messages[j])) {
            sliceIndex = j;
          }
        }

        return messages.slice(sliceIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
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
