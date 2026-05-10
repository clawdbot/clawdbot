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

export interface GroupMessageGateInput {
  ignoreOtherMentions: boolean;
  hasAnyMention: boolean;
  wasMentioned: boolean;
  implicitMention: boolean;
  allowTextCommands: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
}

function resolveMentionGating(input: {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention: boolean;
  shouldBypassMention: boolean;
}): { effectiveWasMentioned: boolean; shouldSkip: boolean } {
  const effectiveWasMentioned =
    input.wasMentioned || input.implicitMention || input.shouldBypassMention;
  const shouldSkip = input.requireMention && input.canDetectMention && !effectiveWasMentioned;
  return { effectiveWasMentioned, shouldSkip };
}

function resolveCommandBypass(input: {
  requireMention: boolean;
  wasMentioned: boolean;
  hasAnyMention: boolean;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
  isControlCommand: boolean;
}): boolean {
  return (
    input.requireMention &&
    !input.wasMentioned &&
    !input.hasAnyMention &&
    input.allowTextCommands &&
    input.commandAuthorized &&
    input.isControlCommand
  );
}

export function resolveGroupMessageGate(input: GroupMessageGateInput): GroupMessageGateResult {
  if (
    input.ignoreOtherMentions &&
    input.hasAnyMention &&
    !input.wasMentioned &&
    !input.implicitMention
  ) {
    return {
      action: "drop_other_mention",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  if (input.allowTextCommands && input.isControlCommand && !input.commandAuthorized) {
    return {
      action: "block_unauthorized_command",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
    };
  }

  const shouldBypassMention = resolveCommandBypass({
    requireMention: input.requireMention,
    wasMentioned: input.wasMentioned,
    hasAnyMention: input.hasAnyMention,
    allowTextCommands: input.allowTextCommands,
    commandAuthorized: input.commandAuthorized,
    isControlCommand: input.isControlCommand,
  });

  const mentionGate = resolveMentionGating({
    requireMention: input.requireMention,
    canDetectMention: input.canDetectMention,
    wasMentioned: input.wasMentioned,
    implicitMention: input.implicitMention,
    shouldBypassMention,
  });

  if (mentionGate.shouldSkip) {
    return {
      action: "skip_no_mention",
      effectiveWasMentioned: mentionGate.effectiveWasMentioned,
      shouldBypassMention,
    };
  }

  return {
    action: "pass",
    effectiveWasMentioned: mentionGate.effectiveWasMentioned,
    shouldBypassMention,
  };
}
