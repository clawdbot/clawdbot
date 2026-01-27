import type { MoltbotConfig } from "../config/config.js";
import { resolveTelegramAccount } from "./accounts.js";

export type TelegramReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type ResolvedReactionLevel = {
  level: TelegramReactionLevel;
  /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
  ackEnabled: boolean;
  /** Whether agent-controlled reactions are enabled. */
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
};

/**
 * Resolve the effective reaction level and its implications.
 */
export function resolveTelegramReactionLevel(params: {
  cfg: MoltbotConfig;
  accountId?: string;
}): ResolvedReactionLevel {
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const level = (account.config.reactionLevel ?? "minimal") as TelegramReactionLevel;

  switch (level) {
    case "off":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: false,
      };
    case "ack":
      return {
        level,
        ackEnabled: true,
        agentReactionsEnabled: false,
      };
    case "minimal":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
    case "extensive":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "extensive",
      };
    default:
      // Fallback to ack behavior
      return {
        level: "ack",
        ackEnabled: true,
        agentReactionsEnabled: false,
      };
  }
}
