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

    if (
      rec.type === "toolCall" ||
      rec.type === "toolUse" ||
      rec.type === "functionCall"
    ) {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(
  msg: Extract<AgentMessage, { role: "toolResult" }>,
): string | null {
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
        text: "[clawdbot] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
): AgentMessage[] {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same id (anywhere in the transcript)
  const out: AgentMessage[] = [];
  const seenToolResultIds = new Set<string>();

  const pushToolResult = (
    msg: Extract<AgentMessage, { role: "toolResult" }>,
  ) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) return;
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
      if (role === "toolResult") {
        pushToolResult(msg as Extract<AgentMessage, { role: "toolResult" }>);
      } else {
        out.push(msg);
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

    const spanResultsById = new Map<
      string,
      Extract<AgentMessage, { role: "toolResult" }>
    >();
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
        const toolResult = next as Extract<
          AgentMessage,
          { role: "toolResult" }
        >;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      remainder.push(next);
    }

    out.push(msg);

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      pushToolResult(
        existing ??
          makeMissingToolResult({ toolCallId: call.id, toolName: call.name }),
      );
    }

    for (const rem of remainder) {
      if (!rem || typeof rem !== "object") {
        out.push(rem);
        continue;
      }
      const remRole = (rem as { role?: unknown }).role;
      if (remRole === "toolResult") {
        pushToolResult(rem as Extract<AgentMessage, { role: "toolResult" }>);
        continue;
      }
      out.push(rem);
    }
    i = j - 1;
  }

  return out;
}
