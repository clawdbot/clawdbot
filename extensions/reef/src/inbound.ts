import type { ReefIngressMessage } from "./types.js";

/** Read a text reply from a channel delivery payload. */
export function resolveReefReplyText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    return "";
  }
  // SAFETY: The own-property guard above proves this object has a readable text field.
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function resolveReefInboundDispatchContent(message: ReefIngressMessage) {
  // Reef promotes a new unthreaded exchange to its initiating envelope id.
  // A reply with no thread stays unthreaded so replyTo remains the sole correlation fact.
  const threadId = message.thread ?? (message.replyTo ? undefined : message.id);
  return {
    rawBody: message.text,
    extraContext: {
      ChannelPromptContext: [message.provenance],
      ReefProvenance: message.provenance,
      ReefEnvelopeId: message.id,
      SenderIsBot: true,
      ...(message.replyTo ? { ReplyToId: message.replyTo, ReplyToIdFull: message.replyTo } : {}),
      ...(threadId ? { MessageThreadId: threadId } : {}),
    },
  };
}
