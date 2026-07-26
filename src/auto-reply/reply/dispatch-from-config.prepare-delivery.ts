import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
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
    acpDispatchSessionKey,
    cfg,
    ctx,
    dispatcher,
    getDispatchAbortSignal,
    groupId,
    isGroup,
    markInboundDedupeReplayUnsafe,
    params,
    replyRoute,
    routeReplyThreadId,
    sessionStoreEntry,
    workspaceDir,
  } = state;
  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const sessionAcpMeta = sessionStoreEntry.sessionKey
    ? readAcpSessionMeta({ sessionKey: sessionStoreEntry.sessionKey })
    : undefined;
  const sessionEntryWithAcp =
    sessionAcpMeta && sessionStoreEntry.entry
      ? { ...sessionStoreEntry.entry, acp: sessionAcpMeta }
      : sessionStoreEntry.entry;
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
  const deliveryChannel = shouldRouteToOriginating ? routeReplyChannel : currentSurface;
  const shouldPrepareRoutedReplyDelivery = shouldRouteToOriginating && Boolean(routeReplyChannel);
  const replyContextAccountId = routeReplyChannel
    ? resolveReplyDeliveryAccountId(cfg, routeReplyChannel, replyRoute.accountId)
    : undefined;
  const routedReplyAccountId = shouldPrepareRoutedReplyDelivery ? replyContextAccountId : undefined;
  const routedReplyDelivery = shouldPrepareRoutedReplyDelivery
    ? createReplyDeliveryContext(
        resolveReplyToMode(cfg, routeReplyChannel, routedReplyAccountId, replyRoute.chatType),
        replyRoute.chatType,
      )
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
      sessionKey: acpDispatchSessionKey,
      workspaceDir,
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
    },
  ) => {
    if (!shouldRouteToOriginating || !routeReplyChannel || !routeReplyTo || !routeReplyRuntime) {
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
    return await routeReplyRuntime.routeReply({
      payload,
      channel: routeReplyChannel,
      to: routeReplyTo,
      sessionKey: agentRuntimeSessionKey,
      policySessionKey:
        options?.sessionKey ?? resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey,
      policyConversationType: resolveRoutedPolicyConversationType(ctx),
      accountId: routedReplyAccountId,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
      threadId: routeReplyThreadId,
      replyDelivery: routedReplyDelivery,
      cfg,
      abortSignal: options?.abortSignal,
      mirror: options?.mirror,
      isGroup,
      groupId,
      replyKind: options?.kind ?? "final",
      runId: params.replyOptions?.runId,
      responsePrefixContext: options?.responsePrefixContext,
    });
  };

  const isRoutedReplyDelivered = (result: { ok: boolean; suppressed?: boolean }) =>
    result.ok && result.suppressed !== true;

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
  ): Promise<void> => {
    // Keep the runtime guard explicit because this helper is called from nested
    // reply callbacks where TypeScript cannot narrow shouldRouteToOriginating.
    if (!routeReplyRuntime || !routeReplyChannel || !routeReplyTo) {
      return;
    }
    const effectiveAbortSignal = abortSignal ?? getDispatchAbortSignal();
    if (effectiveAbortSignal?.aborted) {
      return;
    }
    const result = await routeReplyToOriginating(payload, {
      abortSignal: effectiveAbortSignal,
      mirror,
      kind,
    });
    if (result && !result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
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
      return result.ok;
    }
    markInboundDedupeReplayUnsafe();
    return mode === "additive"
      ? dispatcher.sendToolResult(bindingPayload)
      : dispatcher.sendFinalReply(bindingPayload);
  };
  const nextState = extendPreparedDispatchState(
    state,
    {
      suppressAcpChildUserDelivery,
      normalizedCurrentSurface,
      isInternalWebchatTurn,
      routeReplyChannel,
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
    },
    {},
  );
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchDeliveryResult = Awaited<ReturnType<typeof prepareDispatchDelivery>>;
export type PrepareDispatchDeliveryReadyState = Extract<
  PrepareDispatchDeliveryResult,
  { status: "ready" }
>["state"];
