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
} from "../../agents/subagents/spawn/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  isPluginOwnedSessionBindingRecord,
  toPluginConversationBinding,
} from "../../plugins/conversation-binding.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { resolveSilentReplyPolicyFromPolicies } from "../../shared/silent-reply-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import { isActiveRunSafeCommandTurn } from "../commands-registry.js";
import type { ReplyPayload } from "../reply-payload.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";
import {
  resolveRoutedPolicyConversationType,
  resolveSessionStoreLookup,
} from "./dispatch-from-config.context.js";
import type { PluginBindingTranscriptOwner } from "./dispatch-from-config.events.js";
import {
  resolveTurnModelOverride,
  resolveVisibleRepliesPolicy,
} from "./dispatch-from-config.harness-defaults.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchDeliveryReadyState } from "./dispatch-from-config.prepare-delivery.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";
import { claimInboundDedupe, commitInboundDedupe, releaseInboundDedupe } from "./inbound-dedupe.js";
import { emitMessageReceivedHooks as emitSharedMessageReceivedHooks } from "./message-received-hooks.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { isDuplicateRestartRecoverySource } from "./restart-recovery-claim.js";
import { resolveStableMessageToolAvailability } from "./session-stable-reply-mode.js";
import {
  isDirectedSourceReplyTurn,
  isExplicitSourceReplyCommand,
  isUnauthorizedTextSlashCommand,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import type { SourceReplyDeliveryRuntimeOptions } from "./source-reply-delivery-runtime.js";
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
    ctx,
    dispatcher,
    hookRunner,
    isInternalWebchatTurn,
    markIdle,
    params,
    recordAgentDispatchCompleted,
    recordProcessed,
    replyRoute,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
  } = state;
  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
    transcriptOwner?: PluginBindingTranscriptOwner,
  ): Promise<boolean> => {
    if (sourceReplyPolicy.suppressAutomaticSourceDelivery) {
      return false;
    }
    return await state.deliverBindingPayload(payload, mode, transcriptOwner);
  };

  // Hook contexts use transport-native ids (for example Slack `U123`), while
  // binding records use the channel's canonical target (`user:U123`). Resolve
  // through the binding contract instead of reusing the hook projection.
  const pluginBindingConversation = resolveConversationBindingContextFromMessage({ cfg, ctx });
  const pluginOwnedBindingRecord = pluginBindingConversation
    ? getSessionBindingService().resolveByConversation({
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
      (state.shouldRouteToOriginating ? state.routeReplyChannel : undefined) ??
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
  // Group silent-reply policy sanctions silence for ambient chatter only. A turn
  // that explicitly addressed the bot (mention) must never end silently, matching
  // the hard-coded direct-chat rule in resolveSilentReplyPolicyFromPolicies.
  const emptyFinalAllowedAsSilent =
    ctx.WasMentioned !== true &&
    silentReplyConversationType !== undefined &&
    resolveSilentReplyPolicyFromPolicies({
      conversationType: silentReplyConversationType,
      defaultPolicy: cfg.agents?.defaults?.silentReply,
      surfacePolicy: silentReplySurface
        ? cfg.surfaces?.[silentReplySurface]?.silentReply
        : undefined,
    }) === "allow";
  const { configuredVisibleReplies, harnessDefaultVisibleReplies } = resolveVisibleRepliesPolicy({
    cfg,
    chatType,
    ctx,
    entry: sessionStoreEntry.entry,
    sessionAgentId,
    sessionKey: acpDispatchSessionKey,
    sessionStore: sessionStoreEntry.store,
    turnModelOverride: resolveTurnModelOverride(params.replyOptions),
  });
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
  // The stable mode's tool-only downgrade must be sender-independent, or a
  // sender-scoped message denial hashes a different binding policy than the
  // sender-less synthetic turns on the same session. Only tool-only candidates
  // can downgrade, so skip the second policy pass otherwise.
  const sessionStableMessageToolAvailable =
    effectiveVisibleReplies === "message_tool"
      ? resolveStableMessageToolAvailability({
          cfg,
          ctx,
          sessionEntry: sessionStoreEntry.entry,
          sessionAgentId,
          sessionKey: acpDispatchSessionKey,
        })
      : undefined;
  const sourceReplyPolicyParams = {
    cfg,
    ctx,
    strictMessageToolOnly: ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn,
    sendPolicy,
    suppressAcpChildUserDelivery: state.suppressAcpChildUserDelivery,
    explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
    shouldSuppressTyping: state.shouldSuppressTyping,
    messageToolAvailable,
    sessionStableMessageToolAvailable,
    isHeartbeat: params.replyOptions?.isHeartbeat,
  } as const;
  let sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
    ...sourceReplyPolicyParams,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  const alternateHarnessDefault =
    harnessDefaultVisibleReplies === "message_tool" ? "automatic" : "message_tool";
  const alternateSourceReplyDeliveryMode = resolveSourceReplyVisibilityPolicy({
    ...sourceReplyPolicyParams,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
    defaultVisibleReplies: alternateHarnessDefault,
  }).sourceReplyDeliveryMode;
  const sourceReplyDeliveryModeOrigin =
    alternateSourceReplyDeliveryMode === sourceReplyPolicy.sourceReplyDeliveryMode
      ? "stable_policy"
      : "runtime_default";
  const sourceReplyDeliveryRuntimeOptions: SourceReplyDeliveryRuntimeOptions = {
    sourceReplyDeliveryModeOrigin,
    onSourceReplyDeliveryModeResolved: (mode) => {
      const stableMode = sourceReplyPolicy.sessionStableSourceReplyDeliveryMode;
      sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
        ...sourceReplyPolicyParams,
        requested: mode,
      });
      // A candidate can change live ownership, but not the reusable CLI session prompt.
      sourceReplyPolicy.sessionStableSourceReplyDeliveryMode = stableMode;
      Object.assign(state, sourceReplyPolicy, { sourceReplyPolicy });
    },
  };
  Object.assign(sourceReplyPolicy, sourceReplyDeliveryRuntimeOptions);
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
    sourceReplyPolicy.sourceReplyDeliveryMode === "message_tool_only" ||
    sourceReplyPolicy.sendPolicyDenied
      ? {
          ...result,
          ...(sourceReplyPolicy.sourceReplyDeliveryMode === "message_tool_only"
            ? { sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode }
            : {}),
          ...(sourceReplyPolicy.sendPolicyDenied ? { sendPolicyDenied: true } : {}),
        }
      : result;
  const explicitCommandTurnCtx = isExplicitSourceReplyCommand(ctx, cfg);
  const activeRunSafeCommandTurn =
    explicitCommandTurnCtx &&
    isActiveRunSafeCommandTurn({
      commandTurn: resolveCommandTurnContext(ctx),
      cfg,
      provider: ctx.Provider ?? ctx.Surface,
    });
  const unauthorizedTextSlashSourceReplyCtx =
    (chatType === "group" || chatType === "channel") && isUnauthorizedTextSlashCommand(ctx);
  const noVisibleReplyFallbackDirected = isDirectedSourceReplyTurn(ctx, cfg, chatType === "direct");
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
    void state.releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
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
    const operation = state.getDispatchReplyOperation();
    // Feedback only for pre-run drops: the user never saw output. Finalization or
    // terminal-settle stalls already produced/settled output, so a notice is noise.
    const droppedBeforeOutput =
      operation?.result?.kind === "failed" &&
      operation.result.code === "run_stalled" &&
      (operation.staleExpiryReason === "no_activity" ||
        operation.staleExpiryReason === "stuck_recovery");
    const queuedFinal = droppedBeforeOutput
      ? dispatcher.sendFinalReply({
          text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
          isError: true,
        })
      : false;
    if (state.turnAdoptionState && !state.turnAdoptionState.adopted) {
      releaseInboundDedupeIfClaimed();
    } else {
      commitInboundDedupeIfClaimed();
    }
    recordProcessed("skipped", { reason: "reply_operation_aborted" });
    markIdle("message_completed");
    state.completeDispatchReplyOperation();
    return attachSourceReplyDeliveryMode({
      queuedFinal,
      counts: dispatcher.getQueuedCounts(),
      ...(state.turnLedger.hasVisibleDelivery() ? { observedReplyDelivery: true } : {}),
    });
  };

  const bindingState: {
    pluginFallbackReason?:
      | "plugin-bound-fallback-missing-plugin"
      | "plugin-bound-fallback-no-handler";
  } = {};
  const emitMessageReceivedHooks = () => {
    emitSharedMessageReceivedHooks({
      ctx,
      hookRunner,
      sessionKey,
      timestamp: state.timestamp,
      buildContext: buildMessageReceivedHookContext,
    });
  };
  state.markProcessing();
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
  const nextState = extendPreparedDispatchState(state, {
    sendBindingNotice,
    pluginOwnedBinding,
    persistPluginBindingUserTurn,
    sendPolicy,
    chatType,
    emptyFinalAllowedAsSilent,
    noVisibleReplyFallbackDirected,
    sourceReplyPolicy,
    sourceReplyDeliveryRuntimeOptions,
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
    activeRunSafeCommandTurn,
    shouldDeliverPluginBindingReply,
    inboundDedupeClaim,
    commitInboundDedupeIfClaimed,
    finishReplyOperationBusyDispatch,
    finishReplyOperationAbortedDispatch,
    emitMessageReceivedHooks,
    bindingState,
  });
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchOperationContextResult = Awaited<
  ReturnType<typeof prepareDispatchOperationContext>
>;
export type PrepareDispatchOperationContextReadyState = Extract<
  PrepareDispatchOperationContextResult,
  { status: "ready" }
>["state"];
