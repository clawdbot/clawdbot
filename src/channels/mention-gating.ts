import type { ChannelImplicitMentionsConfig } from "../config/types.channels.js";

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export type MentionGateParams = {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  shouldBypassMention?: boolean;
};

/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateResult = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
};

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
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

/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateWithBypassResult = MentionGateResult & {
  shouldBypassMention: boolean;
};

export type InboundImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

export type InboundMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};

export type InboundMentionPolicy = {
  isGroup: boolean;
  requireMention: boolean;
  implicitMentions?: ChannelImplicitMentionsConfig;
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;

export type ResolveInboundMentionDecisionNestedParams = {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
};

export type ResolveInboundMentionDecisionParams =
  | ResolveInboundMentionDecisionFlatParams
  | ResolveInboundMentionDecisionNestedParams;

export type InboundMentionDecision = MentionGateResult & {
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
};

export function implicitMentionKindWhen(
  kind: InboundImplicitMentionKind,
  enabled: boolean,
): InboundImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

/** Translates positive implicit-mention policy into the evaluator's kind allowlist. */
export function allowedImplicitMentionKindsFromConfig(
  config: ChannelImplicitMentionsConfig,
): InboundImplicitMentionKind[] {
  return [
    ...implicitMentionKindWhen("reply_to_bot", config.replyToBot !== false),
    ...implicitMentionKindWhen("quoted_bot", config.quotedBot !== false),
    ...implicitMentionKindWhen("bot_thread_participant", config.threadParticipation !== false),
    "native",
  ];
}

function resolveMatchedImplicitMentionKinds(params: {
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
}): InboundImplicitMentionKind[] {
  const inputKinds = params.implicitMentionKinds ?? [];
  if (inputKinds.length === 0) {
    return [];
  }
  const allowedKinds = params.allowedImplicitMentionKinds
    ? new Set(params.allowedImplicitMentionKinds)
    : null;
  const matched: InboundImplicitMentionKind[] = [];
  for (const kind of inputKinds) {
    if (allowedKinds && !allowedKinds.has(kind)) {
      continue;
    }
    if (!matched.includes(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

function resolveMentionDecisionCore(params: {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
}): InboundMentionDecision {
  const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds({
    implicitMentionKinds: params.implicitMentionKinds,
    allowedImplicitMentionKinds: params.allowedImplicitMentionKinds,
  });
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned =
    params.wasMentioned || implicitMention || params.shouldBypassMention;
  const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
  return {
    implicitMention,
    matchedImplicitMentionKinds,
    effectiveWasMentioned,
    shouldBypassMention: params.shouldBypassMention,
    shouldSkip,
  };
}

function hasNestedMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): params is ResolveInboundMentionDecisionNestedParams {
  return "facts" in params && "policy" in params;
}

function normalizeMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): ResolveInboundMentionDecisionNestedParams {
  if (hasNestedMentionDecisionParams(params)) {
    return params;
  }
  const {
    canDetectMention,
    wasMentioned,
    hasAnyMention,
    implicitMentionKinds,
    isGroup,
    requireMention,
    implicitMentions,
    allowedImplicitMentionKinds,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  } = params;
  return {
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup,
      requireMention,
      implicitMentions,
      allowedImplicitMentionKinds,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    },
  };
}

export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } = normalizeMentionDecisionParams(params);
  const allowedImplicitMentionKinds =
    policy.allowedImplicitMentionKinds ??
    (policy.implicitMentions
      ? allowedImplicitMentionKindsFromConfig(policy.implicitMentions)
      : undefined);
  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;
  return resolveMentionDecisionCore({
    requireMention: policy.requireMention,
    canDetectMention: facts.canDetectMention,
    wasMentioned: facts.wasMentioned,
    implicitMentionKinds: facts.implicitMentionKinds,
    allowedImplicitMentionKinds,
    shouldBypassMention,
  });
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGating(params: MentionGateParams): MentionGateResult {
  const result = resolveMentionDecisionCore({
    requireMention: params.requireMention,
    canDetectMention: params.canDetectMention,
    wasMentioned: params.wasMentioned,
    implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
    shouldBypassMention: params.shouldBypassMention === true,
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldSkip: result.shouldSkip,
  };
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGatingWithBypass(
  params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
  const result = resolveInboundMentionDecision({
    facts: {
      canDetectMention: params.canDetectMention,
      wasMentioned: params.wasMentioned,
      hasAnyMention: params.hasAnyMention,
      implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
    },
    policy: {
      isGroup: params.isGroup,
      requireMention: params.requireMention,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldSkip: result.shouldSkip,
    shouldBypassMention: result.shouldBypassMention,
  };
}
