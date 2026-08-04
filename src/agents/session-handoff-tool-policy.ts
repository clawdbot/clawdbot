import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentRuntimeSessionHandoffRequester } from "../gateway/agent-runtime-identity-token.js";
import { parseCanonicalSessionPeerShape } from "../sessions/session-chat-type-shared.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { resolveGroupToolPolicy } from "./agent-tools.policy.js";
import { resolveSenderToolPolicy } from "./sender-tool-policy.js";

/** Resolve target-owned sender restrictions from signed handoff requester facts. */
export function resolveSessionHandoffTargetToolPolicies(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  messageProvider?: string | null;
  accountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  requester?: AgentRuntimeSessionHandoffRequester;
}) {
  const scopedSessionKey =
    parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey?.trim();
  // Derived runs enter through the internal channel, so the canonical target
  // session owns the provider used for room sender-policy evaluation.
  const targetProvider = normalizeMessageChannel(
    (scopedSessionKey ? parseCanonicalSessionPeerShape(scopedSessionKey)?.channel : undefined) ??
      params.messageProvider,
  );
  const requesterProvider = normalizeMessageChannel(params.requester?.messageProvider);
  const requesterMatchesTargetProvider =
    requesterProvider !== undefined && requesterProvider === targetProvider;

  return {
    groupPolicy: resolveGroupToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      spawnedBy: params.spawnedBy,
      messageProvider: targetProvider,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      senderId: requesterMatchesTargetProvider ? params.requester?.senderId : undefined,
      senderName: requesterMatchesTargetProvider ? params.requester?.senderName : undefined,
      senderUsername: requesterMatchesTargetProvider ? params.requester?.senderUsername : undefined,
      senderE164: requesterMatchesTargetProvider ? params.requester?.senderE164 : undefined,
      senderPolicyMode: "always",
    }),
    senderPolicy: resolveSenderToolPolicy({
      config: params.config,
      agentId: params.agentId,
      messageProvider: params.requester?.messageProvider,
      senderId: params.requester?.senderId,
      senderName: params.requester?.senderName,
      senderUsername: params.requester?.senderUsername,
      senderE164: params.requester?.senderE164,
    }),
  };
}
