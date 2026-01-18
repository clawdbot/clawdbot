import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { makeMissingToolResult } from "./session-transcript-repair.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

type ToolCall = { id: string; name?: string };

const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;

function stripFinalTagsFromText(text: string): string {
  if (!text) return text;
  return text.replace(FINAL_TAG_RE, "");
}

function stripFinalTagsFromAssistant(message: Extract<AgentMessage, { role: "assistant" }>) {
  const content = message.content;
  if (typeof content === "string") {
    const cleaned = stripFinalTagsFromText(content);
    return cleaned === content
      ? message
      : ({ ...message, content: cleaned } as unknown as AgentMessage);
  }
  if (!Array.isArray(content)) return message;

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      const cleaned = stripFinalTagsFromText(record.text);
      if (cleaned !== record.text) {
        changed = true;
        return { ...record, text: cleaned };
      }
    }
    return block;
  });

  if (!changed) return message;
  return { ...message, content: next } as AgentMessage;
}

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const toolCalls: ToolCall[] = [];
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

export function installSessionToolResultGuard(sessionManager: SessionManager): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

  const flushPendingToolResults = () => {
    if (pending.size === 0) return;
    for (const [id, name] of pending.entries()) {
      originalAppend(makeMissingToolResult({ toolCallId: id, toolName: name }));
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    const role = (message as { role?: unknown }).role;

    if (role === "toolResult") {
      const id = extractToolResultId(message as Extract<AgentMessage, { role: "toolResult" }>);
      if (id) pending.delete(id);
      return originalAppend(message as never);
    }

    const sanitized =
      role === "assistant"
        ? stripFinalTagsFromAssistant(message as Extract<AgentMessage, { role: "assistant" }>)
        : message;
    const toolCalls =
      role === "assistant"
        ? extractAssistantToolCalls(sanitized as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    // If previous tool calls are still pending, flush before non-tool results.
    if (pending.size > 0 && (toolCalls.length === 0 || role !== "assistant")) {
      flushPendingToolResults();
    }
    // If new tool calls arrive while older ones are pending, flush the old ones first.
    if (pending.size > 0 && toolCalls.length > 0) {
      flushPendingToolResults();
    }

    const result = originalAppend(sanitized as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
