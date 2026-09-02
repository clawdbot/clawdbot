/**
 * Sanitizes historical embedded-agent message images and empty content blocks.
 */
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
const EMPTY_CONTENT_PLACEHOLDER = "[empty content omitted]";

function dropEmptyTextBlocks<T>(content: T[]): T[] {
  return content.filter((block) => {
    const rec = block as { type?: unknown; text?: unknown };
    return (
      !block ||
      typeof block !== "object" ||
      rec.type !== "text" ||
      typeof rec.text !== "string" ||
      rec.text.trim().length > 0
    );
  });
}

function ensureNonEmptyContent<T>(content: T[]): T[] {
  if (content.length > 0) {
    return content;
  }
  return [{ type: "text", text: EMPTY_CONTENT_PLACEHOLDER }] as T[];
}

/** Resize/remove unsafe image payloads while keeping transcript turns valid. */
export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
    sanitizeMode?: "full" | "images-only";
    sanitizeToolCallIds?: boolean;
    preserveNativeAnthropicToolUseIds?: boolean;
    duplicateToolCallIdStyle?: "openai";
    /**
     * Mode for tool call ID sanitization:
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
      allowBase64Only?: boolean;
      includeCamelCase?: boolean;
    };
  } & ImageSanitizationLimits,
): Promise<AgentMessage[]> {
  const imageSanitization = {
    maxDimensionPx: options?.maxDimensionPx,
    maxBytes: options?.maxBytes,
  };
  const shouldSanitizeToolCallIds = options?.sanitizeToolCallIds === true;
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (default max side 1200px).
  const sanitizedIds = shouldSanitizeToolCallIds
    ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode, {
        preserveNativeAnthropicToolUseIds: options?.preserveNativeAnthropicToolUseIds,
        duplicateToolCallIdStyle: options?.duplicateToolCallIdStyle,
      })
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
      const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
      out.push({ ...toolMsg, content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent)) });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
        out.push({ ...userMsg, content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent)) });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        const strippedContent =
          assistantMsg.stopReason === "error" || options?.preserveSignatures
            ? content // Keep signatures for Antigravity Claude
            : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini
        const finalContent = (await sanitizeContentBlocksImages(
          dropEmptyTextBlocks(strippedContent) as unknown as ContentBlock[],
          label,
          imageSanitization,
        )) as unknown as typeof assistantMsg.content;
        if (finalContent.length > 0 || assistantMsg.providerReplay) {
          out.push(replaceCompactionReplayOwnerContent(assistantMsg, finalContent));
        }
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
