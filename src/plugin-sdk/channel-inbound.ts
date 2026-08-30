import type { DispatchFromConfigResult } from "../auto-reply/reply/dispatch-from-config.js";
export {
  createChannelParticipationCoordinator,
  type ChannelParticipationCandidate,
} from "../channels/participation.js";
// Channel inbound contracts define plugin ingress payloads and reply dispatch metadata.
import {
  buildChannelInboundEventContext,
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveInboundSupplementalSenderAllowed,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
  type FinalizeChannelInboundContextAsyncParams,
  type FinalizeChannelInboundContextParams,
  type FinalizeChannelInboundContextResult,
} from "../channels/inbound-event/context.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "../channels/turn/dispatch-result.js";
import { runPreparedChannelTurn } from "../channels/turn/execution.js";
import {
  dispatchAssembledChannelTurn,
  dispatchRoutedChannelTurn,
} from "../channels/turn/lifecycle.js";
import {
  recordDroppedChannelTurnHistory as recordDroppedChannelTurnHistoryInternal,
  runChannelTurn,
} from "../channels/turn/run-channel-turn.js";
import type {
  AssembledChannelTurn,
  ChannelCoreManagedTurnDeliveryAdapter,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
  ChannelTurnResult,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "../channels/turn/types.js";

export {
  readAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";

export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDm,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
  type ResolvedInboundDirectDmAccess,
} from "../channels/direct-dm.js";
export {
  formatAgentEnvelope,
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
export type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
export type {
  PluginHookChannelChatContext,
  PluginHookChannelContext,
  PluginHookChannelSenderContext,
} from "../plugins/hook-types.js";
export {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
  normalizeMentionText,
  type BuildMentionRegexesOptions,
} from "../auto-reply/reply/mentions.js";
export {
  resolveMentionPatternPolicy,
  type ResolveMentionPatternPolicyParams,
  type ResolvedMentionPatternPolicy,
} from "../channels/mention-pattern-policy.js";
export {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "../channels/inbound-debounce-policy.js";
export type {
  InboundMentionFacts,
  InboundMentionPolicy,
  InboundImplicitMentionKind,
  InboundMentionDecision,
  ResolveInboundMentionDecisionFlatParams,
  ResolveInboundMentionDecisionNestedParams,
  ResolveInboundMentionDecisionParams,
} from "../channels/mention-gating.js";
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channels/mention-gating.js";
export type { LocationSource, NormalizedLocation, OutboundLocation } from "../channels/location.js";
export {
  formatLocationText,
  normalizeOutboundLocation,
  toLocationContext,
} from "../channels/location.js";
export type { LogFn } from "../channels/logging.js";
export { logInboundDrop } from "../channels/logging.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  classifyChannelInboundEvent,
  resolveUnmentionedGroupInboundPolicy,
} from "../channels/inbound-event/classification.js";
export type { ClassifyChannelInboundEventParams } from "../channels/inbound-event/classification.js";
export {
  createChannelInboundEnvelopeBuilder,
  resolveChannelInboundRouteEnvelope,
  type ChannelInboundEnvelopeInput,
} from "../channels/inbound-event/envelope.js";
export {
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS,
  recordChannelFeedbackEvent,
  runChannelFeedbackReflection,
  type ChannelFeedbackReflectionResult,
} from "../channels/feedback-reflection.js";
export {
  buildChannelInboundEventContext,
  // @deprecated Prefer `buildChannelInboundEventContext`.
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveInboundSupplementalSenderAllowed,
};
export type {
  BuildChannelInboundEventContextAsyncParams,
  BuildChannelInboundEventContextParams,
  BuiltChannelInboundEventContext,
  ChannelInboundSupplementalResolutionOptions,
  FinalizeChannelInboundContextAsyncParams,
  FinalizeChannelInboundContextParams,
  FinalizeChannelInboundContextResult,
};
/**
 * Deprecated turn-context input alias that still accepts the old `inboundTurnKind` name.
 *
 * @deprecated Use `BuildChannelInboundEventContextParams`.
 */
export type BuildChannelTurnContextParams = Omit<
  BuildChannelInboundEventContextParams,
  "message"
> & {
  message: BuildChannelInboundEventContextParams["message"] & {
    inboundTurnKind?: InboundEventKind;
  };
};
/**
 * Deprecated turn-context result alias with the historical `InboundTurnKind` field.
 *
 * @deprecated Use `BuiltChannelInboundEventContext`.
 */
export type BuiltChannelTurnContext = BuiltChannelInboundEventContext & {
  InboundTurnKind: InboundEventKind;
};

/**
 * Builds inbound-event context for callers still passing `inboundTurnKind`.
 *
 * @deprecated Use `buildChannelInboundEventContext`.
 */
export function buildChannelTurnContext(
  params: BuildChannelTurnContextParams,
): BuiltChannelTurnContext {
  const inboundEventKind = params.message.inboundEventKind ?? params.message.inboundTurnKind;
  // Normalize the legacy turn-kind field before delegating so downstream context builders
  // only need to preserve the current inbound-event contract.
  const ctx = buildChannelInboundEventContext({
    ...params,
    message: {
      ...params.message,
      ...(inboundEventKind ? { inboundEventKind } : {}),
    },
  });
  return {
    ...ctx,
    InboundTurnKind: ctx.InboundEventKind,
  };
}

/**
 * Deprecated supplemental-context filter alias retained for channel SDK compatibility.
 *
 * @deprecated Use `filterChannelInboundSupplementalContext`.
 */
export const filterChannelTurnSupplementalContext = filterChannelInboundSupplementalContext;
// Public inbound vocabulary binds to internal channel-turn vocabulary here and only here.
// Keep internal defining modules free of SDK compatibility names.
export type ChannelInboundEventRunnerParams<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
> = RunChannelTurnParams<TRaw, TDispatchResult>;
export type PreparedInboundReply<TDispatchResult> = PreparedChannelTurn<TDispatchResult>;
export type AssembledInboundReply = AssembledChannelTurn;
export type ChannelInboundTurnPlan<
  TOwnership extends "core" | "provider_message_sending" = "core",
> = ChannelTurnPlan<
  TOwnership extends "provider_message_sending"
    ? ChannelProviderOwnedMessageSendingDeliveryAdapter
    : ChannelCoreManagedTurnDeliveryAdapter
>;
export type InboundReplyDispatchResult<TDispatchResult> = ChannelTurnResult<TDispatchResult>;
export type {
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnDroppedHistoryOptions as ChannelInboundDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  ChannelTurnRecordOptions as InboundReplyRecordOptions,
} from "../channels/turn/types.js";
export type { DurableInboundReplyDeliveryParams } from "../channels/turn/durable-delivery.js";
export type { ChannelBotLoopProtectionFacts } from "../channels/turn/bot-loop-protection.js";
export { recordChannelBotPairLoopAndCheckSuppression } from "../channels/turn/bot-loop-protection.js";

export async function runPreparedInboundReply<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurn(params);
}

export function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: RunChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
) {
  const run = runChannelTurn as (
    value: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
  ) => Promise<ChannelTurnResult<TDispatchResult>>;
  return await run(params);
}

