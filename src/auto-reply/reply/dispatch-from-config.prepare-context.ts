import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { resolveConversationBindingRecord } from "../../bindings/records.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import {
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import {
  isPluginOwnedSessionBindingRecord,
  toPluginConversationBinding,
} from "../../plugins/conversation-binding.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { resolveSilentReplyPolicyFromPolicies } from "../../shared/silent-reply-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import type { ReplyPayload } from "../reply-payload.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";
import {
  resolveRoutedPolicyConversationType,
  resolveSessionStoreLookup,
} from "./dispatch-from-config.context.js";
import type { PluginBindingTranscriptOwner } from "./dispatch-from-config.events.js";
import {
  resolveHarnessSourceVisibleRepliesDefault,
  resolveTurnModelOverride,
} from "./dispatch-from-config.harness-defaults.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchDeliveryReadyState } from "./dispatch-from-config.prepare-delivery.js";
import { createInternalHookEvent, triggerInternalHook } from "./dispatch-from-config.runtime.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";
import { claimInboundDedupe, commitInboundDedupe, releaseInboundDedupe } from "./inbound-dedupe.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { isDuplicateRestartRecoverySource } from "./restart-recovery-claim.js";
import {
  isExplicitSourceReplyCommand,
  isUnauthorizedTextSlashCommand,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  setChannelSourceTurnId,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";

export async function prepareDispatchOperationContext(state: PrepareDispatchDeliveryReadyState) {
  const {
    acpDispatchSessionKey,
    buildMessageReceivedHookContext,
    cfg,
    completeDispatchReplyOperation,
    ctx,
    deliverBindingPayload,
    dispatcher,
    hookRunner,
    isInternalWebchatTurn,
    markIdle,
    markProcessing,
    params,
    recordAgentDispatchCompleted,
    recordProcessed,
    releasePreDispatchLifecycleAdmission,
    replyRoute,
    routeReplyChannel,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    shouldRouteToOriginating,
    shouldSuppressTyping,
    suppressAcpChildUserDelivery,
    timestamp,
  } = state;
  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
    transcriptOwner?: PluginBindingTranscriptOwner,
  ): Promise<boolean> => {
    if (suppressAutomaticSourceDelivery) {
      return false;
    }
    return await deliverBindingPayload(payload, mode, transcriptOwner);
  };

  // Hook contexts use transport-native ids (for example Slack `U123`), while
  // binding records use the channel's canonical target (`user:U123`). Resolve
  // through the binding contract instead of reusing the hook projection.
  const pluginBindingConversation = resolveConversationBindingContextFromMessage({ cfg, ctx });
  const pluginOwnedBindingRecord = pluginBindingConversation
    ? resolveConversationBindingRecord({
        channel: pluginBindingConversation.channel,
        accountId: pluginBindingConversation.accountId,
        conversationId: pluginBindingConversation.conversationId,
        parentConversationId: pluginBindingConversation.parentConversationId,
      })
    : null;
  const pluginOwnedBinding = isPluginOwnedSessionBindingRecord(pluginOwnedBindingRecord)
    ? toPluginConversationBinding(pluginOwnedBindingRecord)
    : null;
  const pluginBindingSessionKey = normalizeOptionalString(
    pluginOwnedBindingRecord?.targetSessionKey,
  );
  const persistPluginBindingUserTurn = async (): Promise<
    PluginBindingTranscriptOwner | undefined
  > => {
    const recorder = params.replyOptions?.userTurnTranscriptRecorder;
    if (!recorder || !pluginBindingSessionKey) {
      return undefined;
    }
    const targetAgentId = resolveSessionAgentId({
      sessionKey: pluginBindingSessionKey,
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    });
    const blockedOwner = (expectedSessionId?: string): PluginBindingTranscriptOwner => ({
      agentId: targetAgentId,
      sessionKey: pluginBindingSessionKey,
      ...(expectedSessionId ? { expectedSessionId } : {}),
      transcriptWriteBlocked: true,
    });
    if (recorder.hasPersisted()) {
      return blockedOwner();
    }
    let attemptedSessionId: string | undefined;
    let lastOwner: PluginBindingTranscriptOwner | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const targetSessionStoreEntry = resolveSessionStoreLookup(
        {
          ...ctx,
          CommandTargetSessionKey: undefined,
          SessionKey: pluginBindingSessionKey,
        },
        cfg,
      );
      const targetSessionEntry = targetSessionStoreEntry.entry;
      if (!targetSessionEntry || targetSessionEntry.sessionId === attemptedSessionId) {
        break;
      }
      attemptedSessionId = targetSessionEntry.sessionId;
      lastOwner = {
        agentId: targetAgentId,
        expectedSessionId: targetSessionEntry.sessionId,
        sessionKey: pluginBindingSessionKey,
      };
      const result = await recorder.persistApproved({
        target: {
          sessionId: targetSessionEntry.sessionId,
          sessionKey: pluginBindingSessionKey,
          sessionEntry: targetSessionEntry,
          ...(targetSessionStoreEntry.store ? { sessionStore: targetSessionStoreEntry.store } : {}),
          storePath: targetSessionStoreEntry.storePath,
          agentId: targetAgentId,
          cwd: resolveAgentWorkspaceDir(cfg, targetAgentId),
          config: cfg,
        },
        expectedSessionId: targetSessionEntry.sessionId,
        retryIfUnpersisted: true,
      });
      if (result) {
        return lastOwner;
      }
    }
    if (!lastOwner) {
      recorder.markBlocked();
      return blockedOwner();
    }
    recorder.markBlocked();
    logVerbose(`plugin-bound user-turn persistence skipped after the target session changed`);
    return blockedOwner(lastOwner.expectedSessionId);
  };

  // Resolve automatic source-delivery suppression early so every outbound path
  // below (plugin-binding notices, fast-abort, normal dispatch) honors it. The
  // agent still processes inbound, but automatic replies/notices/indicators are
  // blocked; explicit message tool sends remain available.
  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionStoreEntry.entry,
    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
    channel:
      (shouldRouteToOriginating ? routeReplyChannel : undefined) ??
      sessionDeliveryChannel(sessionStoreEntry.entry) ??
      replyRoute.channel ??
      ctx.Surface ??
      ctx.Provider ??
      undefined,
    chatType: sessionStoreEntry.entry?.chatType,
  });
  const {
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: cfg,
    sessionKey: acpDispatchSessionKey,
    agentId: sessionAgentId,
  });
  const chatType = normalizeChatType(ctx.ChatType);
  const silentReplyConversationType = resolveRoutedPolicyConversationType(ctx);
  const silentReplySurface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
  const emptyFinalAllowedAsSilent =
    silentReplyConversationType !== undefined &&
    resolveSilentReplyPolicyFromPolicies({
      conversationType: silentReplyConversationType,
      defaultPolicy: cfg.agents?.defaults?.silentReply,
      surfacePolicy: silentReplySurface
        ? cfg.surfaces?.[silentReplySurface]?.silentReply
        : undefined,
    }) === "allow";
  const configuredVisibleReplies =
    chatType === "group" || chatType === "channel"
      ? (cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies)
      : cfg.messages?.visibleReplies;
  const harnessDefaultVisibleReplies =
    configuredVisibleReplies === undefined && chatType !== "group" && chatType !== "channel"
      ? resolveHarnessSourceVisibleRepliesDefault({
          cfg,
          ctx,
          entry: sessionStoreEntry.entry,
          sessionAgentId,
          sessionKey: acpDispatchSessionKey,
          sessionStore: sessionStoreEntry.store,
          turnModelOverride: resolveTurnModelOverride(params.replyOptions),
        })
      : undefined;
  const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
  const prefersMessageToolDelivery =
    params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" ||
    (ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn) ||
    (params.replyOptions?.sourceReplyDeliveryMode === undefined &&
      !isExplicitSourceReplyCommand(ctx, cfg) &&
      (configuredVisibleReplies === "message_tool" ||
        (!isInternalWebchatTurn && effectiveVisibleReplies === "message_tool")));
  const runtimeProfileAlsoAllow = prefersMessageToolDelivery ? ["message"] : [];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...(profileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...(providerProfileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const groupResolution = resolveGroupSessionKey(ctx);
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: ctx.OriginatingChannel,
    provider: ctx.Provider ?? ctx.Surface,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: acpDispatchSessionKey,
    messageProvider,
    groupId: groupResolution?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId: ctx.AccountId,
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
  });
  const subagentStore = resolveSubagentCapabilityStore(acpDispatchSessionKey, { cfg });
  const subagentPolicy =
    acpDispatchSessionKey &&
    isSubagentEnvelopeSession(acpDispatchSessionKey, {
      cfg,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(cfg, acpDispatchSessionKey, {
          store: subagentStore,
        })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(cfg, acpDispatchSessionKey, {
    store: subagentStore,
  });
  const messageToolAvailable = isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    globalProviderPolicy,
    agentProviderPolicy,
    globalPolicy,
    agentPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ]);
  const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
    cfg,
    ctx,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
    strictMessageToolOnly: ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn,
    sendPolicy,
    suppressAcpChildUserDelivery,
    explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
    shouldSuppressTyping,
    messageToolAvailable,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  const {
    sourceReplyDeliveryMode,
    sessionStableSourceReplyDeliveryMode,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    sendPolicyDenied,
    deliverySuppressionReason,
    suppressHookUserDelivery,
    suppressHookReplyLifecycle,
  } = sourceReplyPolicy;
  const reasoningPayloadsEnabled = params.replyOptions?.reasoningPayloadsEnabled === true;
  const commentaryPayloadsEnabled = params.replyOptions?.commentaryPayloadsEnabled === true;
  const attachSourceReplyDeliveryMode = (
    result: DispatchFromConfigResult,
  ): DispatchFromConfigResult =>
    sourceReplyDeliveryMode === "message_tool_only" || sendPolicyDenied
      ? {
          ...result,
          ...(sourceReplyDeliveryMode === "message_tool_only" ? { sourceReplyDeliveryMode } : {}),
          ...(sendPolicyDenied ? { sendPolicyDenied: true } : {}),
        }
      : result;
  const explicitCommandTurnCtx = isExplicitSourceReplyCommand(ctx, cfg);
  const unauthorizedTextSlashSourceReplyCtx =
    (chatType === "group" || chatType === "channel") && isUnauthorizedTextSlashCommand(ctx);
  const shouldDeliverPluginBindingReply =
    !suppressAutomaticSourceDelivery ||
    explicitCommandTurnCtx ||
    (ctx.InboundEventKind !== "room_event" && !unauthorizedTextSlashSourceReplyCtx);

  const durableSourceTurnId =
    readChannelSourceTurnId(ctx) ??
    (shouldMintChannelSourceTurnId(ctx.Provider ?? ctx.Surface)
      ? buildChannelSourceTurnId({
          provider: resolveOriginMessageProvider({
            originatingChannel: replyRoute.channel,
            provider: ctx.Provider ?? ctx.Surface,
          }),
          accountId: replyRoute.accountId,
          conversationId: replyRoute.to,
          messageId:
            normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid),
        })
      : undefined);
  // Compute once before hooks. The prepared agent turn reuses this exact route-scoped id.
  setChannelSourceTurnId(ctx, durableSourceTurnId);
  if (isDuplicateRestartRecoverySource(sessionStoreEntry.entry, durableSourceTurnId)) {
    // Process-local inbound dedupe cannot see provider redelivery after restart.
    // Drop durable duplicates before any plugin dispatch hook can repeat effects.
    recordProcessed("skipped", { reason: "duplicate" });
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
      }),
    };
  }

  const inboundDedupeClaim = claimInboundDedupe(ctx);
  if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
    recordProcessed("skipped", { reason: "duplicate" });
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
      }),
    };
  }
  const commitInboundDedupeIfClaimed = () => {
    if (inboundDedupeClaim.status === "claimed") {
      commitInboundDedupe(inboundDedupeClaim.key);
    }
  };
  const releaseInboundDedupeIfClaimed = () => {
    if (inboundDedupeClaim.status === "claimed") {
      releaseInboundDedupe(inboundDedupeClaim.key);
    }
  };
  const finishReplyOperationBusyDispatch = (opts?: {
    dedupeDisposition?: "commit" | "release";
    recordAgentDispatchCompleted?: boolean;
    sessionMetadataChanges?: DispatchFromConfigResult["sessionMetadataChanges"];
  }): DispatchFromConfigResult => {
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
    if (opts?.recordAgentDispatchCompleted) {
      recordAgentDispatchCompleted("completed", { reason: "reply-operation-active" });
    }
    recordProcessed("skipped", { reason: "reply-operation-active" });
    markIdle("message_completed");
    if (opts?.dedupeDisposition === "release") {
      releaseInboundDedupeIfClaimed();
    } else {
      commitInboundDedupeIfClaimed();
    }
    return attachSourceReplyDeliveryMode({
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
      ...(opts?.sessionMetadataChanges
        ? { sessionMetadataChanges: opts.sessionMetadataChanges }
        : {}),
    });
  };
  const finishReplyOperationAbortedDispatch = (): DispatchFromConfigResult => {
    commitInboundDedupeIfClaimed();
    recordProcessed("completed", { reason: "reply_operation_aborted" });
    markIdle("message_completed");
    completeDispatchReplyOperation();
    return attachSourceReplyDeliveryMode({
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
    });
  };

  let pluginFallbackReason:
    | "plugin-bound-fallback-missing-plugin"
    | "plugin-bound-fallback-no-handler"
    | undefined;
  const emitMessageReceivedHooks = () => {
    if (
      ctx.SuppressMessageReceivedHooks !== true &&
      hookRunner?.hasHooks("message_received") === true
    ) {
      const messageReceivedHookContext = buildMessageReceivedHookContext();
      fireAndForgetHook(
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(messageReceivedHookContext),
          toPluginMessageContext(messageReceivedHookContext),
        ),
        "dispatch-from-config: message_received plugin hook failed",
      );
    }
    if (ctx.SuppressMessageReceivedHooks !== true && sessionKey) {
      const messageReceivedHookContext = buildMessageReceivedHookContext();
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent("message", "received", sessionKey, {
            ...toInternalMessageReceivedContext(messageReceivedHookContext),
            timestamp,
          }),
        ),
        "dispatch-from-config: message_received internal hook failed",
      );
    }
  };
  markProcessing();
  if (await capturePendingConversationTurnReply({ cfg, ctx })) {
    emitMessageReceivedHooks();
    commitInboundDedupeIfClaimed();
    recordProcessed("completed", { reason: "conversation-turn-reply" });
    markIdle("message_completed");
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
        observedReplyDelivery: true,
      }),
    };
  }
  const nextState = extendPreparedDispatchState(
    state,
    {
      sendBindingNotice,
      pluginOwnedBinding,
      persistPluginBindingUserTurn,
      sendPolicy,
      chatType,
      emptyFinalAllowedAsSilent,
      sourceReplyPolicy,
      sourceReplyDeliveryMode,
      sessionStableSourceReplyDeliveryMode,
      suppressAutomaticSourceDelivery,
      suppressDelivery,
      sendPolicyDenied,
      deliverySuppressionReason,
      suppressHookUserDelivery,
      suppressHookReplyLifecycle,
      reasoningPayloadsEnabled,
      commentaryPayloadsEnabled,
      attachSourceReplyDeliveryMode,
      explicitCommandTurnCtx,
      shouldDeliverPluginBindingReply,
      inboundDedupeClaim,
      commitInboundDedupeIfClaimed,
      finishReplyOperationBusyDispatch,
      finishReplyOperationAbortedDispatch,
      emitMessageReceivedHooks,
    },
    {
      pluginFallbackReason: {
        get: () => pluginFallbackReason,
        set: (
          value:
            | "plugin-bound-fallback-missing-plugin"
            | "plugin-bound-fallback-no-handler"
            | undefined,
        ) => {
          pluginFallbackReason = value;
        },
      },
    },
  );
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchOperationContextResult = Awaited<
  ReturnType<typeof prepareDispatchOperationContext>
>;
export type PrepareDispatchOperationContextReadyState = Extract<
  PrepareDispatchOperationContextResult,
  { status: "ready" }
>["state"];
