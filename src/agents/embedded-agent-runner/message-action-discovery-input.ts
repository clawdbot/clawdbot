/**
 * Builds scoped message-action discovery inputs for embedded-agent tool setup.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Normalizes channel/session/message context before message-action discovery.
 *
 * Discovery expects absent optional fields as `undefined`; preserving nulls would create
 * different cache/input shapes for the same missing runtime fact.
 */
/** Collect the current sender/channel hints used to discover message actions. */
export function buildEmbeddedMessageActionDiscoveryInput(params: {
  cfg?: OpenClawConfig;
  channel: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean | null;
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    accountId: params.accountId ?? undefined,
    sessionKey: params.sessionKey ?? undefined,
    sessionId: params.sessionId ?? undefined,
    agentId: params.agentId ?? undefined,
    requesterSenderId: params.senderId ?? undefined,
    senderIsOwner: params.senderIsOwner ?? undefined,
  };
}
