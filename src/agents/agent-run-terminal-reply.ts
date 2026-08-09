import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const AGENT_RUN_TERMINAL_REPLY_MAX_CHARS = 4_096;

export type AgentRunTerminalReplySnapshot =
  | { disposition: "visible"; text: string }
  // Only the exact trimmed control token is an intentional silent disposition.
  | { disposition: "silent" }
  | { disposition: "empty" };

/** Sanitizes and caps producer-owned text before it enters lifecycle or durable state. */
export function sanitizeAgentRunTerminalReplyText(text: string): string {
  const sanitized = stripInternalMetadataForDisplay(text).trim();
  if (sanitized.length <= AGENT_RUN_TERMINAL_REPLY_MAX_CHARS) {
    return sanitized;
  }
  return `${truncateUtf16Safe(sanitized, AGENT_RUN_TERMINAL_REPLY_MAX_CHARS - 1).trimEnd()}…`;
}

/** Builds the authoritative terminal reply fact while exact raw assistant text is available. */
export function buildAgentRunTerminalReplySnapshot(params: {
  visibleText?: string;
  rawText?: string;
  terminalReplyKind?: "silent-empty";
}): AgentRunTerminalReplySnapshot {
  if (params.rawText?.trim() === SILENT_REPLY_TOKEN) {
    return { disposition: "silent" };
  }
  if (
    params.terminalReplyKind === "silent-empty" ||
    isSilentReplyText(params.rawText, SILENT_REPLY_TOKEN)
  ) {
    return { disposition: "empty" };
  }
  const text = sanitizeAgentRunTerminalReplyText(params.visibleText ?? "");
  return text ? { disposition: "visible", text } : { disposition: "empty" };
}

/** Normalizes lifecycle/RPC evidence without allowing raw or unbounded text through. */
export function normalizeAgentRunTerminalReplySnapshot(
  value: unknown,
): AgentRunTerminalReplySnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const disposition = (value as { disposition?: unknown }).disposition;
  if (disposition === "silent") {
    return { disposition };
  }
  if (disposition === "empty") {
    return { disposition };
  }
  if (disposition !== "visible") {
    return undefined;
  }
  const rawText = (value as { text?: unknown }).text;
  if (typeof rawText !== "string") {
    return undefined;
  }
  const text = sanitizeAgentRunTerminalReplyText(rawText);
  return text ? { disposition: "visible", text } : { disposition: "empty" };
}

/** Reply evidence merges independently from sticky timeout/cancellation precedence. */
export function mergeAgentRunTerminalReplySnapshot(
  existing: AgentRunTerminalReplySnapshot | undefined,
  incoming: AgentRunTerminalReplySnapshot | undefined,
): AgentRunTerminalReplySnapshot | undefined {
  if (!incoming) {
    return existing;
  }
  if (!existing || existing.disposition === "empty") {
    return incoming;
  }
  if (incoming.disposition === "empty") {
    return existing;
  }
  return incoming;
}
