import crypto from "node:crypto";

/** Canonicalizes an adapter target into the peer id used by inbound routing. */
export function normalizeConversationPeerId(channel: string, value: string): string {
  let normalized = value.trim();
  const channelPrefix = `${channel.trim().toLowerCase()}:`;
  if (normalized.toLowerCase().startsWith(channelPrefix)) {
    normalized = normalized.slice(channelPrefix.length).trim();
  }
  return normalized.replace(/^(user|channel|group|conversation|room|dm|thread):/i, "").trim();
}

/** Builds an opaque address from canonical transport identity, never from model-session state. */
export function buildConversationRef(params: {
  channel: string;
  accountId: string;
  kind: "channel" | "direct" | "group";
  peerId: string;
  parentConversationRef?: string;
  threadId?: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        params.channel,
        params.accountId,
        params.kind,
        params.peerId,
        params.parentConversationRef ?? "",
        params.threadId ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `conv_${hash}`;
}
