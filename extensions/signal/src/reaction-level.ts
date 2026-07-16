import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveSignalAccount } from "./accounts.js";

export type SignalReactionLevel = ReactionLevel;
export type ResolvedSignalReactionLevel = ResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications for Signal.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
 * - "minimal": Agent can react, but sparingly (default)
 * - "extensive": Agent can react liberally
 */
export function resolveSignalReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedSignalReactionLevel {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "minimal",
  });
}
