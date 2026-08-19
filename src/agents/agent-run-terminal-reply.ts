import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const AGENT_RUN_TERMINAL_REPLY_MAX_CHARS = 4_096;

export type AgentRunTerminalReplySnapshot =
  | { disposition: "visible"; text: string }
  | { disposition: "silent" }
  | { disposition: "empty" };

function isMessageToolNotCalledTerminalReply(
  reply: AgentRunTerminalReplySnapshot | undefined,
): boolean {
  return (
    reply?.disposition === "empty" &&
    (reply as { code?: unknown }).code === "message-tool-not-called"
  );
}

/** Sanitizes and caps producer-owned text before it enters lifecycle or durable state. */
export function sanitizeAgentRunTerminalReplyText(text: string): string {
  const sanitized = stripInternalMetadataForDisplay(text).trim();
  if (sanitized.length <= AGENT_RUN_TERMINAL_REPLY_MAX_CHARS) {
    return sanitized;
  }
  return `${truncateUtf16Safe(sanitized, AGENT_RUN_TERMINAL_REPLY_MAX_CHARS - 1).trimEnd()}…`;
}

/** Builds the authoritative terminal reply fact while raw assistant text is still available. */
export function buildAgentRunTerminalReplySnapshot(params: {
  visibleText?: string;
  rawText?: string;
  terminalReplyKind?: "silent-empty";
}): AgentRunTerminalReplySnapshot {
  if (
    params.terminalReplyKind === "silent-empty" ||
    isSilentReplyText(params.rawText ?? params.visibleText, SILENT_REPLY_TOKEN)
  ) {
    return { disposition: "silent" };
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
    if ((value as { code?: unknown }).code === "message-tool-not-called") {
      const reply = { disposition, code: "message-tool-not-called" } as const;
      return reply;
    }
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
  if (!existing) {
    return incoming;
  }
  if (isMessageToolNotCalledTerminalReply(existing)) {
    return existing;
  }
  if (isMessageToolNotCalledTerminalReply(incoming)) {
    return incoming;
  }
  if (existing.disposition === "empty") {
    return incoming;
  }
  return incoming.disposition === "empty" ? existing : incoming;
}
