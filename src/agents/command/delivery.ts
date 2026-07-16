/**
 * Normalizes and delivers agent command results to outbound channels.
 */
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import { formatBtwTextForExternalDelivery } from "../../auto-reply/reply/reply-payloads-base.js";
import {
  filterMessagingToolMediaDuplicates,
  hasEnabledDeliveryOperation,
  resolveMessagingToolPayloadDedupe,
} from "../../auto-reply/reply/reply-payloads-dedupe.runtime.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import {
  sendDurableMessageBatch,
  serializeDurableMessagePayloadOutcomes,
  type SerializedDurableMessagePayloadOutcome,
} from "../../channels/message/runtime.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  createOutboundPayloadPlan,
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForJson,
  projectOutboundPayloadPlanForOutbound,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { MessagingToolSend } from "../embedded-agent-messaging.types.js";
import type { EmbeddedAgentRunMeta } from "../embedded-agent-runner/types.js";
import { isNestedAgentLane } from "../lanes.js";
import { isAgentRunRestartAbortReason } from "../run-termination.js";
import type { AgentCommandOpts, AgentCommandResultMetaOverrides } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../embedded-agent.js"))["runEmbeddedAgent"]>>;
type DurableSendResult = Awaited<ReturnType<typeof sendDurableMessageBatch>>;

function createRestartOnlyAbortSignal(source: AbortSignal | undefined): {
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (!source) {
    return { dispose: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => {
    if (isAgentRunRestartAbortReason(source.reason)) {
      controller.abort(source.reason);
    }
  };
  if (source.aborted) {
    onAbort();
  } else {
    source.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", onAbort),
  };
}

/** Aggregate delivery status for an agent command result. */
type AgentCommandDeliveryStatus = {
  requested: true;
  attempted: boolean;
  status: "sent" | "suppressed" | "partial_failed" | "failed";
  /** `partial` means at least one payload was sent before a later payload failed. */
  succeeded: true | false | "partial";
  error?: true;
  errorMessage?: string;
  /** Free-form lowercase_snake reason from durable delivery or preflight validation. */
  reason?: string;
  resultCount?: number;
  sentBeforeError?: true;
  payloadOutcomes?: SerializedDurableMessagePayloadOutcome[];
};

/** Agent command result after payload normalization and optional delivery. */
type AgentCommandDeliveryResult = {
  payloads: ReturnType<typeof projectOutboundPayloadPlanForJson>;
  meta: EmbeddedAgentRunMeta & AgentCommandResultMetaOverrides;
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  deliverySucceeded?: boolean;
  deliveryStatus?: AgentCommandDeliveryStatus;
};

const NESTED_LOG_PREFIX = "[agent:nested]";

type FreshSessionEntryForDeliveryResolver = () => Promise<SessionEntry | undefined>;

type FreshSessionDeliveryRefreshParams =
  | {
      expectedSessionIdForFreshDelivery: string;
      resolveFreshSessionEntryForDelivery: FreshSessionEntryForDeliveryResolver;
    }
  | {
      expectedSessionIdForFreshDelivery?: string;
      resolveFreshSessionEntryForDelivery?: undefined;
    };

type DeliverAgentCommandResultParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
  assertDeliveryCurrent?: () => void;
  onDeliveryResult?: (result: AgentCommandDeliveryResult) => void;
} & FreshSessionDeliveryRefreshParams;

function normalizeDeliverySessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isFreshDeliverySessionMatch(
  freshSessionEntry: SessionEntry,
  expectedSessionId: string | undefined,
): boolean {
  const normalizedExpected = normalizeDeliverySessionId(expectedSessionId);
  return Boolean(normalizedExpected && freshSessionEntry.sessionId === normalizedExpected);
}

function formatNestedLogPrefix(opts: AgentCommandOpts, sessionKey?: string): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
  if (session) {
    parts.push(`session=${session}`);
  }
  if (opts.runId) {
    parts.push(`run=${opts.runId}`);
  }
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) {
    parts.push(`channel=${channel}`);
  }
  if (opts.to) {
    parts.push(`to=${opts.to}`);
  }
  if (opts.accountId) {
    parts.push(`account=${opts.accountId}`);
  }
  return parts.join(" ");
}

