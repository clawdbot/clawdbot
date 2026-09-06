// Gateway chat display sanitizer.
// Removes OpenClaw-only envelopes before messages are shown in UI/RPC results.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  stripInternalMetadataForDisplay,
  stripUserEnvelopeForDisplay,
} from "../auto-reply/reply/display-text-sanitize.js";
import { extractInboundSenderLabel } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../shared/chat-envelope.js";

// Gateway chat history display strips internal/user envelopes while preserving
// sender labels for UI rows. The helpers return original object identities when
// nothing changes so callers can avoid unnecessary snapshot churn.
export { stripEnvelope };

function extractMessageSenderLabel(entry: Record<string, unknown>): string | null {
  // Sender labels can be explicit fields or embedded in text/envelope content.
  // Preserve the first label found so user-origin rows keep human context.
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return entry.senderLabel.trim();
  }
  if (typeof entry.content === "string") {
    return extractInboundSenderLabel(entry.content);
  }
  if (Array.isArray(entry.content)) {
    for (const item of entry.content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        continue;
      }
      const senderLabel = extractInboundSenderLabel(text);
      if (senderLabel) {
        return senderLabel;
      }
    }
  }
  if (typeof entry.text === "string") {
    return extractInboundSenderLabel(entry.text);
  }
  return null;
}

// Text content blocks need role-aware stripping because user messages carry
// inbound envelopes while assistant/tool content may carry internal metadata.
function stripEnvelopeFromContentWithRole(content: unknown[], role: string): unknown[] {
  const stripUserEnvelope = role === "user";
  let next: unknown[] | undefined;
  for (let index = 0; index < content.length; index++) {
    const item = content[index];
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const isRoleTextBlock =
      entry.type === "text" ||
      (role === "user" && entry.type === "input_text") ||
      (role === "assistant" && (entry.type === "input_text" || entry.type === "output_text"));
    if (!isRoleTextBlock || typeof entry.text !== "string") {
      continue;
    }
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.text)
      : stripInternalMetadataForDisplay(entry.text);
    if (stripped === entry.text) {
      continue;
    }
    next ??= content.slice();
    next[index] = {
      ...entry,
      text: stripped,
    };
  }
  return next ?? content;
}

/** Strips OpenClaw envelope metadata from one display message without mutating it. */
export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  const stripUserEnvelope = role === "user";

  let next: Record<string, unknown> | undefined;
  // Labels come from the raw message before runtime-context and envelope removal.
  const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
  if (senderLabel && entry.senderLabel !== senderLabel) {
    next = { ...entry, senderLabel };
  }

  if (typeof entry.content === "string") {
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.content)
      : stripInternalMetadataForDisplay(entry.content);
    if (stripped !== entry.content) {
      next ??= { ...entry };
      next.content = stripped;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(entry.content, role);
    if (updated !== entry.content) {
      next ??= { ...entry };
      next.content = updated;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.text)
      : stripInternalMetadataForDisplay(entry.text);
    if (stripped !== entry.text) {
      next ??= { ...entry };
      next.text = stripped;
    }
  }

  return next ?? message;
}

/** Strips envelope metadata from a message array, preserving the original array when unchanged. */
export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  let next: unknown[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      next ??= messages.slice();
      next[index] = stripped;
    }
  }
  return next ?? messages;
}
