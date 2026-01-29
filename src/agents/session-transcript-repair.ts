import type { AgentMessage } from "@mariozechner/pi-agent-core";

type ToolCallLike = {
  id: string;
  name?: string;
};

function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;

    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) return toolUseId;
  return null;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[moltbot] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

export { makeMissingToolResult };

export function sanitizeToolUseResultPairing(messages: AgentMessage[]): AgentMessage[] {
  return repairToolUseResultPairing(messages).messages;
}

export type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
  /** If truncation occurred, details about what was dropped. */
  truncation?: {
    /** Index in original messages where truncation happened. */
    truncatedAtIndex: number;
    /** Tool call IDs that were missing results. */
    missingToolCallIds: string[];
    /** Number of messages dropped. */
    messagesDropped: number;
  };
};

/**
 * Find all tool result IDs that exist anywhere in the message array.
 */
function indexAllToolResultIds(messages: AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if ((msg as { role?: unknown }).role === "toolResult") {
      const id = extractToolResultId(msg as Extract<AgentMessage, { role: "toolResult" }>);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Find the first assistant message with tool calls that has ANY missing results.
 * Returns the index of that assistant message, or -1 if all are complete.
 */
function findFirstIncompleteToolCallIndex(messages: AgentMessage[]): {
  index: number;
  missingIds: string[];
} | null {
  const allResultIds = indexAllToolResultIds(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if ((msg as { role?: unknown }).role !== "assistant") continue;

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) continue;

    const missingIds: string[] = [];
    for (const call of toolCalls) {
      if (!allResultIds.has(call.id)) {
        missingIds.push(call.id);
      }
    }

    if (missingIds.length > 0) {
      return { index: i, missingIds };
    }
  }

  return null;
}

export function repairToolUseResultPairing(messages: AgentMessage[]): ToolUseRepairReport {
  // Anthropic (and similar APIs) reject transcripts where assistant tool calls are not
  // followed by matching tool results. This can happen when:
  // - Session branching separates tool calls from their results
  // - Interruptions (crash, network, user edit) occur mid-tool-execution
  // - Compaction/pruning breaks the pairing
  //
  // Strategy: TRUNCATE at the first incomplete tool call sequence.
  // This is simpler and safer than trying to repair with synthetic results:
  // - Always produces valid history (just shorter)
  // - No confusing synthetic error results in conversation
  // - Agent continues working, may just need to redo some work
  //
  // After truncation, we still:
  // - Move displaced tool results to correct positions
  // - Drop duplicate tool results
  // - Drop orphaned tool results (results without matching calls)

  // First pass: check if truncation is needed
  const incomplete = findFirstIncompleteToolCallIndex(messages);
  let workingMessages = messages;
  let truncation: ToolUseRepairReport["truncation"];

  if (incomplete) {
    // Truncate before the incomplete assistant message
    workingMessages = messages.slice(0, incomplete.index);
    truncation = {
      truncatedAtIndex: incomplete.index,
      missingToolCallIds: incomplete.missingIds,
      messagesDropped: messages.length - incomplete.index,
    };
  }

  // Second pass: repair ordering and duplicates in the (possibly truncated) messages
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = truncation !== undefined;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) seenToolResultIds.add(id);
    out.push(msg);
  };

  for (let i = 0; i < workingMessages.length; i += 1) {
    const msg = workingMessages[i] as AgentMessage;
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      // Tool results must only appear directly after the matching assistant tool call turn.
      // Any "free-floating" toolResult entries can make strict providers reject the request.
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < workingMessages.length; j += 1) {
      const next = workingMessages[j] as AgentMessage;
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = (next as { role?: unknown }).role;
      if (nextRole === "assistant") break;

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      // Drop tool results that don't match the current assistant tool calls.
      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    // All tool calls should have results (we truncated incomplete ones above)
    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      }
      // No synthetic results - we truncated incomplete sequences
    }

    for (const rem of remainder) {
      if (!rem || typeof rem !== "object") {
        out.push(rem);
        continue;
      }
      out.push(rem);
    }
    i = j - 1;
  }

  const changedOrMoved = changed || moved;
  return {
    messages: changedOrMoved ? out : workingMessages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changedOrMoved,
    truncation,
  };
}
