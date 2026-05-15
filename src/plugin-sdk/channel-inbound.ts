// Shared inbound parsing helpers for channel plugins.
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  dispatchInboundDirectDmWithRuntime,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm.js";
export {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
export type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
export {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
  normalizeMentionText,
} from "../auto-reply/reply/mentions.js";
export {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "../channels/inbound-debounce-policy.js";
export type {
  InboundMentionFacts,
  InboundMentionPolicy,
  InboundImplicitMentionKind,
  InboundMentionDecision,
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
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop } from "../channels/logging.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  buildChannelTurnContext,
  filterChannelTurnSupplementalContext,
} from "../channels/turn/context.js";
export type {
  BuildChannelTurnContextParams,
  BuiltChannelTurnContext,
} from "../channels/turn/context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
