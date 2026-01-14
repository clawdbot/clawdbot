import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return (
    api === "google-gemini-cli" ||
    api === "google-generative-ai" ||
    api === "google-antigravity"
  );
}

export { sanitizeGoogleTurnOrdering };

/**
 * Downgrades tool calls that are missing `thought_signature` (required by Gemini)
 * into text representations, to prevent 400 INVALID_ARGUMENT errors.
 * Also converts corresponding tool results into user messages.
 */
type GeminiToolCallBlock = {
  type?: unknown;
  thought_signature?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  toolName?: unknown;
  arguments?: unknown;
  input?: unknown;
};

export function downgradeGeminiHistory(
  messages: AgentMessage[],
): AgentMessage[] {
  const downgradedIds = new Set<string>();
  const out: AgentMessage[] = [];

  const resolveToolResultId = (
    msg: Extract<AgentMessage, { role: "toolResult" }>,
  ): string | undefined => {
    const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === "string" && toolCallId) return toolCallId;
    const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
    if (typeof toolUseId === "string" && toolUseId) return toolUseId;
    return undefined;
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        out.push(msg);
        continue;
      }

      let hasDowngraded = false;
      const newContent = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        const blockRecord = block as GeminiToolCallBlock;
        const type = blockRecord.type;
        if (
          type === "toolCall" ||
          type === "functionCall" ||
          type === "toolUse"
        ) {
          const hasSignature = Boolean(blockRecord.thought_signature);
          if (!hasSignature) {
            const id =
              typeof blockRecord.id === "string"
                ? blockRecord.id
                : typeof blockRecord.toolCallId === "string"
                  ? blockRecord.toolCallId
                  : undefined;
            const name =
              typeof blockRecord.name === "string"
                ? blockRecord.name
                : typeof blockRecord.toolName === "string"
                  ? blockRecord.toolName
                  : undefined;
            const args =
              blockRecord.arguments !== undefined
                ? blockRecord.arguments
                : blockRecord.input;

            if (id) downgradedIds.add(id);
            hasDowngraded = true;

            const argsText =
              typeof args === "string" ? args : JSON.stringify(args, null, 2);

            return {
              type: "text",
              text: `[Tool Call: ${name ?? "unknown"}${
                id ? ` (ID: ${id})` : ""
              }]\nArguments: ${argsText}`,
            };
          }
        }
        return block;
      });

      out.push(
        hasDowngraded
          ? ({ ...assistantMsg, content: newContent } as AgentMessage)
          : msg,
      );
      continue;
    }

    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const toolResultId = resolveToolResultId(toolMsg);
      if (toolResultId && downgradedIds.has(toolResultId)) {
        let textContent = "";
        if (Array.isArray(toolMsg.content)) {
          textContent = toolMsg.content
            .map((entry) => {
              if (entry && typeof entry === "object") {
                const text = (entry as { text?: unknown }).text;
                if (typeof text === "string") return text;
              }
              return JSON.stringify(entry);
            })
            .join("\n");
        } else {
          textContent = JSON.stringify(toolMsg.content);
        }

        out.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[Tool Result for ID ${toolResultId}]\n${textContent}`,
            },
          ],
        } as AgentMessage);

        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