function logNestedOutput(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  output: string,
  sessionKey?: string,
) {
  const prefix = formatNestedLogPrefix(opts, sessionKey);
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    runtime.log(`${prefix} ${line}`);
  }
}

function mergeResultMetaOverrides(
  meta: EmbeddedAgentRunMeta,
  overrides: AgentCommandResultMetaOverrides | undefined,
): EmbeddedAgentRunMeta & AgentCommandResultMetaOverrides {
  if (!overrides) {
    return meta;
  }
  return {
    ...meta,
    ...overrides,
  };
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

function hasNonEmptyArray<T>(value: T[] | undefined): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

function buildDeliveryResult(params: {
  payloads: AgentCommandDeliveryResult["payloads"];
  meta: AgentCommandDeliveryResult["meta"];
  result: RunResult;
  deliverySucceeded?: boolean;
  deliveryStatus?: AgentCommandDeliveryStatus;
}): AgentCommandDeliveryResult {
  return {
    payloads: params.payloads,
    meta: params.meta,
    ...(params.result.didSendViaMessagingTool === true ? { didSendViaMessagingTool: true } : {}),
    ...(hasNonEmptyStringArray(params.result.messagingToolSentTexts)
      ? { messagingToolSentTexts: params.result.messagingToolSentTexts }
      : {}),
    ...(hasNonEmptyStringArray(params.result.messagingToolSentMediaUrls)
      ? { messagingToolSentMediaUrls: params.result.messagingToolSentMediaUrls }
      : {}),
    ...(hasNonEmptyArray(params.result.messagingToolSentTargets)
      ? { messagingToolSentTargets: params.result.messagingToolSentTargets }
      : {}),
    ...(params.deliverySucceeded !== undefined
      ? { deliverySucceeded: params.deliverySucceeded }
      : {}),
    ...(params.deliveryStatus ? { deliveryStatus: params.deliveryStatus } : {}),
  };
}

function deliveryStatusFromDurableSend(send: DurableSendResult): AgentCommandDeliveryStatus {
  const payloadOutcomes = serializeDurableMessagePayloadOutcomes(send.payloadOutcomes, {
    includeHookEffect: true,
  });
  switch (send.status) {
    case "sent":
      return {
        requested: true,
        attempted: true,
        status: "sent",
        succeeded: true,
        resultCount: send.results.length,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "suppressed":
      return {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        reason: send.reason,
        resultCount: 0,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "partial_failed":
      return {
        requested: true,
        attempted: true,
        status: "partial_failed",
        succeeded: "partial",
        error: true,
        errorMessage: formatErrorMessage(send.error),
        resultCount: send.results.length,
        sentBeforeError: true,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "failed":
      return {
        requested: true,
        attempted: true,
        status: "failed",
        succeeded: false,
        error: true,
        errorMessage: formatErrorMessage(send.error),
        ...(send.stage ? { reason: send.stage } : {}),
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
  }
  const exhaustive: never = send;
  return exhaustive;
}

function preDeliveryFailureStatus(reason: string): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "failed",
    succeeded: false,
    error: true,
    reason,
  };
}

function noVisiblePayloadStatus(): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "suppressed",
    succeeded: true,
    reason: "no_visible_payload",
    resultCount: 0,
  };
}

async function normalizeReplyMediaPathsForDelivery(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  sessionKey?: string;
  outboundSession: OutboundSessionContext | undefined;
  deliveryChannel: string;
  accountId?: string;
}): Promise<{
  payloads: ReplyPayload[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}> {
  if (params.payloads.length === 0) {
    return { payloads: params.payloads };
  }
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = agentId ? resolveAgentWorkspaceDir(params.cfg, agentId) : undefined;
  if (!workspaceDir) {
    return { payloads: params.payloads };
  }
  const normalizeMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId,
    workspaceDir,
    messageProvider: params.deliveryChannel,
    accountId: params.accountId,
  });
  const result: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    result.push(await normalizeMediaPaths(payload));
  }
  return { payloads: result, normalizeMediaPaths };
}

