import type { ClawdbotConfig, IdentityConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_ACK_REACTION = "👀";

export function resolveAgentIdentity(
  cfg: ClawdbotConfig,
  agentId: string,
): IdentityConfig | undefined {
  return resolveAgentConfig(cfg, agentId)?.identity;
}

export function resolveAckReaction(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  const configured = cfg.messages?.ackReaction;
  if (configured !== undefined) return configured.trim();
  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || DEFAULT_ACK_REACTION;
}

export function resolveIdentityNamePrefix(
  cfg: ClawdbotConfig,
  agentId: string,
): string | undefined {
  const name = resolveAgentIdentity(cfg, agentId)?.name?.trim();
  if (!name) return undefined;
  return `[${name}]`;
}

export function resolveMessagePrefix(
  cfg: ClawdbotConfig,
  agentId: string,
  opts?: { hasAllowFrom?: boolean; fallback?: string },
): string {
  const configured = cfg.messages?.messagePrefix;
  if (configured !== undefined) return configured;

  const hasAllowFrom = opts?.hasAllowFrom === true;
  if (hasAllowFrom) return "";

  return (
    resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[clawdbot]"
  );
}

export function resolveResponsePrefix(
  cfg: ClawdbotConfig,
  agentId: string,
): string | undefined {
  const configured = cfg.messages?.responsePrefix;
  if (configured !== undefined) return configured;
  return resolveIdentityNamePrefix(cfg, agentId);
}

export function resolveEffectiveMessagesConfig(
  cfg: ClawdbotConfig,
  agentId: string,
  opts?: { hasAllowFrom?: boolean; fallbackMessagePrefix?: string },
): { messagePrefix: string; responsePrefix?: string } {
  return {
    messagePrefix: resolveMessagePrefix(cfg, agentId, {
      hasAllowFrom: opts?.hasAllowFrom,
      fallback: opts?.fallbackMessagePrefix,
    }),
    responsePrefix: resolveResponsePrefix(cfg, agentId),
  };
}
