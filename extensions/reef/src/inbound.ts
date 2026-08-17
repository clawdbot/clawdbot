import type { ReefIngressMessage } from "./types.js";

export function resolveReefInboundDispatchContent(message: ReefIngressMessage) {
  return {
    rawBody: message.text,
    extraContext: {
      ChannelPromptContext: [message.provenance],
      ReefProvenance: message.provenance,
      ReefEnvelopeId: message.id,
      SenderIsBot: true,
      ...(message.replyTo ? { ReplyToId: message.replyTo, ReplyToIdFull: message.replyTo } : {}),
      // Reef promotes an unthreaded exchange to the initiating envelope id.
      // Tool replies must use the same anchor as the normal reply pipeline.
      MessageThreadId: message.thread ?? message.id,
    },
  };
}
