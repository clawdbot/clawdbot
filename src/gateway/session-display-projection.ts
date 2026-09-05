import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { stripEnvelope } from "./chat-sanitize.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;
const SESSION_DISPLAY_PROJECTION_MAX_CHARS = 800;

type SessionDisplayProjection = {
  role: "user" | "assistant";
  text: string;
};

type SessionDisplayProjectionOptions = {
  flattenMarkdown?: boolean;
  view?: "display" | "model-context";
  maxChars?: number;
};

function extractUserText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content.flatMap((block) => {
      const entry = readRecord(block);
      if (!entry) {
        return [];
      }
      return (entry.type === "text" || entry.type === "input_text") &&
        typeof entry.text === "string"
        ? [entry.text]
        : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return typeof message.text === "string" ? message.text : undefined;
}

/** Projects text after model-context selection, or applies ordinary display visibility. */
export function projectSessionDisplayMessage(
  message: unknown,
  options: SessionDisplayProjectionOptions = {},
): SessionDisplayProjection | null {
  const entry = readRecord(message);
  if (!entry || (options.view !== "model-context" && entry.display === false)) {
    return null;
  }
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const extracted =
    role === "assistant" ? extractAssistantPhaseText(entry) : extractUserText(entry);
  let text = extracted?.trim();
  if (!text || (role === "assistant" && isSuppressedControlReplyText(text))) {
    return null;
  }
  if (role === "user") {
    text = stripEnvelope(text).trim();
  }
  if (options.flattenMarkdown) {
    text = flattenMarkdownToPlainText(text);
  }
  if (!text) {
    return null;
  }
  const requestedMaxChars = options.maxChars ?? SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS;
  const limit = Math.min(
    SESSION_DISPLAY_PROJECTION_MAX_CHARS,
    Math.max(20, Math.floor(requestedMaxChars)),
  );
  return {
    role,
    text: text.length <= limit ? text : `${truncateUtf16Safe(text, limit - 3)}...`,
  };
}
