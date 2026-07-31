// Qqbot plugin module implements message gating behavior.
import type { MentionGatePort } from "../adapter/mention-gate.port.js";

type GroupMessageGateAction =
  | "drop_other_mention"
  | "block_unauthorized_command"
  | "skip_no_mention"
  | "pass";

export interface GroupMessageGateResult {
  action: GroupMessageGateAction;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
}

interface GroupMessageGateInput {
  mentionGatePort: MentionGatePort;
  ignoreOtherMentions: boolean;
  hasAnyMention: boolean;
  wasMentioned: boolean;
  implicitMention: boolean;
  allowTextCommands: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  requireMention: boolean;
}

/**
 * Group gate Layer 1 (ignoreOtherMentions) is QQ-specific and decided here;
 * Layer 2+3 (command gating + mention gating + command bypass) delegate to the
 * mention gate port backed by the SDK's `resolveInboundMentionDecision`.
 */
export function resolveGroupMessageGate(params: GroupMessageGateInput): GroupMessageGateResult {
  if (
    params.ignoreOtherMentions &&
    params.hasAnyMention &&
    !params.wasMentioned &&
    !params.implicitMention
  ) {
    return {
      action: "drop_other_mention",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  const decision = params.mentionGatePort.resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: params.wasMentioned,
      hasAnyMention: params.hasAnyMention,
      implicitMentionKinds: params.implicitMention ? ["reply_to_bot"] : [],
    },
    policy: {
      isGroup: true,
      requireMention: params.requireMention,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.isControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });

  if (params.allowTextCommands && params.isControlCommand && !params.commandAuthorized) {
    return {
      action: "block_unauthorized_command",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  if (decision.shouldSkip) {
    return {
      action: "skip_no_mention",
      effectiveWasMentioned: decision.effectiveWasMentioned,
      shouldBypassMention: decision.shouldBypassMention,
    };
  }

  return {
    action: "pass",
    effectiveWasMentioned: decision.effectiveWasMentioned,
    shouldBypassMention: decision.shouldBypassMention,
  };
}
