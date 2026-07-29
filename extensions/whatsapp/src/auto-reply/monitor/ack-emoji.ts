// Whatsapp plugin module implements ack emoji behavior.
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const DEFAULT_WHATSAPP_ACK_REACTION = "👀";

export function resolveWhatsAppAckEmoji(params: {
  cfg: OpenClawConfig;
  agentId: string;
  ackConfig: string | { emoji?: string } | undefined;
}): string {
  if (!params.ackConfig) {
    return "";
  }
  const configured =
    typeof params.ackConfig === "string" ? params.ackConfig : params.ackConfig.emoji;
  return (
    configured?.trim() ||
    resolveAgentIdentityEmoji(params.cfg, params.agentId) ||
    DEFAULT_WHATSAPP_ACK_REACTION
  );
}

function resolveAgentIdentityEmoji(cfg: OpenClawConfig, agentId: string): string | undefined {
  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || undefined;
}
