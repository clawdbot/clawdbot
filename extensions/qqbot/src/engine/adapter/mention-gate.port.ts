/**
 * Mention gate port — abstracts the SDK's `resolveInboundMentionDecision`
 * + `resolveControlCommandGate` into a single interface.
 *
 * The engine's `resolveGroupMessageGate` (Layer 1: ignoreOtherMentions)
 * is QQ-specific and stays in `group/message-gating.ts`. Layer 2+3
 * (command gating + mention gating + command bypass) delegate to this port.
 */

/** Implicit mention kind aligned with SDK's `InboundImplicitMentionKind`. */
export type ImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

/** Facts about the current message's mention state. */
export interface MentionFacts {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly ImplicitMentionKind[];
}

/** Policy configuration for the mention gate. */
export interface MentionPolicy {
  isGroup: boolean;
  requireMention: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}

/** Result of the mention gate evaluation. */
export interface MentionGateDecision {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
  shouldBypassMention: boolean;
  implicitMention: boolean;
}

export interface MentionGatePort {
  /**
   * Evaluate whether the message should be skipped based on mention
   * policy, command bypass, and implicit mention rules.
   *
   * Equivalent to SDK's `resolveInboundMentionDecision` with the
   * command-bypass logic folded in.
   */
  resolveInboundMentionDecision(params: {
    facts: MentionFacts;
    policy: MentionPolicy;
  }): MentionGateDecision;
}
