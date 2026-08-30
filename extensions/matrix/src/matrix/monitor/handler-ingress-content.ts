import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import { buildInboundHistoryFromEntries } from "openclaw/plugin-sdk/reply-history";
import { isMatrixMediaSizeLimitError } from "../media-errors.js";
import { isLikelyBareFilename } from "../media-text.js";
import { fetchMatrixPollSnapshot, type MatrixPollSnapshot } from "../poll-summary.js";
import { resolveMatrixMonitorCommandAccess } from "./access-state.js";
import {
  isMatrixAudioMediaEnabled,
  resolveMatrixInboundBodyText,
  resolveMatrixInboundMediaContent,
  resolveMatrixMentionPrecheckText,
  resolveMatrixPendingHistoryText,
} from "./handler-helpers.js";
import type {
  MatrixIngressAccessParams,
  MatrixIngressAccessResult,
} from "./handler-ingress-access.js";
import { loadAcpBindingRuntime, loadSessionBindingRuntime } from "./handler-runtime.js";
import type { MatrixHandlerRuntimeConfig } from "./handler-types.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions, stripMatrixMentionPrefix } from "./mentions.js";
import {
  isMatrixAudioContent,
  resolveMatrixPreflightAudioTranscript,
  sendMatrixPreflightAudioTranscriptEcho,
} from "./preflight-audio.js";
import { createRoomHistoryTracker, type HistoryEntry } from "./room-history.js";
import { resolveMatrixInboundRoute } from "./route.js";
import { logInboundDrop } from "./runtime-api.js";
import { resolveMatrixTurnTakingConfig } from "./turn-taking-coordinator.js";
import type { MatrixRawEvent } from "./types.js";

