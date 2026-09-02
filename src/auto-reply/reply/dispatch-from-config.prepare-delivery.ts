import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import { logVerbose } from "../../globals.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { resolveRoutedPolicyConversationType } from "./dispatch-from-config.context.js";
import type { GatherDispatchRequestReadyState } from "./dispatch-from-config.gather.js";
import { hasAskUserPayload } from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import {
  loadReplyMediaPathsRuntime,
  loadRouteReplyRuntime,
} from "./dispatch-from-config.runtime-loaders.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  createReplyDeliveryContext,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import { resolveReplyRoutingDecision } from "./routing-policy.js";

export async function prepareDispatchDelivery(state: GatherDispatchRequestReadyState) {
  const {
    cfg,
    ctx,
    groupId,
    markInboundDedupeReplayUnsafe,
    replyRoute,
    sessionStoreEntry,
    turnLedger,
  } = state;
  // Gather awaits runtime preparation after its first row read. Reread ACP
  // metadata with the same owner to preserve current lifecycle fences and
  // recovery from an earlier store-read failure.
  const currentAcpSession = sessionStoreEntry.sessionKey
    ? readAcpSessionEntry({
        cfg,
        agentId: sessionStoreEntry.agentId,
        sessionKey: sessionStoreEntry.sessionKey,
      })
    : undefined;
  const sessionEntryWithAcp = currentAcpSession?.entry
    ? { ...currentAcpSession.entry, acp: currentAcpSession.acp }
    : undefined;
  const suppressAcpChildUserDelivery = isParentOwnedBackgroundAcpSession(sessionEntryWithAcp);
  const normalizedRouteReplyChannel = normalizeMessageChannel(replyRoute.channel);
  const normalizedProviderChannel = normalizeMessageChannel(ctx.Provider);
  const normalizedSurfaceChannel = normalizeMessageChannel(ctx.Surface);
  const normalizedCurrentSurface = normalizedProviderChannel ?? normalizedSurfaceChannel;
  const effectiveExplicitDeliverRoute =
    ctx.ExplicitDeliverRoute === true || replyRoute.inheritedExternalRoute === true;
  const isInternalWebchatTurn =
    normalizedCurrentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (normalizedSurfaceChannel === INTERNAL_MESSAGE_CHANNEL || !normalizedSurfaceChannel) &&
    !effectiveExplicitDeliverRoute;
  const hasRouteReplyCandidate = Boolean(
    !suppressAcpChildUserDelivery &&
    !isInternalWebchatTurn &&
    normalizedRouteReplyChannel &&
    replyRoute.to &&
    normalizedRouteReplyChannel !== normalizedCurrentSurface,
  );
  const routeReplyRuntime = hasRouteReplyCandidate ? await loadRouteReplyRuntime() : undefined;
  const {
    originatingChannel: routeReplyChannel,
    currentSurface,
    shouldRouteToOriginating,
    shouldSuppressTyping,
  } = resolveReplyRoutingDecision({
    provider: ctx.Provider,
    surface: ctx.Surface,
    explicitDeliverRoute: effectiveExplicitDeliverRoute,
    originatingChannel: replyRoute.channel,
    originatingTo: replyRoute.to,
    suppressDirectUserDelivery: suppressAcpChildUserDelivery,
    isRoutableChannel: routeReplyRuntime?.isRoutableChannel ?? (() => false),
  });
  const routeReplyTo = replyRoute.to;
  // Durable intent identifies an outbound write; it never authorizes a new
  // destination or bypasses private-webchat and parent-owned-session fences.
  const canRouteDurableBlockReply = Boolean(
    !suppressAcpChildUserDelivery &&
    !isInternalWebchatTurn &&
    routeReplyChannel &&
    routeReplyTo &&
    routeReplyChannel === normalizedCurrentSurface,
  );
  const deliveryChannel = shouldRouteToOriginating ? routeReplyChannel : currentSurface;
  const replyContextAccountId = routeReplyChannel
    ? resolveReplyDeliveryAccountId(cfg, routeReplyChannel, replyRoute.accountId)
    : undefined;
  let normalizeReplyMediaPaths:
    | ReturnType<
        (typeof import("./reply-media-paths.runtime.js"))["createReplyMediaPathNormalizer"]
      >
    | undefined;
  const getNormalizeReplyMediaPaths = async () => {
    if (normalizeReplyMediaPaths) {
      return normalizeReplyMediaPaths;
    }
    const { createReplyMediaPathNormalizer } = await loadReplyMediaPathsRuntime();
    normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
      cfg,
      agentId: state.sessionAgentId,
      sessionKey: state.acpDispatchSessionKey,
      workspaceDir: state.workspaceDir,
      messageProvider: deliveryChannel,
      accountId: replyContextAccountId,
      groupId,
      groupChannel: ctx.GroupChannel,
      groupSpace: ctx.GroupSpace,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
    });
    return normalizeReplyMediaPaths;
  };
  const normalizeReplyMediaPayload = async (payload: ReplyPayload): Promise<ReplyPayload> => {
    if (!resolveSendableOutboundReplyParts(payload).hasMedia) {
      return payload;
    }
    const normalizeReplyMediaPayloadPaths = await getNormalizeReplyMediaPaths();
    return await normalizeReplyMediaPayloadPaths(payload);
  };

  const routeReplyToOriginating = async (
    payload: ReplyPayload,
    options?: {
      abortSignal?: AbortSignal;
      mirror?: boolean;
      kind?: ReplyDispatchKind;
      responsePrefixContext?: ResponsePrefixContext;
      sessionKey?: string;
      deliveryIntentId?: string;
    },
  ) => {
    const durableRouteAuthorized =
      options?.deliveryIntentId !== undefined && canRouteDurableBlockReply;
    const runtime =
      routeReplyRuntime ?? (durableRouteAuthorized ? await loadRouteReplyRuntime() : undefined);
    if (
      (!shouldRouteToOriginating && !durableRouteAuthorized) ||
      !routeReplyChannel ||
      !routeReplyTo ||
      !runtime
    ) {
      if (options?.deliveryIntentId) {
        throw new Error("durable block reply route unavailable");
      }
      return null;
    }
    markInboundDedupeReplayUnsafe();
    // Outbound session.key must match the session key used by the agent
    // runtime that produced this payload, so agent_end and message delivery
    // hooks expose the same canonical key for native command redirects.
    const agentRuntimeSessionKey =
      options?.sessionKey ??
      (ctx.CommandSource === "native"
        ? (resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey)
        : ctx.SessionKey);
    const result = await runtime.routeReply({
      payload,
      channel: routeReplyChannel,
      to: routeReplyTo,
      agentId: state.sessionAgentId,
      sessionKey: agentRuntimeSessionKey,
      policySessionKey:
        options?.sessionKey ?? resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey,
      policyConversationType: resolveRoutedPolicyConversationType(ctx),
      accountId: replyContextAccountId,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
      threadId: state.routeReplyThreadId,
      replyDelivery: createReplyDeliveryContext(
        resolveReplyToMode(cfg, routeReplyChannel, replyContextAccountId, replyRoute.chatType),
        replyRoute.chatType,
      ),
      cfg,
      abortSignal: options?.abortSignal,
      mirror: options?.mirror,
      isGroup: state.isGroup,
      groupId,
      replyKind: options?.kind ?? "final",
      runId: state.params.replyOptions?.runId,
      responsePrefixContext: options?.responsePrefixContext,
      deliveryIntentId: options?.deliveryIntentId,
    });
    // Routed sends settle here: the transport result is the settlement. This is
    // the single routed choke point, so every routed lane feeds the turn ledger.
    turnLedger.recordRoutedDelivery(payload, isRoutedReplyDelivered(result));
    return result;
  };

  const isRoutedReplyDelivered = (result: { delivered: boolean }) => result.delivered;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * routeReplyChannel and routeReplyTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
    kind: ReplyDispatchKind = "tool",
    deliveryIntentId?: string,
  ) => {
    // Keep the runtime guard explicit because this helper is called from nested
    // reply callbacks where TypeScript cannot narrow shouldRouteToOriginating.
    if (!routeReplyRuntime && !deliveryIntentId) {
      return null;
    }
    const effectiveAbortSignal = abortSignal ?? state.getDispatchAbortSignal();
    if (effectiveAbortSignal?.aborted) {
      return null;
    }
    const result = await routeReplyToOriginating(payload, {
      abortSignal: effectiveAbortSignal,
      mirror,
      kind,
      deliveryIntentId,
    });
    if (result && !result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
      if (deliveryIntentId) {
        throw new Error(result.error ?? "durable block reply delivery failed");
      }
    }
    if (hasAskUserPayload(payload) && !effectiveAbortSignal?.aborted && !result?.delivered) {
      throw new Error("ask_user prompt delivery failed");
    }
    return result;
  };

  type PluginBindingTranscriptOwner = {
    agentId: string;
    expectedSessionId?: string;
    sessionKey: string;
    transcriptWriteBlocked?: true;
  };
  const deliverBindingPayload = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
    transcriptOwner?: PluginBindingTranscriptOwner,
  ): Promise<boolean> => {
    // Metadata is delivery-specific. Keep it off the plugin-owned payload so a
    // reused reply object cannot carry a stale transcript owner into a later turn.
    const bindingPayload = setReplyPayloadMetadata(
      copyReplyPayloadMetadata(payload, { ...payload }),
      {
        sourceReplyTranscriptMirror: transcriptOwner
          ? {
              sessionKey: transcriptOwner.sessionKey,
              agentId: transcriptOwner.agentId,
              ...(transcriptOwner.expectedSessionId
                ? { expectedSessionId: transcriptOwner.expectedSessionId }
                : {}),
              ...(transcriptOwner.transcriptWriteBlocked ? { transcriptWriteBlocked: true } : {}),
            }
          : undefined,
      },
    );
    const result = await routeReplyToOriginating(bindingPayload, {
      kind: mode === "terminal" ? "final" : "tool",
      sessionKey: transcriptOwner?.sessionKey,
    });
    if (result) {
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result.delivered || result.suppressed === true;
    }
    markInboundDedupeReplayUnsafe();
    return mode === "additive"
      ? turnLedger.sendQueued("tool", bindingPayload).queued
      : turnLedger.sendQueued("final", bindingPayload).queued;
  };
  const nextState = extendPreparedDispatchState(state, {
    suppressAcpChildUserDelivery,
    normalizedCurrentSurface,
    isInternalWebchatTurn,
    routeReplyChannel,
    canRouteDurableBlockReply,
    shouldRouteToOriginating,
    shouldSuppressTyping,
    routeReplyTo,
    deliveryChannel,
    replyContextAccountId,
    normalizeReplyMediaPayload,
    routeReplyToOriginating,
    isRoutedReplyDelivered,
    sendPayloadAsync,
    deliverBindingPayload,
  });
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchDeliveryResult = Awaited<ReturnType<typeof prepareDispatchDelivery>>;
export type PrepareDispatchDeliveryReadyState = Extract<
  PrepareDispatchDeliveryResult,
  { status: "ready" }
>["state"];