async function normalizeSentMediaUrlsForDelivery(params: {
  sentMediaUrls: readonly string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  const normalizedUrls: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalizedUrls.push(trimmed);
    }
    if (!params.normalizeMediaPaths) {
      continue;
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      for (const mediaUrl of [normalized.mediaUrl, ...(normalized.mediaUrls ?? [])]) {
        const candidate = mediaUrl?.trim();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        normalizedUrls.push(candidate);
      }
    } catch {
      // Keep the original evidence. Delivery normalization will report invalid media separately.
    }
  }
  return normalizedUrls;
}

const UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

async function filterAlreadyDeliveredReplyPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  result: RunResult;
  deliveryChannel: string;
  deliveryTarget: string;
  accountId?: string;
  sourceAccountId?: string;
  defaultAccountId?: string;
  threadId?: string | number;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  normalizeSentTexts?: (sentTexts: readonly string[]) => string[];
}): Promise<ReplyPayload[]> {
  const sentTexts = params.result.messagingToolSentTexts ?? [];
  const sentMediaUrls = params.result.messagingToolSentMediaUrls ?? [];
  // The message tool injects the run account after telemetry captures its
  // original args. Preserve that source route before falling back to default.
  const implicitToolAccountId = params.sourceAccountId ?? params.defaultAccountId;
  const sentTargets = (params.result.messagingToolSentTargets ?? []).flatMap((target) => {
    if (target.accountId || !params.accountId) {
      return [target];
    }
    return implicitToolAccountId ? [{ ...target, accountId: implicitToolAccountId }] : [];
  });
  if (sentTexts.length === 0 && sentMediaUrls.length === 0 && sentTargets.length === 0) {
    return params.payloads;
  }

  const decision = resolveMessagingToolPayloadDedupe({
    config: params.cfg,
    messageProvider: params.deliveryChannel,
    messagingToolSentTargets: sentTargets,
    originatingTo: params.deliveryTarget,
    originatingThreadId: params.threadId,
    accountId: params.accountId,
  });
  if (!decision.matchingRoute) {
    return params.payloads;
  }
  const routeSentMediaUrls = decision.useGlobalSentMediaUrlEvidenceFallback
    ? sentMediaUrls
    : decision.routeSentMediaUrls;
  const rawRouteSentTexts = decision.useGlobalSentTextEvidenceFallback
    ? sentTexts
    : decision.routeSentTexts;
  const routeSentTexts = params.normalizeSentTexts?.(rawRouteSentTexts) ?? rawRouteSentTexts;
  const exactRouteSentTexts = new Set(routeSentTexts.filter((text) => Boolean(text.trim())));
  const normalizedSentMediaUrls = await normalizeSentMediaUrlsForDelivery({
    sentMediaUrls: routeSentMediaUrls,
    normalizeMediaPaths: params.normalizeMediaPaths,
  });
  const mediaFiltered = filterMessagingToolMediaDuplicates({
    payloads: params.payloads,
    sentMediaUrls: normalizedSentMediaUrls,
  });

  const filteredPayloads: ReplyPayload[] = [];
  for (const candidate of mediaFiltered) {
    if (hasEnabledDeliveryOperation(candidate)) {
      filteredPayloads.push(candidate);
      continue;
    }
    const effectiveCandidateText =
      formatBtwTextForExternalDelivery(candidate) ?? candidate.text ?? "";
    if (!effectiveCandidateText.trim() || !exactRouteSentTexts.has(effectiveCandidateText)) {
      filteredPayloads.push(candidate);
      continue;
    }
    const withoutDuplicateText = copyReplyPayloadMetadata(candidate, {
      ...candidate,
      text: undefined,
    });
    if (
      hasReplyPayloadContent(withoutDuplicateText, {
        trimText: true,
        extraContent: withoutDuplicateText.location != null,
      })
    ) {
      filteredPayloads.push(withoutDuplicateText);
    }
  }
  return filteredPayloads;
}

