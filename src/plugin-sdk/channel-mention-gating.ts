export type {
  InboundImplicitMentionKind,
  InboundMentionDecision,
  InboundMentionFacts,
  InboundMentionPolicy,
  MentionGateParams,
  MentionGateResult,
  MentionGateWithBypassParams,
  MentionGateWithBypassResult,
  ResolveInboundMentionDecisionFlatParams,
  ResolveInboundMentionDecisionNestedParams,
  ResolveInboundMentionDecisionParams,
} from "../channels/mention-gating.js";
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  // @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`.
  resolveMentionGating,
  // @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`.
  resolveMentionGatingWithBypass,
} from "../channels/mention-gating.js";
export {
  CURRENT_MESSAGE_MARKER,
  buildMentionRegexes,
  normalizeMentionText,
} from "../auto-reply/reply/mentions.js";
