import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import { sanitizeAssistantVisibleText } from "../shared/text/assistant-visible-text.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers/sanitize-user-facing-text.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

export {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
} from "../shared/text/assistant-visible-text.js";
export { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";

export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
export function stripThinkingTagsFromText(text: string): string {
  return stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
}

function sanitizeAssistantText(text: string): string {
  return sanitizeAssistantVisibleText(text);
}

function finalizeAssistantExtraction(msg: AssistantMessage, extracted: string): string {
  const errorContext = msg.stopReason === "error";
  return sanitizeUserFacingText(extracted, { errorContext });
}

type AssistantTextExtractionResult = {
  text: string;
  hadRequestedPhase: boolean;
};

function extractAssistantTextForPhase(
  msg: AssistantMessage,
  phase?: AssistantPhase,
): AssistantTextExtractionResult {
  const messagePhase = normalizeAssistantPhase((msg as { phase?: unknown }).phase);
  const shouldIncludeContent = (resolvedPhase?: AssistantPhase) => {
    if (phase) {
      return resolvedPhase === phase;
    }
    return resolvedPhase === undefined;
  };

  if (typeof msg.content === "string") {
    const hadRequestedPhase = phase ? messagePhase === phase : messagePhase === undefined;
    return {
      text: shouldIncludeContent(messagePhase)
        ? finalizeAssistantExtraction(msg, sanitizeAssistantText(msg.content))
        : "",
      hadRequestedPhase,
    };
  }

  if (!Array.isArray(msg.content)) {
    return { text: "", hadRequestedPhase: false };
  }

  const hasExplicitPhasedTextBlocks = msg.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (record.type !== "text") {
      return false;
    }
    return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
  });

  let hadRequestedPhase = false;
  const extracted =
    extractTextFromChatContent(
      msg.content.filter((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const record = block as { type?: unknown; textSignature?: unknown };
        if (record.type !== "text") {
          return false;
        }
        const signature = parseAssistantTextSignature(record.textSignature);
        const resolvedPhase =
          signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
        if (phase ? resolvedPhase === phase : resolvedPhase === undefined) {
          hadRequestedPhase = true;
        }
        return shouldIncludeContent(resolvedPhase);
      }),
      {
        sanitizeText: (text) => sanitizeAssistantText(text),
        joinWith: "\n",
        normalizeText: (text) => text.trim(),
      },
    ) ?? "";

  return {
    text: finalizeAssistantExtraction(msg, extracted),
    hadRequestedPhase,
  };
}

export function extractAssistantVisibleText(msg: AssistantMessage): string {
  const finalAnswerExtraction = extractAssistantTextForPhase(msg, "final_answer");
  if (finalAnswerExtraction.hadRequestedPhase) {
    return finalAnswerExtraction.text.trim() ? finalAnswerExtraction.text : "";
  }

  return extractAssistantTextForPhase(msg).text;
}

export function extractAssistantText(msg: AssistantMessage): string {
  const extracted =
    extractTextFromChatContent(msg.content, {
      sanitizeText: (text) => sanitizeAssistantText(text),
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? "";
  // Only apply keyword-based error rewrites when the assistant message is actually an error.
  // Otherwise normal prose that *mentions* errors (e.g. "context overflow") can get clobbered.
  // Gate on stopReason only — a non-error response with an errorMessage set (e.g. from a
  // background tool failure) should not have its content rewritten (#13935).
  return finalizeAssistantExtraction(msg, extracted);
}

export function extractAssistantThinking(msg: AssistantMessage): string {
  if (!Array.isArray(msg.content)) {
    return "";
  }
  const blocks = msg.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const record = block as unknown as Record<string, unknown>;
      if (record.type === "thinking" && typeof record.thinking === "string") {
        return record.thinking.trim();
      }
      return "";
    })
    .filter(Boolean);
  return blocks.join("\n").trim();
}

export function formatReasoningMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  // Show reasoning in italics (cursive) for markdown-friendly surfaces (Discord, etc.).
  // Keep the plain "Reasoning:" prefix so existing parsing/detection keeps working.
  // Note: Underscore markdown cannot span multiple lines on Telegram, so we wrap
  // each non-empty line separately.
  const italicLines = trimmed
    .split("\n")
    .map((line) => (line ? `_${line}_` : line))
    .join("\n");
  return `Reasoning:\n${italicLines}`;
}

type ThinkTaggedSplitBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string };

export function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
  const trimmedStart = text.trimStart();
  // Avoid false positives: only treat it as structured thinking when it begins
  // with a think tag (common for local/OpenAI-compat providers that emulate
  // reasoning blocks via tags).
  if (!trimmedStart.startsWith("<")) {
    return null;
  }
  const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
  if (!openRe.test(trimmedStart)) {
    return null;
  }
  if (!closeRe.test(text)) {
    return null;
  }

  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let inThinking = false;
  let cursor = 0;
  let thinkingStart = 0;
  const blocks: ThinkTaggedSplitBlock[] = [];

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    blocks.push({ type: "text", text: value });
  };
  const pushThinking = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) {
      return;
    }
    blocks.push({ type: "thinking", thinking: cleaned });
  };

  for (const match of text.matchAll(scanRe)) {
    const index = match.index ?? 0;
    const isClose = match[1]?.includes("/") ?? false;

    if (!inThinking && !isClose) {
      pushText(text.slice(cursor, index));
      thinkingStart = index + match[0].length;
      inThinking = true;
      continue;
    }

    if (inThinking && isClose) {
      pushThinking(text.slice(thinkingStart, index));
      cursor = index + match[0].length;
      inThinking = false;
    }
  }

  if (inThinking) {
    return null;
  }
  pushText(text.slice(cursor));

  const hasThinking = blocks.some((b) => b.type === "thinking");
  if (!hasThinking) {
    return null;
  }
  return blocks;
}

export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) {
    return;
  }
  const hasThinkingBlock = message.content.some(
    (block) => block && typeof block === "object" && block.type === "thinking",
  );
  if (hasThinkingBlock) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      next.push(block);
      continue;
    }
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const split = splitThinkingTaggedText(block.text);
    if (!split) {
      next.push(block);
      continue;
    }
    changed = true;
    for (const part of split) {
      if (part.type === "thinking") {
        next.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "text") {
        const cleaned = part.text.trimStart();
        if (cleaned) {
          next.push({ type: "text", text: cleaned });
        }
      }
    }
  }

  if (!changed) {
    return;
  }
  message.content = next;
}

export function extractThinkingFromTaggedText(text: string): string {
  if (!text) {
    return "";
  }
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  return result.trim();
}

export function extractThinkingFromTaggedStream(text: string): string {
  if (!text) {
    return "";
  }
  const closed = extractThinkingFromTaggedText(text);
  if (closed) {
    return closed;
  }

  const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  const openMatches = [...text.matchAll(openRe)];
  if (openMatches.length === 0) {
    return "";
  }
  const closeMatches = [...text.matchAll(closeRe)];
  const lastOpen = openMatches[openMatches.length - 1];
  const lastClose = closeMatches[closeMatches.length - 1];
  if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) {
    return closed;
  }
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  return text.slice(start).trim();
}

export function inferToolMetaFromArgs(toolName: string, args: unknown): string | undefined {
  const display = resolveToolDisplay({ name: toolName, args });
  return formatToolDetail(display);
}
