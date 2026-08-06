// Synology Chat plugin module implements session key behavior.
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";

const CHANNEL_ID = "synology-chat";

export function buildSynologyChatInboundSessionKey(params: {
  agentId: string;
  accountId: string;
  userId: string;
  identityLinks?: Record<string, string[]>;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: "direct", id: params.userId },
    // Synology Chat supports multiple independent accounts on one gateway.
    // Keep direct-message sessions isolated per account and user.
    dmScope: "per-account-channel-peer",
    identityLinks: params.identityLinks,
  });
}

export function buildSynologyChatOutboundSessionKey(params: {
  agentId: string;
  accountId: string;
  chatUserId: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    // Chat API IDs and outgoing-webhook IDs are separate namespaces. Keep the
    // outbound identity stable without ever claiming it is the inbound sender.
    peer: { kind: "direct", id: `chat-api-${params.chatUserId}` },
    dmScope: "per-account-channel-peer",
  });
}