export async function dispatchChannelInboundReply(params: AssembledInboundReply) {
  return await dispatchAssembledChannelTurn(params);
}

export function dispatchChannelInboundTurn(
  params: ChannelInboundTurnPlan<"provider_message_sending">,
): Promise<ChannelTurnResult>;
export function dispatchChannelInboundTurn(
  params: ChannelInboundTurnPlan,
): Promise<ChannelTurnResult>;
export async function dispatchChannelInboundTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
) {
  const dispatch = dispatchRoutedChannelTurn as (
    value: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
  ) => Promise<ChannelTurnResult>;
  return await dispatch(params);
}

export {
  hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch,
  hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch,
  recordDroppedChannelTurnHistoryInternal as recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistoryInternal as recordDroppedChannelTurnHistory,
  resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts,
};
export {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
  type ChannelPartialDeliveryError,
} from "../channels/turn/delivery-result.js";

export {
  toHistoryMediaEntries,
  toInboundMediaFacts,
  toInboundMediaFactsWithMetadata,
  /** @deprecated Pass ordered facts as the context's `media` field. */
  buildChannelInboundMediaPayload,
  formatMediaPlaceholderText,
  formatInboundMediaUnavailableText,
  /** @deprecated Pass ordered facts as the context's `media` field. */
  buildChannelInboundMediaPayload as buildChannelTurnMediaPayload,
} from "../channels/inbound-event/media.js";
export type {
  ChannelInboundMediaInput,
  ChannelInboundMediaInput as ChannelTurnMediaInput,
  /** @deprecated Pass ordered `InboundMediaFacts[]` as the context's `media` field. */
  ChannelInboundMediaPayload,
  /** @deprecated Pass ordered `InboundMediaFacts[]` as the context's `media` field. */
  ChannelInboundMediaPayload as ChannelTurnMediaPayload,
  MediaPlaceholderTextFact,
} from "../channels/inbound-event/media.js";
export type {
  CommandFacts,
  InboundMediaFacts,
  SupplementalContextFacts,
} from "../channels/turn/types.js";
export type { InboundEventKind } from "../channels/inbound-event/kind.js";
export type { InboundEventKind as InboundTurnKind } from "../channels/inbound-event/kind.js";
export {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  isTextSlashCommandTurn,
} from "../auto-reply/command-turn-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { mergeInboundPathRoots } from "@openclaw/media-core/inbound-path-policy";
