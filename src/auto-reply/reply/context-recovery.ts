/**
 * Context recovery after compaction.
 *
 * When enabled via `compaction.contextRecovery.messages`, this module fetches recent
 * messages from the session transcript after a compaction event and injects them
 * as context for the agent's next turn.
 */

import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";

/** Result of checking whether context recovery is needed. */
export type ContextRecoveryCheck = {
  /** Whether context recovery should be performed. */
  needed: boolean;
  /** Number of messages to recover. */
  messageCount: number;
  /** Current compaction count (for updating session after recovery). */
  compactionCount: number;
};

/** Recovered message for context injection. */
export type RecoveredMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
};

/** Result of context recovery. */
export type ContextRecoveryResult = {
  /** Whether recovery was successful. */
  ok: boolean;
  /** Recovered messages (empty if none found or recovery failed). */
  messages: RecoveredMessage[];
  /** Formatted context block for system prompt injection. */
  contextBlock: string | null;
  /** Error message if recovery failed. */
  error?: string;
};

/**
 * Resolve the context recovery settings from config.
 */
export function resolveContextRecoverySettings(cfg: MoltbotConfig): {
  enabled: boolean;
  messages: number;
} {
  const contextRecovery = cfg.agents?.defaults?.compaction?.contextRecovery;
  const messages = contextRecovery?.messages ?? 0;
  return {
    enabled: messages > 0,
    messages: Math.min(messages, 50), // Cap at 50 messages max
  };
}

/**
 * Check if context recovery is needed for a session.
 *
 * Recovery is needed when:
 * 1. Context recovery is enabled in config
 * 2. The session has been compacted (compactionCount > 0)
 * 3. We haven't already recovered for this compaction (compactionCount > lastContextRecoveryCompactionCount)
 */
export function checkContextRecoveryNeeded(params: {
  cfg: MoltbotConfig;
  sessionEntry?: SessionEntry;
}): ContextRecoveryCheck {
  const settings = resolveContextRecoverySettings(params.cfg);

  if (!settings.enabled || !params.sessionEntry) {
    return { needed: false, messageCount: 0, compactionCount: 0 };
  }

  const compactionCount = params.sessionEntry.compactionCount ?? 0;
  const lastRecoveryAt = params.sessionEntry.lastContextRecoveryCompactionCount ?? 0;

  // Recovery needed if we've had a compaction since last recovery
  const needed = compactionCount > 0 && compactionCount > lastRecoveryAt;

  return {
    needed,
    messageCount: settings.messages,
    compactionCount,
  };
}

/**
 * Fetch recent messages from session history via Gateway.
 */
async function fetchSessionMessages(params: {
  sessionKey: string;
  limit: number;
}): Promise<RecoveredMessage[]> {
  try {
    const result = (await callGateway({
      method: "chat.history",
      params: {
        sessionKey: params.sessionKey,
        limit: params.limit + 10, // Fetch extra to account for system/tool messages
      },
    })) as { messages?: unknown[] };

    const rawMessages = Array.isArray(result?.messages) ? result.messages : [];

    // Filter and transform to RecoveredMessage format
    const messages: RecoveredMessage[] = [];
    for (const msg of rawMessages) {
      if (!msg || typeof msg !== "object") continue;

      const role = (msg as Record<string, unknown>).role;
      if (role !== "user" && role !== "assistant") continue;

      // Extract text content
      const content = (msg as Record<string, unknown>).content;
      let text = "";

      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // Handle content blocks (e.g., [{type: "text", text: "..."}])
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text"
          ) {
            const blockText = (block as Record<string, unknown>).text;
            if (typeof blockText === "string") {
              text += blockText;
            }
          }
        }
      }

      if (!text.trim()) continue;

      // Skip tool-related messages and system injections
      if (text.startsWith("[tool:") || text.startsWith("[System Event]")) continue;

      const timestamp = (msg as Record<string, unknown>).timestamp;

      messages.push({
        role: role as "user" | "assistant",
        text: text.trim(),
        timestamp: typeof timestamp === "string" ? timestamp : undefined,
      });
    }

    // Return the most recent N messages
    return messages.slice(-params.limit);
  } catch (err) {
    logVerbose(`Context recovery: failed to fetch session history: ${String(err)}`);
    return [];
  }
}

/**
 * Format recovered messages as a context block for system prompt injection.
 */
function formatContextBlock(messages: RecoveredMessage[]): string | null {
  if (messages.length === 0) return null;

  const lines: string[] = [
    "## Recent Conversation (Recovered After Context Compaction)",
    "",
    "The following is a summary of the recent conversation before compaction. Use this to maintain continuity:",
    "",
  ];

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? "User" : "Assistant";
    // Truncate very long messages to avoid bloating context
    const text = msg.text.length > 500 ? `${msg.text.slice(0, 500)}...` : msg.text;
    lines.push(`**${roleLabel}:** ${text}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

/**
 * Perform context recovery: fetch recent messages and format for injection.
 */
export async function recoverContext(params: {
  sessionKey: string;
  messageCount: number;
}): Promise<ContextRecoveryResult> {
  try {
    const messages = await fetchSessionMessages({
      sessionKey: params.sessionKey,
      limit: params.messageCount,
    });

    if (messages.length === 0) {
      return {
        ok: true,
        messages: [],
        contextBlock: null,
      };
    }

    const contextBlock = formatContextBlock(messages);

    logVerbose(
      `Context recovery: recovered ${messages.length} messages for session ${params.sessionKey}`,
    );

    return {
      ok: true,
      messages,
      contextBlock,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logVerbose(`Context recovery failed: ${error}`);
    return {
      ok: false,
      messages: [],
      contextBlock: null,
      error,
    };
  }
}
