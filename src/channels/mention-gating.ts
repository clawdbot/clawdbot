export type MentionGateParams = {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  shouldBypassMention?: boolean;
};

export type MentionGateResult = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
};

export type MentionGateWithBypassParams = {
  isGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  hasAnyMention?: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

export type MentionGateWithBypassResult = MentionGateResult & {
  shouldBypassMention: boolean;
};

export function resolveMentionGating(params: MentionGateParams): MentionGateResult {
  const implicit = params.implicitMention === true;
  const bypass = params.shouldBypassMention === true;
  const effectiveWasMentioned = params.wasMentioned || implicit || bypass;
  const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
  return { effectiveWasMentioned, shouldSkip };
}

export function resolveMentionGatingWithBypass(
  params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
  const shouldBypassMention =
    params.isGroup &&
    params.requireMention &&
    !params.wasMentioned &&
    !(params.hasAnyMention ?? false) &&
    params.allowTextCommands &&
    params.commandAuthorized &&
    params.hasControlCommand;
  return {
    ...resolveMentionGating({
      requireMention: params.requireMention,
      canDetectMention: params.canDetectMention,
      wasMentioned: params.wasMentioned,
      implicitMention: params.implicitMention,
      shouldBypassMention,
    }),
    shouldBypassMention,
  };
}
