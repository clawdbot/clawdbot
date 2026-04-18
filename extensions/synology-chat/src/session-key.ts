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