/** Normalizes reply payloads and media paths before delivery. */
function normalizeAgentCommandReplyPayloads(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  payloads: RunResult["payloads"];
  result: RunResult;
  deliveryChannel?: string;
  accountId?: string;
  applyChannelTransforms?: boolean;
  includeRunModelContext?: boolean;
}): ReplyPayload[] {
  const payloads = params.payloads ?? [];
  if (payloads.length === 0) {
    return [];
  }
  const channel =
    params.deliveryChannel && !isInternalMessageChannel(params.deliveryChannel)
      ? (normalizeChannelId(params.deliveryChannel) ?? params.deliveryChannel)
      : undefined;
  if (!channel) {
    return payloads as ReplyPayload[];
  }
  const applyChannelTransforms = params.applyChannelTransforms ?? true;
  const deliveryPlugin = applyChannelTransforms ? getChannelPlugin(channel) : undefined;

  const sessionKey = params.outboundSession?.key ?? params.opts.sessionKey;
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({
      sessionKey,
      config: params.cfg,
    });
  const replyPrefix = createReplyPrefixContext({
    cfg: params.cfg,
    agentId,
    channel,
    accountId: params.accountId,
  });
  const modelUsed = params.result.meta.agentMeta?.model;
  const providerUsed = params.result.meta.agentMeta?.provider;
  if (params.includeRunModelContext !== false && providerUsed && modelUsed) {
    replyPrefix.onModelSelected({
      provider: providerUsed,
      model: modelUsed,
      thinkLevel: undefined,
    });
  }
  const responsePrefixContext = replyPrefix.responsePrefixContextProvider();
  const resolvedResponsePrefix = resolveResponsePrefixTemplate(
    replyPrefix.responsePrefix,
    responsePrefixContext,
  );
  const responsePrefix =
    params.includeRunModelContext === false &&
    resolvedResponsePrefix &&
    UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN.test(resolvedResponsePrefix)
      ? undefined
      : replyPrefix.responsePrefix;
  const transformReplyPayload = deliveryPlugin?.messaging?.transformReplyPayload
    ? (payload: ReplyPayload) =>
        deliveryPlugin.messaging?.transformReplyPayload?.({
          payload,
          cfg: params.cfg,
          accountId: params.accountId,
        }) ?? payload
    : undefined;

  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    const normalized = normalizeReplyPayload(payload as ReplyPayload, {
      responsePrefix,
      applyChannelTransforms,
      responsePrefixContext,
      transformReplyPayload,
    });
    if (normalized) {
      normalizedPayloads.push(normalized);
    }
  }
  return normalizedPayloads;
}

