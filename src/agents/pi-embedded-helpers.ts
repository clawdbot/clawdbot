import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentMessage,
  AgentToolResult,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  normalizeThinkLevel,
  type ThinkLevel,
} from "../auto-reply/thinking.js";

import { sanitizeContentBlocksImages } from "./tool-images.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export type EmbeddedContextFile = { path: string; content: string };

const MAX_BOOTSTRAP_CHARS = 4000;
const BOOTSTRAP_HEAD_CHARS = 2800;
const BOOTSTRAP_TAIL_CHARS = 800;

function trimBootstrapContent(content: string, fileName: string): string {
  const trimmed = content.trimEnd();
  if (trimmed.length <= MAX_BOOTSTRAP_CHARS) return trimmed;

  const head = trimmed.slice(0, BOOTSTRAP_HEAD_CHARS);
  const tail = trimmed.slice(-BOOTSTRAP_TAIL_CHARS);
  return [
    head,
    "",
    `[...truncated, read ${fileName} for full content...]`,
    "",
    tail,
  ].join("\n");
}

export async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sessionVersion = 2;
  const entry = {
    type: "session",
    version: sessionVersion,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

type ContentBlock = AgentToolResult<unknown>["content"][number];

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
): Promise<AgentMessage[]> {
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const out: AgentMessage[] = [];
  for (const msg of messages) {
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

    out.push(msg);
  }
  return out;
}

const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

export function sanitizeGoogleTurnOrdering(
  messages: AgentMessage[],
): AgentMessage[] {
  const first = messages[0] as
    | { role?: unknown; content?: unknown }
    | undefined;
  const role = first?.role;
  const content = first?.content;
  if (
    role === "user" &&
    typeof content === "string" &&
    content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (role !== "assistant") return messages;

  // Cloud Code Assist rejects histories that begin with a model turn (tool call or text).
  // Prepend a tiny synthetic user turn so the rest of the transcript can be used.
  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;

  return [bootstrap, ...messages];
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
): EmbeddedContextFile[] {
  const result: EmbeddedContextFile[] = [];
  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }
    const trimmed = trimBootstrapContent(file.content ?? "", file.name);
    if (!trimmed) continue;
    result.push({
      path: file.name,
      content: trimmed,
    });
  }
  return result;
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    (lower.includes("413") && lower.includes("too large"))
  );
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  // Check for context overflow (413) errors
  if (isContextOverflowError(raw)) {
    return (
      "Context overflow: the conversation history is too large. " +
      "Use /new or /reset to start a fresh session."
    );
  }

  const invalidRequest = raw.match(
    /"type":"invalid_request_error".*?"message":"([^"]+)"/,
  );
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  // Keep it short for WhatsApp.
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function isRateLimitAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  const raw = (msg.errorMessage ?? "").toLowerCase();
  if (!raw) return false;
  return isRateLimitErrorMessage(raw);
}

export function isRateLimitErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  return (
    /rate[_ ]limit|too many requests|429/.test(value) ||
    value.includes("exceeded your current quota")
  );
}

export function isAuthErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) return false;
  return (
    /invalid[_ ]?api[_ ]?key/.test(value) ||
    value.includes("incorrect api key") ||
    value.includes("invalid token") ||
    value.includes("authentication") ||
    value.includes("unauthorized") ||
    value.includes("forbidden") ||
    value.includes("access denied") ||
    /\b401\b/.test(value) ||
    /\b403\b/.test(value)
  );
}

export function isAuthAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

function extractSupportedValues(raw: string): string[] {
  const match =
    raw.match(/supported values are:\s*([^\n.]+)/i) ??
    raw.match(/supported values:\s*([^\n.]+)/i);
  if (!match?.[1]) return [];
  const fragment = match[1];
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map(
    (entry) => entry[1]?.trim(),
  );
  if (quoted.length > 0) {
    return quoted.filter((entry): entry is string => Boolean(entry));
  }
  return fragment
    .split(/,|\band\b/gi)
    .map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim())
    .filter(Boolean);
}

export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim();
  if (!raw) return undefined;
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) return undefined;
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized) continue;
    if (params.attempted.has(normalized)) continue;
    return normalized;
  }
  return undefined;
}

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * This function:
 * 1. Detects consecutive messages from the same role
 * 2. Merges consecutive assistant messages together
 * 3. Preserves metadata (usage, stopReason, etc.)
 *
 * This prevents the "function call turn comes immediately after a user turn or after a function response turn" error.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    // Check if this message has the same role as the last one
    if (msgRole === lastRole && lastRole === "assistant") {
      // Merge consecutive assistant messages
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: "assistant" }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastAsst = lastMsg as Extract<
          AgentMessage,
          { role: "assistant" }
        >;

        // Merge content blocks
        const mergedContent = [
          ...(Array.isArray(lastAsst.content) ? lastAsst.content : []),
          ...(Array.isArray(currentMsg.content) ? currentMsg.content : []),
        ];

        // Preserve metadata from the later message (more recent)
        const merged: Extract<AgentMessage, { role: "assistant" }> = {
          ...lastAsst,
          content: mergedContent,
          // Take timestamps, usage, stopReason from the newer message if present
          ...(currentMsg.usage && { usage: currentMsg.usage }),
          ...(currentMsg.stopReason && { stopReason: currentMsg.stopReason }),
          ...(currentMsg.errorMessage && {
            errorMessage: currentMsg.errorMessage,
          }),
        };

        // Replace the last message with merged version
        result[result.length - 1] = merged;
        continue;
      }
    }

    // Not a consecutive duplicate, add normally
    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

// ── Messaging tool duplicate detection ──────────────────────────────────────
// When the agent uses a messaging tool (telegram, discord, slack, sessions_send)
// to send a message, we track the text so we can suppress duplicate block replies.
// The LLM sometimes elaborates or wraps the same content, so we use substring matching.

const MIN_DUPLICATE_TEXT_LENGTH = 10;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a text is a duplicate of any previously sent messaging tool text.
 * Uses substring matching to handle LLM elaboration (e.g., wrapping in quotes,
 * adding context, or slight rephrasing that includes the original).
 */
export function isMessagingToolDuplicate(
  text: string,
  sentTexts: string[],
): boolean {
  if (sentTexts.length === 0) return false;
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
    return false;
  return sentTexts.some((sent) => {
    const normalizedSent = normalizeTextForComparison(sent);
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH)
      return false;
    // Substring match: either text contains the other
    return (
      normalized.includes(normalizedSent) || normalizedSent.includes(normalized)
    );
  });
}
