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
import type { ClawdbotConfig } from "../config/config.js";
import { formatSandboxToolPolicyBlockedMessage } from "./sandbox.js";
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
  options?: { sanitizeToolCallIds?: boolean; enforceToolCallLast?: boolean },
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
      const sanitizedToolCallId =
        options?.sanitizeToolCallIds && toolMsg.toolCallId
          ? sanitizeToolCallId(toolMsg.toolCallId)
          : undefined;
      const toolUseId = (toolMsg as { toolUseId?: unknown }).toolUseId;
      const sanitizedToolUseId =
        options?.sanitizeToolCallIds &&
        typeof toolUseId === "string" &&
        toolUseId
          ? sanitizeToolCallId(toolUseId)
          : undefined;
      const sanitizedMsg = {
        ...toolMsg,
        content: nextContent,
        ...(sanitizedToolCallId && {
          toolCallId: sanitizedToolCallId,
        }),
        ...(sanitizedToolUseId && {
          toolUseId: sanitizedToolUseId,
        }),
      };
      out.push(sanitizedMsg);
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
        const filteredContent = content.filter((block) => {
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
                if (
                  type === "functionCall" ||
                  type === "toolUse" ||
                  type === "toolCall"
                ) {
                  lastToolIndex = i;
                  break;
                }
              }
              if (lastToolIndex === -1) return filteredContent;
              return filteredContent.slice(0, lastToolIndex + 1);
            })()
          : filteredContent;
        const sanitizedContent = options?.sanitizeToolCallIds
          ? await Promise.all(
              normalizedContent.map(async (block) => {
                if (!block || typeof block !== "object") return block;

                const type = (block as { type?: unknown }).type;
                const id = (block as { id?: unknown }).id;
                if (typeof id !== "string" || !id) return block;

                // Cloud Code Assist tool blocks require ids matching ^[a-zA-Z0-9_-]+$.
                if (
                  type === "functionCall" ||
                  type === "toolUse" ||
                  type === "toolCall"
                ) {
                  return {
                    ...(block as unknown as Record<string, unknown>),
                    id: sanitizeToolCallId(id),
                  };
                }

                return block;
              }),
            )
          : normalizedContent;
        const finalContent = (await sanitizeContentBlocksImages(
          sanitizedContent as unknown as ContentBlock[],
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
  opts?: { cfg?: ClawdbotConfig; sessionKey?: string },
): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(
      /tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i,
    );
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) return rewritten;
  }

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
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}

type ErrorPattern = RegExp | string;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "usage limit",
  ],
  timeout: [
    "timeout",
    "timed out",
    "deadline exceeded",
    "context deadline exceeded",
  ],
  billing: [
    /\b402\b/,
    "payment required",
    "insufficient credits",
    "credit balance",
    "plans & billing",
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/,
    "incorrect api key",
    "invalid token",
    "authentication",
    "unauthorized",
    "forbidden",
    "access denied",
    "expired",
    "token has expired",
    /\b401\b/,
    /\b403\b/,
  ],
  format: [
    "invalid_request_error",
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
  ],
} as const;

function matchesErrorPatterns(
  raw: string,
  patterns: readonly ErrorPattern[],
): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

export function isBillingErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) return false;
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
  return (
    value.includes("billing") &&
    (value.includes("upgrade") ||
      value.includes("credits") ||
      value.includes("payment") ||
      value.includes("plan"))
  );
}

export function isBillingAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isBillingErrorMessage(msg.errorMessage ?? "");
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}

export function isCloudCodeAssistFormatError(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}

export function isAuthAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

export type FailoverReason =
  | "auth"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "unknown";

export function classifyFailoverReason(raw: string): FailoverReason | null {
  if (isRateLimitErrorMessage(raw)) return "rate_limit";
  if (isCloudCodeAssistFormatError(raw)) return "format";
  if (isBillingErrorMessage(raw)) return "billing";
  if (isTimeoutErrorMessage(raw)) return "timeout";
  if (isAuthErrorMessage(raw)) return "auth";
  return null;
}

export function isFailoverErrorMessage(raw: string): boolean {
  return classifyFailoverReason(raw) !== null;
}

export function isFailoverAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isFailoverErrorMessage(msg.errorMessage ?? "");
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
// When the agent uses a messaging tool (telegram, discord, slack, message, sessions_send)
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

export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) return false;
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
    return false;
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH)
      return false;
    return (
      normalized.includes(normalizedSent) || normalizedSent.includes(normalized)
    );
  });
}

/**
 * Check if a text is a duplicate of any previously sent messaging tool text.
 * Uses substring matching to handle LLM elaboration (e.g., wrapping in quotes,
 * adding context, or slight rephrasing that includes the original).
 */
// ── Tool Call ID Sanitization (Google Cloud Code Assist) ───────────────────────
// Google Cloud Code Assist rejects tool call IDs that contain invalid characters.
// OpenAI Codex generates IDs like "call_abc123|item_456" with pipe characters,
// but Google requires IDs matching ^[a-zA-Z0-9_-]+$ pattern.
// This function sanitizes tool call IDs by replacing invalid characters with underscores.

export function sanitizeToolCallId(id: string): string {
  if (!id || typeof id !== "string") return "default_tool_id";

  const cloudCodeAssistPatternReplacement = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const trimmedInvalidStartChars = cloudCodeAssistPatternReplacement.replace(
    /^[^a-zA-Z0-9_-]+/,
    "",
  );

  return trimmedInvalidStartChars.length > 0
    ? trimmedInvalidStartChars
    : "sanitized_tool_id";
}

export function isValidCloudCodeAssistToolId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function isMessagingToolDuplicate(
  text: string,
  sentTexts: string[],
): boolean {
  if (sentTexts.length === 0) return false;
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
    return false;
  return isMessagingToolDuplicateNormalized(
    normalized,
    sentTexts.map(normalizeTextForComparison),
  );
}