/** Delivers an agent command result or records why delivery was skipped. */
export async function deliverAgentCommandResult(
  params: DeliverAgentCommandResultParams,
): Promise<AgentCommandDeliveryResult> {
  params.assertDeliveryCurrent?.();
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliveryAgentId =
    outboundSession?.agentId ??
    resolveSessionAgentId({
      sessionKey: effectiveSessionKey,
      config: cfg,
    }) ??
    resolveDefaultAgentId(cfg);
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
  const resolveDeliveryRouting = async (candidateSessionEntry: SessionEntry | undefined) => {
    const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg,
      agentId: deliveryAgentId,
      currentSessionKey: effectiveSessionKey,
      sessionEntry: candidateSessionEntry,
      requestedChannel: opts.replyChannel ?? opts.channel,
      explicitTo: opts.replyTo ?? opts.to,
      explicitThreadId: opts.threadId,
      accountId: opts.replyAccountId ?? opts.accountId,
      wantsDelivery: deliver,
      turnSourceChannel,
      turnSourceTo,
      turnSourceAccountId,
      turnSourceThreadId,
    });
    params.assertDeliveryCurrent?.();
    let deliveryChannel = deliveryPlan.resolvedChannel;
    if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {
      try {
        const selection = await resolveMessageChannelSelection({ cfg });
        params.assertDeliveryCurrent?.();
        deliveryChannel = selection.channel;
      } catch {
        // Keep the internal channel marker; error handling below reports the failure.
      }
    }
    const effectiveDeliveryPlan =
      deliveryChannel === deliveryPlan.resolvedChannel
        ? deliveryPlan
        : {
            ...deliveryPlan,
            resolvedChannel: deliveryChannel,
          };
    // Channel docking: delivery channels are resolved via plugin registry.
    const deliveryPlugin =
      deliver && !isInternalMessageChannel(deliveryChannel)
        ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
        : undefined;
    const isDeliveryChannelKnown =
      isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);
    const targetMode =
      opts.deliveryTargetMode ??
      effectiveDeliveryPlan.deliveryTargetMode ??
      (opts.to ? "explicit" : "implicit");
    const defaultAccountId =
      !effectiveDeliveryPlan.resolvedAccountId && deliveryPlugin?.config?.listAccountIds
        ? resolveChannelDefaultAccountId({ plugin: deliveryPlugin, cfg })
        : undefined;
    const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId ?? defaultAccountId;
    const resolvedDeliveryPlan =
      resolvedAccountId === effectiveDeliveryPlan.resolvedAccountId
        ? effectiveDeliveryPlan
        : { ...effectiveDeliveryPlan, resolvedAccountId };
    const resolved =
      deliver && isDeliveryChannelKnown && deliveryChannel
        ? resolveAgentOutboundTarget({
            cfg,
            plan: resolvedDeliveryPlan,
            targetMode,
            validateExplicitTarget: true,
          })
        : {
            resolvedTarget: null,
            resolvedTo: effectiveDeliveryPlan.resolvedTo,
            targetMode,
          };
    const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
    const replyTransport =
      deliveryPlugin?.threading?.resolveReplyTransport?.({
        cfg,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
      }) ?? null;
    return {
      deliveryPlan,
      deliveryChannel,
      effectiveDeliveryPlan: resolvedDeliveryPlan,
      deliveryPlugin,
      isDeliveryChannelKnown,
      targetMode,
      defaultAccountId,
      resolvedAccountId,
      resolved,
      resolvedTarget: resolved.resolvedTarget,
      deliveryTarget: resolved.resolvedTo,
      resolvedThreadId,
      resolvedReplyToId: replyTransport?.replyToId ?? undefined,
      resolvedThreadTarget:
        replyTransport && Object.hasOwn(replyTransport, "threadId")
          ? (replyTransport.threadId ?? null)
          : (resolvedThreadId ?? null),
    };
  };
  const deliveryRoutingFailureReason = (
    route: Awaited<ReturnType<typeof resolveDeliveryRouting>>,
  ): string | undefined => {
    if (!deliver) {
      return undefined;
    }
    if (isInternalMessageChannel(route.deliveryChannel)) {
      return "channel_resolved_to_internal";
    }
    if (!route.isDeliveryChannelKnown) {
      return "unknown_channel";
    }
    if (route.resolvedTarget && !route.resolvedTarget.ok) {
      return "invalid_delivery_target";
    }
    if (!route.deliveryTarget) {
      return "no_delivery_target";
    }
    return undefined;
  };
  const isRetryableFreshSessionRoutingFailure = (
    route: Awaited<ReturnType<typeof resolveDeliveryRouting>>,
  ): boolean => {
    const reason = deliveryRoutingFailureReason(route);
    if (!reason) {
      return false;
    }
    if (reason === "unknown_channel") {
      return false;
    }
    return true;
  };

  let deliveryRouting = await resolveDeliveryRouting(sessionEntry);
  params.assertDeliveryCurrent?.();
  if (isRetryableFreshSessionRoutingFailure(deliveryRouting)) {
    const freshSessionEntry = await params.resolveFreshSessionEntryForDelivery?.();
    params.assertDeliveryCurrent?.();
    const expectedFreshSessionId =
      params.expectedSessionIdForFreshDelivery ?? sessionEntry?.sessionId;
    if (
      freshSessionEntry &&
      freshSessionEntry !== sessionEntry &&
      isFreshDeliverySessionMatch(freshSessionEntry, expectedFreshSessionId)
    ) {
      const freshRouting = await resolveDeliveryRouting(freshSessionEntry);
      params.assertDeliveryCurrent?.();
      if (!deliveryRoutingFailureReason(freshRouting)) {
        if (!opts.json) {
          runtime.log(
            `[delivery] refreshed session routing before final delivery (session=${effectiveSessionKey ?? "unknown"} channel=${freshRouting.deliveryChannel})`,
          );
        }
        deliveryRouting = freshRouting;
      }
    }
  }
  const {
    deliveryChannel,
    isDeliveryChannelKnown,
    defaultAccountId,
    resolvedAccountId,
    resolvedTarget,
    deliveryTarget,
    resolvedReplyToId,
    resolvedThreadTarget,
  } = deliveryRouting;

  let deliveryLoggedError = false;
  const logDeliveryError = (err: unknown) => {
    deliveryLoggedError = true;
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };
  let strictPreDeliveryError: unknown;
  let deliveryStatus: AgentCommandDeliveryStatus | undefined;
  const handlePreDeliveryError = (err: unknown, reason: string) => {
    deliveryStatus = preDeliveryFailureStatus(reason);
    if (!bestEffortDeliver) {
      if (opts.json) {
        strictPreDeliveryError = err;
        return;
      }
      throw err;
    }
    logDeliveryError(err);
  };

  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      handlePreDeliveryError(err, "channel_resolved_to_internal");
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      handlePreDeliveryError(err, "unknown_channel");
    } else if (resolvedTarget && !resolvedTarget.ok) {
      handlePreDeliveryError(resolvedTarget.error, "invalid_delivery_target");
    }
  }

  const normalizedReplyPayloads = normalizeAgentCommandReplyPayloads({
    cfg,
    opts,
    outboundSession,
    payloads,
    result,
    deliveryChannel,
    accountId: resolvedAccountId,
    applyChannelTransforms: deliver,
  });
  const canonicalReplyPayloads = projectOutboundPayloadPlanForDelivery(
    createOutboundPayloadPlan(normalizedReplyPayloads),
  );
  const shouldFilterDeliveredPayloads =
    deliver &&
    !deliveryStatus &&
    Boolean(deliveryTarget) &&
    !isInternalMessageChannel(deliveryChannel);
  const normalizeSentTexts = (sentTexts: readonly string[]) =>
    normalizeAgentCommandReplyPayloads({
      cfg,
      opts,
      outboundSession,
      payloads: sentTexts.map((text) => ({ text })),
      result,
      deliveryChannel,
      accountId: resolvedAccountId,
      applyChannelTransforms: deliver,
      includeRunModelContext: false,
    }).flatMap((payload) => (payload.text?.trim() ? [payload.text] : []));
  const filterDeliveredPayloads = (
    replyPayloads: ReplyPayload[],
    normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>,
  ) => {
    if (!shouldFilterDeliveredPayloads || !deliveryTarget) {
      return Promise.resolve(replyPayloads);
    }
    return filterAlreadyDeliveredReplyPayloads({
      cfg,
      payloads: replyPayloads,
      result,
      deliveryChannel,
      deliveryTarget,
      accountId: resolvedAccountId,
      sourceAccountId: turnSourceAccountId,
      defaultAccountId,
      // Command delivery projects payloads onto one batch route below, so
      // per-payload reply metadata does not change the destination here.
      threadId: resolvedThreadTarget ?? resolvedReplyToId ?? undefined,
      normalizeMediaPaths,
      normalizeSentTexts,
    });
  };
  // Remove exact raw media matches before blocked-path normalization can turn
  // a successful message-tool send into a false media failure warning.
  const rawFilteredReplyPayloads = await filterDeliveredPayloads(canonicalReplyPayloads);
  // Auto-reply-style media-path normalization must also run for the CLI
  // `--deliver` path. Without it, relative reply media paths reach the
  // outbound loader unresolved and `assertLocalMediaAllowed` fails with
  // "Local media path is not under an allowed directory". Mirrors the
  // normalizer wiring in `src/auto-reply/reply/agent-runner.ts`.
  const mediaNormalization =
    deliver && !deliveryStatus && !isInternalMessageChannel(deliveryChannel)
      ? await normalizeReplyMediaPathsForDelivery({
          cfg,
          payloads: rawFilteredReplyPayloads,
          sessionKey: effectiveSessionKey,
          outboundSession,
          deliveryChannel,
          accountId: resolvedAccountId,
        })
      : { payloads: rawFilteredReplyPayloads };
  const mediaNormalizedReplyPayloads = await filterDeliveredPayloads(
    mediaNormalization.payloads,
    mediaNormalization.normalizeMediaPaths,
  );
  params.assertDeliveryCurrent?.();
  const outboundPayloadPlan = createOutboundPayloadPlan(mediaNormalizedReplyPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
  const resultMeta = mergeResultMetaOverrides(result.meta, opts.resultMetaOverrides);
  const captureDeliveryResult = (
    deliveryResult: AgentCommandDeliveryResult,
  ): AgentCommandDeliveryResult => {
    params.onDeliveryResult?.(deliveryResult);
    return deliveryResult;
  };
  const emitJsonEnvelope = (status?: AgentCommandDeliveryStatus) => {
    if (!opts.json) {
      return;
    }
    writeRuntimeJson(runtime, {
      ...buildOutboundResultEnvelope({
        payloads: normalizedPayloads,
        meta: resultMeta,
      }),
      ...(status ? { deliveryStatus: status } : {}),
    });
  };
  if (strictPreDeliveryError) {
    emitJsonEnvelope(deliveryStatus);
    captureDeliveryResult(
      buildDeliveryResult({
        payloads: normalizedPayloads,
        meta: resultMeta,
        result,
        deliveryStatus,
      }),
    );
    throw toErrorObject(strictPreDeliveryError, "Non-Error thrown");
  }

  const deliveryPayloads = projectOutboundPayloadPlanForOutbound(outboundPayloadPlan);
  if (deliveryPayloads.length === 0) {
    deliveryStatus = deliver ? (deliveryStatus ?? noVisiblePayloadStatus()) : undefined;
    const deliverySucceeded = deliveryStatus?.succeeded === true ? true : undefined;
    emitJsonEnvelope(deliveryStatus);
    return captureDeliveryResult(
      buildDeliveryResult({
        payloads: normalizedPayloads,
        meta: resultMeta,
        result,
        deliverySucceeded,
        deliveryStatus,
      }),
    );
  }

  let deliverySucceeded = false;
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (isNestedAgentLane(opts.lane)) {
      logNestedOutput(runtime, opts, output, effectiveSessionKey);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
    emitJsonEnvelope();
    return captureDeliveryResult(
      buildDeliveryResult({ payloads: normalizedPayloads, meta: resultMeta, result }),
    );
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget && !deliveryStatus) {
      params.assertDeliveryCurrent?.();
      const restartAbort = createRestartOnlyAbortSignal(opts.abortSignal);
      let send: DurableSendResult;
      try {
        send = await sendDurableMessageBatch({
          cfg,
          channel: deliveryChannel,
          to: deliveryTarget,
          accountId: resolvedAccountId,
          payloads: deliveryPayloads,
          session: outboundSession,
          replyToId: resolvedReplyToId ?? null,
          threadId: resolvedThreadTarget ?? null,
          bestEffort: bestEffortDeliver,
          durability: bestEffortDeliver ? "best_effort" : "required",
          signal: restartAbort.signal,
          onDeliveryIntent: restartAbort.dispose,
          onError: logDeliveryError,
          onPayload: logPayload,
          deps: createOutboundSendDeps(deps),
        });
      } finally {
        restartAbort.dispose();
      }
      if (restartAbort.signal?.aborted && send.status === "failed") {
        throw restartAbort.signal.reason;
      }
      deliveryStatus = deliveryStatusFromDurableSend(send);
      if (!bestEffortDeliver && (send.status === "failed" || send.status === "partial_failed")) {
        emitJsonEnvelope(deliveryStatus);
        captureDeliveryResult(
          buildDeliveryResult({
            payloads: normalizedPayloads,
            meta: resultMeta,
            result,
            deliverySucceeded: false,
            deliveryStatus,
          }),
        );
        throw send.error;
      }
      deliverySucceeded = send.status === "sent" || send.status === "suppressed";
    }
  }
  if (deliver && !deliveryStatus) {
    deliveryStatus = preDeliveryFailureStatus("no_delivery_target");
  }
  if (deliver && !deliverySucceeded && !opts.json && !deliveryLoggedError) {
    const message =
      `[delivery] delivery requested but not completed: ${deliveryStatus?.status ?? "unknown"} ` +
      `(reason=${deliveryStatus?.reason ?? "none"} session=${effectiveSessionKey ?? "unknown"} ` +
      `channel=${deliveryChannel ?? "none"} target=${deliveryTarget ?? "none"} ` +
      `payloads=${deliveryPayloads.length})`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  }

  emitJsonEnvelope(deliveryStatus);
  return captureDeliveryResult(
    buildDeliveryResult({
      payloads: normalizedPayloads,
      meta: resultMeta,
      result,
      deliverySucceeded,
      deliveryStatus,
    }),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
