/**
 * Sender-scoped sandbox tool policy resolver.
 * Applies per-agent toolsBySender matches before global sender policy so
 * channel delivery can narrow tool access by sender identity.
 */
import { resolveToolsBySender } from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";

type SenderToolPolicyParams = {
  config?: OpenClawConfig;
  agentId?: string;
  messageProvider?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

/** Resolves sender-scoped sandbox tool policy, preferring agent config over global config. */
export function resolveSenderToolPolicy(
  params: SenderToolPolicyParams,
): SandboxToolPolicy | undefined {
  const cfg = params.config;
  if (!cfg) {
    return undefined;
  }
  const sender = {
    messageProvider: params.messageProvider,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  };
  const agentTools =
    params.agentId && params.agentId.trim()
      ? resolveAgentConfig(cfg, params.agentId)?.tools
      : undefined;
  const agentPolicy = resolveToolsBySender({
    toolsBySender: agentTools?.toolsBySender,
    ...sender,
  });
  if (agentPolicy) {
    return pickSandboxToolPolicy(agentPolicy);
  }
  const globalPolicy = resolveToolsBySender({
    toolsBySender: cfg.tools?.toolsBySender,
    ...sender,
  });
  return pickSandboxToolPolicy(globalPolicy);
}
