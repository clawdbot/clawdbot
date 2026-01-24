import type { AgentMessage } from "@mariozechner/pi-agent-core";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

function isOrphanedOpenAIReasoningSignature(signature: string): boolean {
  const trimmed = signature.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; type?: unknown };
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (!id.startsWith("rs_")) return false;
    if (type === "reasoning") return true;
    if (type.startsWith("reasoning.")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
 * without the required following item.
 *
 * Clawdbot persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
 * is incomplete, we downgrade the block to plain text (or drop it if empty) to keep history usable.
 */
export function downgradeOpenAIReasoningBlocks(messages: AgentMessage[]): AgentMessage[] {
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
    type AssistantContentBlock = (typeof assistantMsg.content)[number];

    const nextContent = assistantMsg.content.flatMap((block): AssistantContentBlock[] => {
      if (!block || typeof block !== "object") return [block as AssistantContentBlock];

      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") return [block as AssistantContentBlock];

      const signature = typeof record.thinkingSignature === "string" ? record.thinkingSignature : "";
      if (!signature || !isOrphanedOpenAIReasoningSignature(signature)) {
        return [block as AssistantContentBlock];
      }

      const thinking = typeof record.thinking === "string" ? record.thinking : "";
      const trimmed = thinking.trim();
      changed = true;
      if (!trimmed) return [];
      return [{ type: "text" as const, text: thinking }];
    });

    if (!changed) {
      out.push(msg);
      continue;
    }

    if (nextContent.length === 0) {
      continue;
    }

    out.push({ ...assistantMsg, content: nextContent } as AgentMessage);
  }

  return out;
}
