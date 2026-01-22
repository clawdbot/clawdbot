import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];

export function isEmptyAssistantMessageContent(
  message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
  const content = message.content;
  if (content == null) return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => {
    if (!block || typeof block !== "object") return true;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type !== "text") return false;
    return typeof rec.text !== "string" || rec.text.trim().length === 0;
  });
}

function isEmptyAssistantErrorMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
  if (message.stopReason !== "error") return false;
  return isEmptyAssistantMessageContent(message);
}

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
    sanitizeToolCallIds?: boolean;
    /**
     * Mode for tool call ID sanitization:
     * - "standard" (default, preserves _-)
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    enforceToolCallLast?: boolean;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
      allowBase64Only?: boolean;
      includeCamelCase?: boolean;
    };
  },
): Promise<AgentMessage[]> {
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const sanitizedIds = options?.sanitizeToolCallIds
    ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode)
    : messages;
  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content as ContentBlock[],
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (isEmptyAssistantErrorMessage(assistantMsg)) {
        continue;
      }
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        const strippedContent = options?.preserveSignatures
          ? content // Keep signatures for Antigravity Claude
          : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini

        const filteredContent = strippedContent.filter((block) => {
          if (!block || typeof block !== "object") return true;
          const rec = block as { type?: unknown; text?: unknown };
          if (rec.type !== "text" || typeof rec.text !== "string") return true;
          return rec.text.trim().length > 0;
        });

        const normalizedContent = options?.enforceToolCallLast
          ? (() => {
              let lastToolIndex = -1;
              for (let i = filteredContent.length - 1; i >= 0; i -= 1) {
                const block = filteredContent[i];
                if (!block || typeof block !== "object") continue;
                const type = (block as { type?: unknown }).type;
                if (type === "functionCall" || type === "toolUse" || type === "toolCall") {
                  lastToolIndex = i;
                  break;
                }
              }
              if (lastToolIndex === -1) return filteredContent;
              return filteredContent.slice(0, lastToolIndex + 1);
            })()
          : filteredContent;
        const finalContent = (await sanitizeContentBlocksImages(
          normalizedContent as unknown as ContentBlock[],
          label,
        )) as unknown as typeof assistantMsg.content;
        if (finalContent.length === 0) {
          continue;
        }
        out.push({ ...assistantMsg, content: finalContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
