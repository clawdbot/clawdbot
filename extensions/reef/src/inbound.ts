import type { ReefIngressMessage } from "./types.js";

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
