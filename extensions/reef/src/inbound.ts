import type { ReefIngressMessage } from "./types.js";

export function resolveReefInboundDispatchContent(message: ReefIngressMessage) {
  return {
    rawBody: message.text,
    extraContext: {
      UntrustedContext: [message.provenance],
      ReefProvenance: message.provenance,
      ReefEnvelopeId: message.id,
      SenderIsBot: true,
      ...(message.replyTo ? { ReplyToId: message.replyTo, ReplyToIdFull: message.replyTo } : {}),
      ...(message.thread ? { MessageThreadId: message.thread } : {}),
    },
  };
}
