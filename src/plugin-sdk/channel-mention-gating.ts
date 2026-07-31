// Plugin SDK barrel for mention-gating policy helpers used by channel plugins.
export type {
  InboundImplicitMentionKind,
  InboundMentionDecision,
  InboundMentionFacts,
  InboundMentionPolicy,
  ResolveInboundMentionDecisionFlatParams,
  ResolveInboundMentionDecisionNestedParams,
  ResolveInboundMentionDecisionParams,
} from "../channels/mention-gating.js";
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channels/mention-gating.js";
export {
  CURRENT_MESSAGE_MARKER,
  buildMentionRegexes,
  normalizeMentionText,
  type BuildMentionRegexesOptions,
} from "../auto-reply/reply/mentions.js";
export {
  resolveMentionPatternPolicy,
  type ResolveMentionPatternPolicyParams,
  type ResolvedMentionPatternPolicy,
} from "../channels/mention-pattern-policy.js";
