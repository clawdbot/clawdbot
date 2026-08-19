import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
} from "../../agents/agent-scope.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  shouldAdmitFreshChannelOwnerCronAuthority,
} from "../../agents/cron-creator-authority-context.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { resolveOwnerPromptNumbers } from "../../agents/owner-display.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import { MEDIA_ONLY_USER_TEXT } from "../../sessions/user-turn-media.js";
import {
  createUserTurnTranscriptRecorder,
  resolvePersistedUserTurnText,
} from "../../sessions/user-turn-transcript.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import type { OriginatingChannelType } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { PreparedReplyRunAdmission } from "./get-reply-run-admission.js";
import {
  buildPersistedMediaImageLayout,
  normalizeMessageTimestampMs,
  suppressUnresolvedPromptMedia,
  updateRoomEventAmbientTranscriptWatermark,
} from "./get-reply-run-helpers.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { normalizeToolProgressDetail } from "./prompt-session-context.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import {
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  setChannelSourceTurnId,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";

export async function executePreparedReplyRun(state: PreparedReplyRunAdmission) {
  const {
    context,
    resolvedThinkLevel,
    thinkingCatalog,
    skillsSnapshot,
    prefixedCommandBody,
    queuedBody,
    transcriptBody,
    transcriptCommandBody,
    promptMedia,
    currentInboundContext,
    isRoomEvent,
    providedReplyOperation,
    preparedSessionState,
    resolvedQueue,
    embeddedAgentRuntime,
    resolveActiveEmbeddedSessionId,
    resolvePreparedSessionState,
    runReplyAgent,
    queueKey,
    shouldSteer,
    shouldFollowup,
    queueAdmissionState,
    isActive,
    authProfileId,
    authProfileIdSource,
  } = state;
  const {
    params,
    runtimePolicySessionKey,
    isHeartbeat,
    traceRunPhase,
    promptSessionCtx,
    inboundEventKind,
    sourceReplyDeliveryMode,
    silentReplyPromptMode,
    useFastReplyRuntime,
    fullAccessState,
    extraSystemPromptParts,
    sourceConversationContextByMode,
    sourceConversationContextPromptOffset,
    extraSystemPromptStatic,
    cliSessionBindingFacts,
    baseBodyTrimmedRaw,
    effectiveResetTriggered,
    isBareSessionReset,
    workspaceDir,
    hasUserBody,
    shouldInjectGroupIntro,
    typingMode,
    allowEmptyAssistantReplyAsSilent,
  } = context;
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    command,
    provider,
    model,
    requestedRouteResolution,
    typing,
    opts,
    defaultModel,
    timeoutMs,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionStore,
    sessionKey,
    storePath,
  } = params;
  const {
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    elevatedEnabled,
    elevatedAllowed,
  } = params;

  const runHasStoredSessionModelOverride = Boolean(
    normalizeOptionalString(preparedSessionState.sessionEntry?.modelOverride) ||
    normalizeOptionalString(preparedSessionState.sessionEntry?.providerOverride),
  );
  const runHasLegacyAutoFallbackWithoutOrigin =
    runHasStoredSessionModelOverride &&
    hasLegacyAutoFallbackWithoutOrigin(preparedSessionState.sessionEntry);
  const runHasSessionModelOverride =
    runHasStoredSessionModelOverride && !runHasLegacyAutoFallbackWithoutOrigin;
  const runModelOverrideSource = runHasSessionModelOverride
    ? preparedSessionState.sessionEntry?.modelOverrideSource
    : undefined;
  const runHasAutoFallbackProvenance =
    runHasSessionModelOverride &&
    hasSessionAutoModelFallbackProvenance(preparedSessionState.sessionEntry);
  const originatingThreadId = resolveRoutedDeliveryThreadId({ ctx, sessionKey });
  const currentTurnImages = await traceRunPhase("reply.resolve_current_turn_images", () =>
    resolveCurrentTurnImages({
      ctx,
      cfg,
      images: opts?.images,
      imageOrder: opts?.imageOrder,
      extractedFileImages: opts?.extractedFileImages,
    }),
  );
  // Abort-signal attachment for queued followups:
  // - room_event: always inherit (source admission fence / ambient cancel).
  // - Gateway-owned lifecycle (chat.send / turnAdoptionLifecycle): always inherit
  //   so Esc can cancel a turn after chat.send terminalizes while still queued.
  // - plain user_request without lifecycle: deliberately detach from the
  //   source/active-lane signal so a superseded parent abort does not cancel a
  //   still-valid queued user turn.
  const hasQueuedOwnershipLifecycle = Boolean(opts?.turnAdoptionLifecycle);
  const queuedFollowupAbortSignal =
    hasQueuedOwnershipLifecycle || inboundEventKind === "room_event"
      ? (opts?.queuedFollowupAbortSignal ??
        opts?.turnAdoptionLifecycle?.abortSignal ??
        opts?.abortSignal)
      : undefined;
  const replyRoute = resolveEffectiveReplyRoute({
    ctx: {
      Provider: ctx.Provider ?? sessionCtx.Provider,
      Surface: ctx.Surface ?? sessionCtx.Surface,
      OriginatingChannel: ctx.OriginatingChannel ?? sessionCtx.OriginatingChannel,
      OriginatingTo: ctx.OriginatingTo ?? sessionCtx.OriginatingTo,
      AccountId: ctx.AccountId ?? sessionCtx.AccountId,
      InputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance,
      ChatType: ctx.ChatType ?? sessionCtx.ChatType,
    },
    entry: preparedSessionState.sessionEntry,
  });
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: replyRoute.channel,
    // Prefer Provider over Surface for fallback channel identity.
    // Surface can carry relayed metadata while Provider owns reply routing.
    provider: ctx.Provider ?? ctx.Surface ?? promptSessionCtx.Provider,
  });
  const sourceMessageId =
    normalizeOptionalString(sessionCtx.MessageSidFull) ??
    normalizeOptionalString(sessionCtx.MessageSid);
  const sourceTurnId =
    readChannelSourceTurnId(sessionCtx) ??
    (shouldMintChannelSourceTurnId(ctx.Provider ?? ctx.Surface ?? promptSessionCtx.Provider)
      ? buildChannelSourceTurnId({
          provider: messageProvider,
          accountId: replyRoute.accountId,
          conversationId: replyRoute.to,
          messageId: sourceMessageId,
        })
      : undefined);
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const persistGroupSender = replyRoute.chatType === "group" || replyRoute.chatType === "channel";
  const ctxMediaForPersistence = normalizeMediaFacts(ctx.media);
  const unresolvedSourceIndexes = new Set(currentTurnImages.unresolvedSourceIndexes ?? []);
  const persistedCtxMedia = ctxMediaForPersistence.map((fact, index) =>
    unresolvedSourceIndexes.has(index) ? { ...fact, hydrationSuppressed: true } : fact,
  );
  const userTurnMediaForPersistence = [...persistedCtxMedia, ...(opts?.media ?? [])];
  const inboundMediaIndexes = buildInboundMediaNoteProjection(ctx).mediaIndexes ?? [];
  const promptMediaForRun = suppressUnresolvedPromptMedia({
    promptMedia: promptMedia ?? [],
    inboundMediaIndexes,
    unresolvedSourceIndexes,
  });
  const mediaImageLayout = buildPersistedMediaImageLayout({
    ctx,
    media: userTurnMediaForPersistence,
    ctxMediaCount: ctxMediaForPersistence.length,
    imageOrder: currentTurnImages.imageOrder,
    imageSourceIndexes: currentTurnImages.imageSourceIndexes,
  });
  const promptMediaSourceIndexes = currentTurnImages.imageSourceIndexes?.map((sourceIndex) => {
    if (sourceIndex === undefined) {
      return undefined;
    }
    const promptIndex = inboundMediaIndexes.indexOf(sourceIndex);
    return promptIndex >= 0 ? promptIndex : undefined;
  });
  const promptMediaImageLayout = buildPersistedMediaImageLayout({
    ctx: {},
    media: promptMediaForRun,
    ctxMediaCount: inboundMediaIndexes.length,
    imageOrder: currentTurnImages.imageOrder,
    imageSourceIndexes: promptMediaSourceIndexes,
  });
  const inputProvenance = ctx.InputProvenance ?? sessionCtx.InputProvenance;
  const userTurnTimestamp = normalizeMessageTimestampMs(ctx.Timestamp);
  // prompt-prelude substitutes MEDIA_ONLY_USER_TEXT as transcriptBody for
  // bodyless turns; storage stays bare (the LLM boundary re-injects it), while
  // room-event lines that merely contain the marker keep their real text.
  const userTurnTranscriptText =
    !hasUserBody && transcriptBody === MEDIA_ONLY_USER_TEXT
      ? ""
      : resolvePersistedUserTurnText(transcriptBody);
  const conversationIdentity = conversationIdentityFromMsgContext({ ctx: sessionCtx });
  const conversationRef = conversationIdentity?.conversationRef;
  const transportMessageId =
    normalizeOptionalString(sessionCtx.MessageSidFull) ??
    normalizeOptionalString(sessionCtx.MessageSid);
  const transportReplyToId =
    normalizeOptionalString(sessionCtx.ReplyToIdFull) ??
    normalizeOptionalString(sessionCtx.ReplyToId);
  const transportThreadId =
    sessionCtx.MessageThreadId === undefined
      ? undefined
      : normalizeOptionalString(String(sessionCtx.MessageThreadId));
  const transportChannel =
    normalizeOptionalString(conversationIdentity?.channel) ??
    normalizeOptionalString(sessionCtx.OriginatingChannel) ??
    normalizeOptionalString(sessionCtx.Provider);
  const transport =
    conversationRef ||
    transportMessageId ||
    transportReplyToId ||
    transportThreadId ||
    transportChannel
      ? {
          ...(transportChannel ? { channel: transportChannel } : {}),
          ...(conversationRef ? { conversationRef } : {}),
          ...(transportMessageId ? { messageId: transportMessageId } : {}),
          ...(transportReplyToId ? { replyToId: transportReplyToId } : {}),
          ...(transportThreadId ? { threadId: transportThreadId } : {}),
        }
      : undefined;
  const userTurnInput =
    userTurnTranscriptText !== undefined || userTurnMediaForPersistence.length > 0
      ? {
          text: userTurnTranscriptText,
          senderIsOwner: command.senderIsOwner,
          ...(sourceTurnId ? { idempotencyKey: sourceTurnId } : {}),
          ...(inputProvenance && !isHeartbeat ? { provenance: inputProvenance } : {}),
          ...(isHeartbeat
            ? { provenance: { kind: "internal_system" as const, sourceTool: "heartbeat" } }
            : {}),
          ...(transport ? { transport } : {}),
          ...(userTurnMediaForPersistence.length > 0 ? { media: userTurnMediaForPersistence } : {}),
          ...(mediaImageLayout ? { mediaImageLayout } : {}),
          // Persist the message's own arrival timestamp so the single
          // LLM-boundary stamping site (normalizeMessagesForLlmBoundary) can
          // derive a stable per-message `[DOW YYYY-MM-DD HH:MM TZ]` prefix that
          // is identical whether this turn is sent as the current turn or
          // replayed as history. See: https://github.com/openclaw/openclaw/issues/3658
          ...(userTurnTimestamp ? { timestamp: userTurnTimestamp } : {}),
          // Direct transcripts keep their existing identity-storage boundary.
          sender: persistGroupSender
            ? {
                id: normalizeOptionalString(sessionCtx.SenderId),
                name: normalizeOptionalString(sessionCtx.SenderName),
                username: normalizeOptionalString(sessionCtx.SenderUsername),
              }
            : undefined,
        }
      : undefined;
  const userTurnTranscriptRecorder =
    opts?.userTurnTranscriptRecorder ??
    (userTurnInput
      ? createUserTurnTranscriptRecorder({
          input: userTurnInput,
          target: () => ({
            sessionId: preparedSessionState.sessionId,
            sessionKey: sessionKey ?? preparedSessionState.sessionId,
            sessionEntry: preparedSessionState.sessionEntry,
            ...(sessionStore ? { sessionStore } : {}),
            ...(storePath ? { storePath } : {}),
            agentId,
            cwd: workspaceDir,
            config: cfg,
          }),
          errorContext: "reply user turn transcript",
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          onMessagePersisted: isRoomEvent
            ? async () =>
                await updateRoomEventAmbientTranscriptWatermark({
                  expectedSessionId: preparedSessionState.sessionId,
                  sessionCtx,
                  storePath,
                  sessionKey: sessionKey ?? preparedSessionState.sessionId,
                })
            : undefined,
        })
      : undefined);
  const replyPolicyChannel =
    (replyRoute.channel as OriginatingChannelType | undefined) ??
    (messageProvider as OriginatingChannelType | undefined);
  const queuedToolsAllow = opts?.toolsAllow ? [...opts.toolsAllow] : opts?.toolsAllow;
  const queuedToolIntersections = opts?.toolsAllow
    ? readToolAllowlistIntersection(opts.toolsAllow)
    : undefined;
  if (queuedToolsAllow && queuedToolIntersections) {
    attachToolAllowlistIntersection(queuedToolsAllow, queuedToolIntersections);
  }
  const followupRun = {
    prompt: queuedBody,
    transcriptPrompt: transcriptCommandBody,
    ...(userTurnTranscriptRecorder ? { userTurnTranscriptRecorder } : {}),
    currentInboundEventKind: inboundEventKind,
    currentInboundAudio: hasInboundAudio(sessionCtx),
    channelAdmissionEvidence:
      readChannelContextAdmissionEvidence(ctx) ?? readChannelContextAdmissionEvidence(sessionCtx),
    currentInboundContext,
    explicitSkillSelections: params.explicitSkillSelections,
    ...(queuedFollowupAbortSignal ? { abortSignal: queuedFollowupAbortSignal } : {}),
    deliveryCorrelations: opts?.queuedDeliveryCorrelations,
    turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
    ...(opts?.onFollowupQueueDisposition
      ? { onQueueDisposition: opts.onFollowupQueueDisposition }
      : {}),
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    ...(queuedToolsAllow !== undefined ? { toolsAllow: queuedToolsAllow } : {}),
    ...(opts?.disableTools !== undefined ? { disableTools: opts.disableTools } : {}),
    enqueuedAt: Date.now(),
    currentTurnImagesPrepared: true as const,
    images: currentTurnImages.images,
    imageOrder: currentTurnImages.imageOrder,
    mediaImageLayout: promptMediaImageLayout,
    media: promptMediaForRun,
    // Originating channel for reply routing.
    originatingChannel: replyRoute.channel,
    originatingTo: replyRoute.to,
    originatingAccountId: replyRoute.accountId,
    originatingThreadId: replyRoute.threadId ?? originatingThreadId,
    originatingReplyToId: promptSessionCtx.ReplyToId,
    originatingReplyToMode:
      promptSessionCtx.ReplyToMode ??
      resolveReplyToMode(cfg, replyPolicyChannel, replyRoute.accountId, replyRoute.chatType),
    originatingChatId:
      normalizeOptionalString(sessionCtx.NativeChannelId) ??
      normalizeOptionalString(sessionCtx.ChatId),
    originatingChatType: replyRoute.chatType,
    run: {
      agentId,
      agentDir,
      sessionId: preparedSessionState.sessionId,
      sessionKey,
      runtimePolicySessionKey,
      messageProvider,
      clientCaps: ctx.GatewayClientCaps,
      toolBindings: ctx.GatewayRunToolBindings,
      chatType: replyRoute.chatType,
      agentAccountId: replyRoute.accountId,
      conversationToolPolicy: sessionCtx.ConversationToolPolicy,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      memberRoleIds: Array.isArray(sessionCtx.MemberRoleIds)
        ? sessionCtx.MemberRoleIds.map((roleId) => normalizeOptionalString(roleId)).filter(
            (roleId): roleId is string => Boolean(roleId),
          )
        : undefined,
      // Parent lineage authenticates inherited group policy for queued CLI/MCP runs.
      spawnedBy: normalizeOptionalString(preparedSessionState.sessionEntry?.spawnedBy),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      channelContext: ctx.ChannelContext ?? sessionCtx.ChannelContext,
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      // Queued system events are prompt content in the same trusted session;
      // they do not rewrite the sender identity used by command/action auth.
      senderIsOwner: command.senderIsOwner,
      traceAuthorized:
        command.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
      approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
      sessionFile: preparedSessionState.sessionFile,
      workspaceDir,
      cwd: normalizeOptionalString(state.sessionEntry?.spawnedCwd),
      permissionMode: preparedSessionState.sessionEntry?.permissionMode,
      sessionRoot: normalizeOptionalString(preparedSessionState.sessionEntry?.sessionRoot),
      config: cfg,
      toolOverrides: preparedSessionState.sessionEntry?.toolOverrides,
      skillsSnapshot,
      provider,
      model,
      requestedRouteResolution,
      modelSelectionLocked: preparedSessionState.sessionEntry?.modelSelectionLocked === true,
      hasSessionModelOverride: runHasSessionModelOverride,
      modelOverrideSource: runModelOverrideSource,
      hasAutoFallbackProvenance: runHasAutoFallbackProvenance || undefined,
      autoFallbackPrimaryProbe: params.autoFallbackPrimaryProbe,
      authProfileId,
      authProfileIdSource,
      thinkingCatalog,
      thinkLevel: resolvedThinkLevel,
      ...(() => {
        if (useFastReplyRuntime) {
          return { fastMode: false, fastModeAutoOnSeconds: undefined, fastModeOverride: true };
        }
        const fastModeState = resolveFastModeState({
          cfg,
          provider,
          model,
          agentId,
          sessionEntry: preparedSessionState.sessionEntry,
        });
        return {
          fastMode: params.resolvedFastMode ?? fastModeState.mode,
          fastModeAutoOnSeconds:
            params.resolvedFastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds,
          ...(params.resolvedFastModeOverride ? { fastModeOverride: true } : {}),
          ...(params.resolvedFastModeAutoOnSecondsOverride
            ? { fastModeAutoOnSecondsOverride: true }
            : {}),
        };
      })(),
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
        fullAccessAvailable: fullAccessState.available,
        ...(fullAccessState.blockedReason
          ? { fullAccessBlockedReason: fullAccessState.blockedReason }
          : {}),
      },
      timeoutMs,
      runTimeoutOverrideMs: opts?.timeoutOverrideSeconds !== undefined ? timeoutMs : undefined,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: resolveOwnerPromptNumbers({
        ownerNumbers: command.ownerList,
        senderId: command.senderId,
        senderIsOwner: command.senderIsOwner,
      }),
      inputProvenance,
      ...(opts?.suppressNextUserMessagePersistence
        ? { suppressNextUserMessagePersistence: true }
        : {}),
      extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
      sourceReplyDeliveryMode,
      taskSuggestionDeliveryMode: opts?.taskSuggestionDeliveryMode,
      silentReplyPromptMode,
      extraSystemPromptStatic,
      cliSessionBindingFacts,
      skipProviderRuntimeHints: useFastReplyRuntime,
      allowEmptyAssistantReplyAsSilent,
      suppressTranscriptOnlyAssistantPersistence: isRoomEvent,
      ...(opts?.skillWorkshopProposalRevision
        ? {
            skillWorkshopProposalRevision: { ...opts.skillWorkshopProposalRevision },
          }
        : {}),
      ...(!useFastReplyRuntime &&
      isReasoningTagProvider(provider, { config: cfg, workspaceDir, modelId: model })
        ? { enforceFinalTag: true }
        : {}),
    },
  };
  const sourceReplyDeliveryRuntimeOptions = opts as SourceReplyDeliveryRuntimeOptions | undefined;
  if (sourceReplyDeliveryRuntimeOptions?.sourceReplyDeliveryModeOrigin) {
    const sourceReplyDeliveryRuntime = createSourceReplyDeliveryRuntime({
      origin: sourceReplyDeliveryRuntimeOptions.sourceReplyDeliveryModeOrigin,
      initialMode: sourceReplyDeliveryMode ?? "automatic",
      projections: [followupRun.run, ...(opts ? [opts] : [])],
      promptComponentByMode: sourceConversationContextByMode,
      promptComponentOffset: sourceConversationContextPromptOffset,
      onModeResolved: sourceReplyDeliveryRuntimeOptions.onSourceReplyDeliveryModeResolved,
    });
    bindSourceReplyDeliveryRuntime(followupRun.run, sourceReplyDeliveryRuntime);
  }
  const replyThreadingOverride =
    isBareSessionReset && sessionCtx.ReplyThreading?.implicitCurrentMessage !== "deny"
      ? { ...sessionCtx.ReplyThreading, implicitCurrentMessage: "deny" as const }
      : undefined;

  const admitFreshChannelOwnerCronAuthority = shouldAdmitFreshChannelOwnerCronAuthority({
    senderIsOwner: command.senderIsOwner,
    messageProvider,
    senderId: sessionCtx.SenderId,
    isHeartbeat,
    isRoomEvent,
    inputProvenance,
    spawnedBy: preparedSessionState.sessionEntry?.spawnedBy,
    suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
  });
  const authorityRunId = admitFreshChannelOwnerCronAuthority
    ? (opts?.runId ?? crypto.randomUUID())
    : undefined;
  const inheritedCronCreatorAuthorityCapability = opts?.cronCreatorAuthorityCapability;
  const createdCronCreatorAuthorityCapability =
    !inheritedCronCreatorAuthorityCapability && authorityRunId && messageProvider
      ? createCronCreatorAuthorityCapability(authorityRunId, {
          kind: "external",
          channel: messageProvider,
        })
      : undefined;
  const cronCreatorAuthorityCapability =
    inheritedCronCreatorAuthorityCapability ?? createdCronCreatorAuthorityCapability;
  const execute = () =>
    runReplyAgent({
      commandBody: prefixedCommandBody,
      transcriptCommandBody,
      followupRun,
      queueKey,
      resolvedQueue,
      shouldSteer,
      shouldFollowup,
      queueAdmissionState,
      isActive,
      isRunActive: () => {
        const latestSessionState = resolvePreparedSessionState();
        const latestActiveSessionId =
          resolveActiveEmbeddedSessionId(latestSessionState.sessionFile) ??
          latestSessionState.sessionId;
        return embeddedAgentRuntime?.isEmbeddedAgentRunActive(latestActiveSessionId) ?? false;
      },
      opts:
        authorityRunId || cronCreatorAuthorityCapability
          ? {
              ...opts,
              ...(authorityRunId ? { runId: authorityRunId } : {}),
              ...(cronCreatorAuthorityCapability ? { cronCreatorAuthorityCapability } : {}),
            }
          : opts,
      typing,
      sessionEntry: preparedSessionState.sessionEntry,
      sessionStore,
      sessionKey,
      runtimePolicySessionKey,
      storePath,
      defaultModel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      toolProgressDetail:
        normalizeToolProgressDetail(agentCfg?.toolProgressDetail) ??
        normalizeToolProgressDetail(cfg.agents?.defaults?.toolProgressDetail),
      isNewSession: params.isNewSession,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      sessionCtx,
      shouldInjectGroupIntro,
      typingMode,
      resetTriggered: effectiveResetTriggered,
      replyThreadingOverride,
      replyOperation: providedReplyOperation,
    });
  // The scope surrounds the whole immediate turn, including provider fallbacks.
  // If runReplyAgent queues this input, the scope settles before later drain/replay.
  return createdCronCreatorAuthorityCapability
    ? runWithCronCreatorAuthorityCapability(
        createdCronCreatorAuthorityCapability,
        execute,
        opts?.abortSignal,
      )
    : execute();
}
