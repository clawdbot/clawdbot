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
    const rec = block as { type?: unknown; id?: unknown; name?: unknown; partialJson?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;

    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      // Skip incomplete tool calls that have partialJson (indicates streaming error mid-parse)
      if (rec.partialJson !== undefined) {
        continue;
      }
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

/**
 * Remove incomplete/partial tool calls from assistant message content.
 * These occur when streaming fails mid-tool-call (e.g., JSON parse errors).
 * Keeping them causes orphan tool_result errors with the API since the
 * tool_use block is malformed but a synthetic tool_result gets inserted.
 */
function stripIncompleteToolCalls(
  assistant: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> {
  const content = assistant.content;
  if (!Array.isArray(content)) return assistant;

  // Check if this is an error response - if so, filter out incomplete tool calls
  const rec = assistant as { stopReason?: unknown; errorMessage?: unknown };
  const isErrorResponse = rec.stopReason === "error" || rec.errorMessage !== undefined;
  if (!isErrorResponse) return assistant;

  const filteredContent = content.filter((block) => {
    if (!block || typeof block !== "object") return true;
    const blockRec = block as { type?: unknown; partialJson?: unknown };
    // Remove tool calls that have partialJson (incomplete parsing)
    if (
      (blockRec.type === "toolCall" || blockRec.type === "toolUse" || blockRec.type === "functionCall") &&
      blockRec.partialJson !== undefined
    ) {
      return false;
    }
    return true;
  });

  // If nothing changed, return original
  if (filteredContent.length === content.length) return assistant;

  // Return a new message with filtered content
  return {
    ...assistant,
    content: filteredContent,
  } as Extract<AgentMessage, { role: "assistant" }>;
}

export type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
};

export function repairToolUseResultPairing(messages: AgentMessage[]): ToolUseRepairReport {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - removing incomplete tool calls from error responses (prevents orphan tool_results)
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same id (anywhere in the transcript)
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

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

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i] as AgentMessage;
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      // Tool results must only appear directly after the matching assistant tool call turn.
      // Any "free-floating" toolResult entries in session history can make strict providers
      // (Anthropic-compatible APIs, MiniMax, Cloud Code Assist) reject the entire request.
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    // Strip incomplete tool calls from error responses before processing
    const assistant = stripIncompleteToolCalls(msg as Extract<AgentMessage, { role: "assistant" }>);
    if (assistant !== msg) {
      changed = true;
    }
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(assistant);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j] as AgentMessage;
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

    out.push(assistant);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
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
    messages: changedOrMoved ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changedOrMoved,
  };
}