export async function resolveMatrixIngressContent(config: {
  handler: MatrixHandlerRuntimeConfig;
  params: MatrixIngressAccessParams;
  access: MatrixIngressAccessResult;
  roomId: string;
  event: MatrixRawEvent;
  eventType: string;
  isPollEvent: boolean;
  eventTs?: number;
  senderId: string;
  roomHistoryTracker: ReturnType<typeof createRoomHistoryTracker>;
  commitInboundEventIfClaimed: () => Promise<void>;
  turnTakingTransportSupported?: boolean;
}) {
  const {
    handler,
    params: paramsLocal,
    access,
    roomId,
    event,
    eventType,
    isPollEvent,
    eventTs,
    senderId,
    roomHistoryTracker,
    commitInboundEventIfClaimed,
  } = config;
  const {
    client,
    core,
    cfg,
    accountId,
    accountConfig,
    logger,
    logVerboseMessage,
    historyLimit,
    mediaMaxBytes,
    dmSessionScope,
    getMemberDisplayName,
  } = handler;

  const {
    content: accessContent,
    messageId,
    audioPreflightMode,
    isDirectMessage,
    isRoom,
    locationPayload,
    reservedHistorySlot,
    threadRootId,
    thread,
    historyThreadId,
    discardReservedHistorySlot,
    markReservedHistorySlotConsumed,
    commitInboundEventIfClaimedAndDiscardReserved,
    roomConfig,
    turnTakingDisabled,
    trustedEnhancedFinal,
    allowBotsMode,
    isConfiguredBotSender,
    selfUserId,
    botLoopProtection,
    roomMatchMeta,
    getSenderName,
    accessState,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
  } = access;
  const { messageIngress, resolveMessageIngress } = accessState;
  let content = accessContent;
  let pollSnapshotPromise: Promise<MatrixPollSnapshot | null> | null = null;
  const getPollSnapshot = async (): Promise<MatrixPollSnapshot | null> => {
    if (!isPollEvent) {
      return null;
    }
    pollSnapshotPromise ??= fetchMatrixPollSnapshot(client, roomId, event).catch((err: unknown) => {
      logVerboseMessage(
        `matrix: failed resolving poll snapshot room=${roomId} id=${event.event_id ?? "unknown"}: ${String(err)}`,
      );
      return null;
    });
    return await pollSnapshotPromise;
  };

  const mentionPrecheckText = resolveMatrixMentionPrecheckText({
    eventType,
    content,
    locationText: locationPayload?.text,
  });
  let mediaContent = resolveMatrixInboundMediaContent(content);
  const mediaUrl = mediaContent.url;
  const pendingHistoryText = resolveMatrixPendingHistoryText({
    mentionPrecheckText,
    content,
    mediaUrl,
  });
  const pendingHistoryPollText =
    !pendingHistoryText && isPollEvent && historyLimit > 0 ? (await getPollSnapshot())?.text : "";
  if (!mentionPrecheckText && !mediaUrl && !isPollEvent) {
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }

  let preflightMedia: {
    path: string;
    contentType?: string;
    placeholder: string;
  } | null = null;
  let preflightMediaDownloadFailed = false;
  let preflightMediaSizeLimitExceeded = false;
  let preflightAudioTranscript: string | undefined;

  const {
    route: _route,
    configuredBinding: _configuredBinding,
    runtimeBindingId: _runtimeBindingId,
  } = resolveMatrixInboundRoute({
    cfg,
    accountId,
    roomId,
    senderId,
    isDirectMessage,
    dmSessionScope,
    threadId: thread.threadId,
    eventTs: eventTs ?? undefined,
    resolveAgentRoute: core.channel.routing.resolveAgentRoute,
  });
  const hasExplicitSessionBinding = _configuredBinding !== null || _runtimeBindingId !== null;
  const preflightAudioMediaUrl = mediaUrl?.startsWith("mxc://") ? mediaUrl : undefined;
  const shouldRunMatrixAudioPreflight =
    isMatrixAudioContent({
      msgtype: typeof content.msgtype === "string" ? content.msgtype : undefined,
      mimetype: mediaContent.contentType,
    }) &&
    isMatrixAudioMediaEnabled(cfg) &&
    preflightAudioMediaUrl !== undefined;
  if (
    shouldRunMatrixAudioPreflight &&
    audioPreflightMode === "defer" &&
    isRoom &&
    historyLimit > 0 &&
    !reservedHistorySlot
  ) {
    const reserved = roomHistoryTracker.reservePending(
      _route.agentId,
      roomId,
      {
        sender: senderId,
        body: pendingHistoryText,
        timestamp: eventTs ?? undefined,
        messageId,
      },
      historyThreadId,
    );
    return {
      deferredPrefix: {
        ...paramsLocal,
        audioPreflightMode: "run" as const,
        reservedHistorySlot: reserved,
      },
    } as const;
  }
  if (shouldRunMatrixAudioPreflight) {
    try {
      preflightMedia = await downloadMatrixMedia({
        client,
        mxcUrl: preflightAudioMediaUrl,
        contentType: mediaContent.contentType,
        sizeBytes: mediaContent.sizeBytes,
        maxBytes: mediaMaxBytes,
        file: mediaContent.file,
        originalFilename: mediaContent.originalFilename,
      });
    } catch (err) {
      preflightMediaDownloadFailed = true;
      if (isMatrixMediaSizeLimitError(err)) {
        preflightMediaSizeLimitExceeded = true;
      }
      const errorText = formatErrorMessage(err);
      logVerboseMessage(
        `matrix: media download failed room=${roomId} id=${event.event_id ?? "unknown"} type=${content.msgtype} error=${errorText}`,
      );
      logger.warn("matrix media download failed", {
        roomId,
        eventId: event.event_id,
        msgtype: content.msgtype,
        encrypted: Boolean(mediaContent.file),
        error: errorText,
      });
    }
    if (preflightMedia) {
      preflightAudioTranscript = await resolveMatrixPreflightAudioTranscript({
        mediaPath: preflightMedia.path,
        mediaContentType: preflightMedia.contentType,
        cfg,
        accountId,
        chatType: isDirectMessage ? "direct" : "channel",
        originatingTo: `room:${roomId}`,
        messageThreadId: thread.threadId,
        sessionKey: _route.sessionKey,
      });
    }
  }
  const agentMentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, _route.agentId, {
    provider: "matrix",
    conversationId: roomId,
    providerPolicy: accountConfig?.mentionPatterns,
  });
  const selfDisplayName = content.formatted_body
    ? await getMemberDisplayName(roomId, selfUserId).catch(() => undefined)
    : undefined;
  const mentionPrecheckTextWithTranscript = preflightAudioTranscript
    ? [mentionPrecheckText, preflightAudioTranscript].filter(Boolean).join("\n").trim()
    : mentionPrecheckText;
  const { wasMentioned, hasExplicitMention } = resolveMentions({
    content,
    userId: selfUserId,
    displayName: selfDisplayName,
    text: mentionPrecheckTextWithTranscript,
    mentionRegexes: agentMentionRegexes,
  });
  if (
    isConfiguredBotSender &&
    allowBotsMode === "mentions" &&
    !isDirectMessage &&
    !wasMentioned &&
    !trustedEnhancedFinal
  ) {
    logVerboseMessage(
      `matrix: drop configured bot sender=${senderId} (allowBots=mentions, missing mention, ${roomMatchMeta})`,
    );
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "matrix",
  });
  const useAccessGroups = true;
  // Keep mention stripping on the command-only path so history and agent
  // prompt text continue to see the original Matrix message.
  const commandCheckText = stripMatrixMentionPrefix({
    text: mentionPrecheckText,
    userId: selfUserId,
    displayName: selfDisplayName,
    mentionRegexes: agentMentionRegexes,
  });
  // Authenticated sibling finals are conversation data, never a control plane.
  // A sibling answer beginning with `/...` must not execute or be rejected as a command.
  const hasControlCommandInMessage = trustedEnhancedFinal
    ? false
    : core.channel.text.hasControlCommand(commandCheckText, cfg);
  const commandAccess = await resolveMatrixMonitorCommandAccess(accessState, {
    useAccessGroups,
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandAccess.authorized;
  if (isRoom && commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: logVerboseMessage,
      channel: "matrix",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  const configuredRequireMention = isRoom
    ? roomConfig?.autoReply === true
      ? false
      : roomConfig?.autoReply === false
        ? true
        : typeof roomConfig?.requireMention === "boolean"
          ? roomConfig?.requireMention
          : true
    : false;
  const pendingHistoryBody = preflightAudioTranscript
    ? formatAudioTranscriptForAgent(preflightAudioTranscript)
    : pendingHistoryText || pendingHistoryPollText;
  const recordSkippedRoomMessage = async (reason: string) => {
    if (historyLimit > 0 && pendingHistoryBody) {
      const pendingEntry: HistoryEntry = {
        sender: senderId,
        body: pendingHistoryBody,
        timestamp: eventTs ?? undefined,
        messageId,
      };
      if (reservedHistorySlot) {
        roomHistoryTracker.finalizePending(
          roomId,
          reservedHistorySlot,
          pendingEntry,
          historyThreadId,
        );
        markReservedHistorySlotConsumed();
      } else {
        roomHistoryTracker.recordPending(roomId, pendingEntry, historyThreadId);
      }
    }
    logger.info("skipping room message", { roomId, reason });
    await commitInboundEventIfClaimed();
  };

  const turnTakingConfig = resolveMatrixTurnTakingConfig(handler.turnTaking);
  let enhancedTurnTakingEligible = false;
  let turnTakingBaselineSequence: number | undefined;
  let turnTakingInitialActivePreviewResponseIds: string[] | undefined;
  if (
    turnTakingConfig.enabled &&
    config.turnTakingTransportSupported !== false &&
    !turnTakingDisabled &&
    handler.turnTakingCoordinator
  ) {
    const participationBody =
      mentionPrecheckTextWithTranscript ||
      pendingHistoryText ||
      (isPollEvent ? ((await getPollSnapshot())?.text ?? "") : "");
    if (hasControlCommandInMessage) {
      const eligibility = await handler.turnTakingCoordinator.resolveEligibility({
        cfg,
        roomId,
        accountId,
        senderId,
        threadId: threadRootId,
        eventTs,
        eventId: messageId,
        trustedEnhancedFinal,
      });
      enhancedTurnTakingEligible = eligibility.eligible;
      if (eligibility.eligible) {
        turnTakingBaselineSequence = handler.turnTakingCoordinator.observeMessage({
          roomId,
          eventId: messageId,
          senderId,
          body: participationBody,
          timestamp: eventTs,
          threadId: threadRootId,
        });
      }
    } else {
      const participation = await handler.turnTakingCoordinator.decideParticipation({
        cfg,
        roomId,
        eventId: messageId,
        senderId,
        body: participationBody,
        trustedEnhancedFinal,
        accountId,
        threadId: threadRootId,
        eventTs,
      });
      enhancedTurnTakingEligible = participation.eligible;
      if (participation.eligible) {
        turnTakingBaselineSequence = participation.baselineSequence;
        turnTakingInitialActivePreviewResponseIds = participation.initialActivePreviewResponseIds;
        logVerboseMessage(
          `matrix: shared turn-taking room=${roomId} event=${messageId} account=${accountId} disposition=${participation.disposition} owner=${participation.ownerAccountId ?? "unknown"}`,
        );
        if (participation.disposition === "strongly-silent") {
          await recordSkippedRoomMessage("turn-taking-strongly-silent");
          return undefined;
        }
      }
    }
  }
  const shouldRequireMention = enhancedTurnTakingEligible ? false : configuredRequireMention;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      // Matrix native mention metadata lets us reliably decide absence even
      // when no custom mention regex is configured.
      canDetectMention: true,
      wasMentioned,
      hasAnyMention: hasExplicitMention,
    },
    policy: {
      isGroup: isRoom,
      requireMention: shouldRequireMention,
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const { effectiveWasMentioned, shouldBypassMention } = mentionDecision;
  const canDetectMention = agentMentionRegexes.length > 0 || hasExplicitMention;
  if (mentionDecision.shouldSkip) {
    await recordSkippedRoomMessage("no-mention");
    return undefined;
  }
  if (preflightAudioTranscript) {
    await sendMatrixPreflightAudioTranscriptEcho({
      transcript: preflightAudioTranscript,
      cfg,
      accountId,
      originatingTo: `room:${roomId}`,
      messageThreadId: thread.threadId,
    });
  }

  if (isPollEvent) {
    const pollSnapshot = await getPollSnapshot();
    if (!pollSnapshot) {
      discardReservedHistorySlot();
      return undefined;
    }
    content = {
      msgtype: "m.text",
      body: pollSnapshot.text,
    };
    mediaContent = resolveMatrixInboundMediaContent(content);
  }

  let media: {
    path: string;
    contentType?: string;
    placeholder: string;
  } | null = preflightMedia;
  let mediaDownloadFailed = preflightMediaDownloadFailed;
  let mediaSizeLimitExceeded = preflightMediaSizeLimitExceeded;
  const finalMediaUrl = mediaContent.url;
  if (!media && !mediaDownloadFailed && finalMediaUrl?.startsWith("mxc://")) {
    try {
      media = await downloadMatrixMedia({
        client,
        mxcUrl: finalMediaUrl,
        contentType: mediaContent.contentType,
        sizeBytes: mediaContent.sizeBytes,
        maxBytes: mediaMaxBytes,
        file: mediaContent.file,
        originalFilename: mediaContent.originalFilename,
      });
    } catch (err) {
      mediaDownloadFailed = true;
      if (isMatrixMediaSizeLimitError(err)) {
        mediaSizeLimitExceeded = true;
      }
      const errorText = formatErrorMessage(err);
      logVerboseMessage(
        `matrix: media download failed room=${roomId} id=${event.event_id ?? "unknown"} type=${content.msgtype} error=${errorText}`,
      );
      logger.warn("matrix media download failed", {
        roomId,
        eventId: event.event_id,
        msgtype: content.msgtype,
        encrypted: Boolean(mediaContent.file),
        error: errorText,
      });
    }
  }

  const rawBody = locationPayload?.text ?? mediaContent.body;
  let bodyText = resolveMatrixInboundBodyText({
    rawBody,
    filename: typeof content.filename === "string" ? content.filename : undefined,
    mediaPlaceholder: media?.placeholder,
    msgtype: content.msgtype,
    hadMediaUrl: Boolean(finalMediaUrl),
    mediaDownloadFailed,
    mediaSizeLimitExceeded,
  });
  if (
    preflightMedia &&
    bodyText &&
    bodyText !== preflightMedia.placeholder &&
    isLikelyBareFilename(bodyText)
  ) {
    // Matrix voice clients commonly set body to the attachment filename.
    bodyText = preflightMedia.placeholder;
  }
  if (preflightAudioTranscript) {
    const transcriptBody = formatAudioTranscriptForAgent(preflightAudioTranscript);
    bodyText =
      !bodyText || bodyText === media?.placeholder
        ? transcriptBody
        : `${bodyText}\n${transcriptBody}`;
  }
  if (!bodyText) {
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  const commandBodyText = hasControlCommandInMessage ? commandCheckText : bodyText;
  const senderName = await getSenderName();
  if (_configuredBinding) {
    const { ensureConfiguredAcpBindingReady } = await loadAcpBindingRuntime();
    const ensured = await ensureConfiguredAcpBindingReady({
      cfg,
      configuredBinding: _configuredBinding,
    });
    if (!ensured.ok) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "matrix",
        reason: "configured ACP binding unavailable",
        target: _configuredBinding.spec.conversationId,
      });
      discardReservedHistorySlot();
      return undefined;
    }
  }
  if (_runtimeBindingId) {
    const { getSessionBindingService } = await loadSessionBindingRuntime();
    getSessionBindingService().touch(_runtimeBindingId, eventTs ?? undefined);
  }
  const preparedTrigger =
    isRoom && historyLimit > 0
      ? reservedHistorySlot
        ? roomHistoryTracker.prepareReservedTrigger(
            _route.agentId,
            roomId,
            historyLimit,
            reservedHistorySlot,
            {
              sender: senderName,
              body: bodyText,
              timestamp: eventTs ?? undefined,
              messageId,
            },
            historyThreadId,
          )
        : roomHistoryTracker.prepareTrigger(
            _route.agentId,
            roomId,
            historyLimit,
            {
              sender: senderName,
              body: bodyText,
              timestamp: eventTs ?? undefined,
              messageId,
            },
            historyThreadId,
          )
      : undefined;
  if (reservedHistorySlot && preparedTrigger) {
    markReservedHistorySlotConsumed();
  }
  const inboundHistory = preparedTrigger
    ? buildInboundHistoryFromEntries({
        entries: preparedTrigger.history,
        limit: historyLimit,
      })
    : undefined;
  const triggerSnapshot = preparedTrigger;

  return {
    messageIngress,
    resolveMessageIngress,
    route: _route,
    hasExplicitSessionBinding,
    roomConfig,
    isDirectMessage,
    isRoom,
    shouldRequireMention,
    wasMentioned,
    effectiveWasMentioned,
    shouldBypassMention,
    canDetectMention,
    commandAuthorized,
    inboundHistory,
    senderName,
    bodyText,
    commandBodyText,
    media,
    preflightAudioTranscript,
    locationPayload,
    messageId,
    triggerSnapshot,
    threadRootId,
    thread,
    botLoopProtection,
    enhancedTurnTakingEligible,
    turnTakingBaselineSequence,
    turnTakingInitialActivePreviewResponseIds,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
    selfUserId,
  };
}
