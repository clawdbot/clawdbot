import type { ChatSendIntent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { shouldForwardModelCommandToServer } from "../../../../src/auto-reply/commands-registry.shared.js";
import { normalizeChatFollowUpModeOverride, setLastActiveSessionKey } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { extractCompanionCommandQuestion } from "../../lib/chat/companion-question.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import {
  dispatchChatSlashCommand,
  requireChatSessionAction,
  shouldQueueLocalSlashCommand,
} from "./chat-commands.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  admitQueuedMessageForSession,
  enqueueChatMessage,
  excludeComposerAttachments,
  removeQueuedMessageWithoutReleasing,
  readQueuedMessageById,
} from "./chat-queue.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { sendChatMessageWithGeneratedRunId } from "./chat-send-actions.ts";
import {
  captureChatCommandComposerRecovery,
  cancelChatDelivery,
  clearOwnedCommandComposerFallback,
  commandComposerFallbackRetainsAttachments,
  restoreFailedCommandComposer,
  submittedCommandConnectionIsCurrent,
  submittedCommandScopeIsVisible,
  type ChatCommandComposerRecovery,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  canSendVolatileQueueItem,
  enqueuePendingSendMessage,
  reconnectSafeQueuedSendState,
  setChatError,
  waitForPendingChatSettings,
} from "./chat-send-queue-state.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import {
  formatTerminalChatSendAckError,
  OFFLINE_QUEUE_STORAGE_ERROR,
} from "./chat-send-support.ts";
import { recordChatSendTiming } from "./chat-send-timing.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";
import { withChatSubmitGuard } from "./chat-submit-guard.ts";
import { resolveStoredChatOutboxScope } from "./composer-persistence.ts";
import {
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import { controlUiNowMs } from "./performance.ts";
import { activeQueuedMessageEdit, retireEditedQueuedMessageSource } from "./queued-message-edit.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  hasDirectSessionRun,
  isChatBusy,
  isChatStopCommand,
} from "./run-lifecycle.ts";

export type ChatSendSubmitOptions = {
  intent?: ChatSendIntent;
  attachmentsOverride?: readonly ChatAttachment[];
  followUpMode?: ControlUiFollowUpMode;
  /** Only the inline queued-row submit may resume and replace an edited row. */
  resumeQueuedMessageEditId?: string;
  restoreDraft?: boolean;
  /** Lets request-scoped UI actions recover from rejected local commands. */
  onLocalCommandSendRejected?: () => void;
};

function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  return (
    parsed?.command.key === "new" ||
    (parsed?.command.key === "reset" && !/^soft(?:\s|$)/i.test(parsed.args))
  );
}

function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

function chatSubmitKey(
  host: ChatHost,
  kind: "detached" | "local" | "message" | "queued-edit" | "goal",
  message: string,
  attachments: ChatAttachment[],
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    attachments.map(attachmentSubmitSignature),
  ]);
}

function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
  preserveBrowserAnnotations = false,
) {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every(
      (attachment, index) =>
        attachmentSubmitSignature(attachment) ===
        attachmentSubmitSignature(submittedAttachments[index]!),
    );
  if (host.chatMessage !== submittedDraft || !attachmentsUnchanged) {
    return {};
  }
  host.chatMessage = "";
  host.chatAttachments = preserveBrowserAnnotations
    ? host.chatAttachments.filter((attachment) => attachment.browserAnnotation)
    : [];
  resetChatInputHistoryNavigation(host);
  return {
    previousAttachments: submittedAttachments,
    previousDraft: submittedDraft,
  };
}

function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return { ...attachment, ...(dataUrl ? { dataUrl } : {}) };
  });
}

async function waitForSubmittedRoute(host: ChatHost, sessionKey: string): Promise<boolean> {
  const pending = getPendingChatPickerPatch(host, sessionKey);
  if (pending && !(await waitForPendingChatSettings(host, sessionKey, pending))) {
    return false;
  }
  return host.sessionKey === sessionKey;
}

async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts: {
    attachments?: ChatAttachment[];
    recovery: ChatCommandComposerRecovery;
    runId?: string;
  },
) {
  const ack = await sendChatMessageWithGeneratedRunId(host, message, opts?.attachments, {
    canApplyError: () => submittedCommandScopeIsVisible(host, opts.recovery),
    runId: opts.runId,
  });
  const sendAck = ack && !("kind" in ack) ? ack : null;
  const ok =
    sendAck?.status === "ok" || sendAck?.status === "started" || sendAck?.status === "in_flight";
  if (!ok && !restoreFailedCommandComposer(host, opts.recovery)) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts.attachments));
  }
  if (
    isTerminalFailureChatSendAck(sendAck) &&
    submittedCommandScopeIsVisible(host, opts.recovery)
  ) {
    setChatError(host, formatTerminalChatSendAckError(sendAck, "detached"));
  }
  if (ok) {
    const submittedScopeIsVisible = submittedCommandScopeIsVisible(host, opts.recovery);
    if (submittedCommandConnectionIsCurrent(host, opts.recovery)) {
      clearOwnedCommandComposerFallback(host, opts.recovery);
    }
    if (submittedScopeIsVisible) {
      setLastActiveSessionKey(host, host.sessionKey);
    }
    if (!commandComposerFallbackRetainsAttachments(host, opts.recovery)) {
      releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts.attachments));
    }
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendSubmitOptions,
  submissionAction?: Event,
) {
  const previousDraft = host.chatMessage;
  const intent = opts?.intent;
  const rawMessage = messageOverride ?? host.chatMessage;
  const userMessage = intent ? rawMessage : rawMessage.trim();
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  let expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
  const attachmentsToSend = snapshotChatAttachments(
    messageOverride == null ? host.chatAttachments : (opts?.attachmentsOverride ?? []),
  );
  const hasAttachments = attachmentsToSend.length > 0;
  if (intent) {
    if (!host.connected || !host.client) {
      setChatError(host, t("chat.goals.offline"));
      return undefined;
    }
    if (isChatBusy(host) || hasDirectSessionRun(host)) {
      setChatError(host, t("chat.goals.busy"));
      return undefined;
    }
    if (attachmentsToSend.some((attachment) => attachment.browserAnnotation)) {
      setChatError(host, t("chat.goals.annotationUnsupported"));
      return undefined;
    }
    if (!userMessage.trim()) {
      return undefined;
    }
  }
  const requestedEditId = opts?.resumeQueuedMessageEditId;
  const inlineEdit = requestedEditId ? activeQueuedMessageEdit(host) : null;
  if (requestedEditId != null && !inlineEdit) {
    return undefined;
  }
  const isInlineEditSubmission = requestedEditId != null && inlineEdit?.id === requestedEditId;
  const submittedInlineEditRevision = isInlineEditSubmission ? inlineEdit.revision : null;
  // Classify the operator's raw row draft before browser annotation context is
  // prepended. Otherwise annotation text can hide /stop, /compact, or a stop
  // alias from the inline-edit command fence.
  const rawParsedCommand = intent ? null : parseSlashCommand(userMessage);
  if (isInlineEditSubmission && (rawParsedCommand || isChatStopCommand(userMessage))) {
    setChatError(
      host,
      "Queued-row edits cannot run commands or stop aliases. Cancel this edit and send the command from the composer.",
    );
    return undefined;
  }

  // Commands own the raw composer text. Annotation context is model input and must not
  // turn a recognized command into an ordinary message.
  const message =
    rawParsedCommand || intent
      ? userMessage
      : composeBrowserAnnotationContext(userMessage, attachmentsToSend);
  // Slash commands may use ordinary files, but annotations belong to the next model prompt.
  const deliveredAttachments = rawParsedCommand
    ? attachmentsToSend.filter((attachment) => !attachment.browserAnnotation)
    : attachmentsToSend;

  if (!message && !hasAttachments) {
    return undefined;
  }

  if (!intent) {
    // Natural stop aliases require a run; explicit /stop is always available.
    if (
      isChatStopCommand(userMessage) &&
      (userMessage.startsWith("/") || hasAbortableSessionRun(host))
    ) {
      if (host.connected && !requireChatSessionAction(host, "abort")) {
        return undefined;
      }
      host.chatRunError = null;
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, userMessage);
      }
      await handleAbortChat(host);
      return undefined;
    }

    host.chatRunError = null;
    const parsed = rawParsedCommand;
    if (/^\/(?:btw|side)(?::|\s|$)/i.test(userMessage)) {
      const question = extractCompanionCommandQuestion(userMessage);
      if (!question) {
        return undefined;
      }
      const submitKey = chatSubmitKey(host, "local", message, []);
      await withChatSubmitGuard(host, submitKey, async () => {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
          if (host.chatMessage === previousDraft) {
            host.chatMessage = "";
            resetChatInputHistoryNavigation(host);
          }
        }
        await host.openSessionCompanion?.(question);
      });
      return undefined;
    }
    const clientPresentation = parsed?.command.clientPresentation;
    const dispatchClientPresentation = host.dispatchClientPresentation;
    if (
      host.connected &&
      parsed?.args === "" &&
      clientPresentation?.when === "no-arguments" &&
      !hasAttachments &&
      host.chatReplyTarget == null &&
      dispatchClientPresentation
    ) {
      const submitKey = chatSubmitKey(host, "local", message, []);
      const presentationResult = await withChatSubmitGuard(host, submitKey, async () => {
        if (host.sessionKey !== submittedSessionKey) {
          return "not-handled" as const;
        }
        let handled = false;
        try {
          handled = await dispatchClientPresentation(clientPresentation.action);
        } catch {
          // Presentation failures retain the established remote command path.
        }
        if (!handled) {
          return "not-handled" as const;
        }
        // The awaited action may outlive its submitted session; never mutate a newly selected one.
        if (host.sessionKey !== submittedSessionKey) {
          return "handled" as const;
        }
        if (messageOverride == null) {
          clearSubmittedComposerState(host, previousDraft, attachmentsToSend);
          recordNonTranscriptInputHistory(host, message);
        }
        return "handled" as const;
      });
      // An in-flight identical submit is already deciding whether to handle or fall through.
      if (presentationResult !== "not-handled") {
        return undefined;
      }
    }
    // /approve bypasses the run whose approval it resolves.
    if (parsed?.command.key === "approve" && isChatBusy(host)) {
      const submitKey = chatSubmitKey(host, "detached", message, attachmentsToSend);
      await withChatSubmitGuard(host, submitKey, async () => {
        if (!(await waitForSubmittedRoute(host, submittedSessionKey))) {
          return;
        }
        const cleared =
          messageOverride == null
            ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend, true)
            : {};
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
        }
        const recoveryScope = resolveStoredChatOutboxScope(host, submittedSessionKey);
        await sendDetachedCommandMessage(host, message, {
          attachments: deliveredAttachments.length ? deliveredAttachments : undefined,
          recovery: captureChatCommandComposerRecovery(
            host,
            recoveryScope,
            cleared.previousDraft === undefined
              ? undefined
              : {
                  draft: cleared.previousDraft,
                  attachments: cleared.previousAttachments ?? [],
                },
          ),
        });
      });
      return undefined;
    }

    const forwardModel =
      parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
    if (parsed?.command.executeLocal && !forwardModel) {
      if (shouldQueueLocalSlashCommand(parsed.command.key)) {
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, async () => {
          if (messageOverride == null) {
            recordNonTranscriptInputHistory(host, userMessage);
            host.chatMessage = "";
            resetChatInputHistoryNavigation(host);
          }
          const queued = enqueueChatMessage(
            host,
            message,
            undefined,
            isChatResetCommand(message),
            {
              args: parsed.args,
              name: parsed.command.key,
            },
            resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser) ??
              undefined,
          );
          if (!queued) {
            return;
          }
          queued.sendState = reconnectSafeQueuedSendState(host);
          if (!admitQueuedMessageForSession(host, host.sessionKey, queued)) {
            removeQueuedMessageWithoutReleasing(host, queued.id);
            if (messageOverride == null) {
              host.chatMessage = previousDraft;
              host.chatAttachments = attachmentsToSend;
            }
            setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            return;
          }
          await deliverChatQueueItem(host, queued, { routingSessionKey: host.sessionKey });
        });
        return undefined;
      }
      const waitsForPicker = parsed.command.key === "redirect";
      const dispatchLocalCommand = async () => {
        if (waitsForPicker && !(await waitForSubmittedRoute(host, submittedSessionKey))) {
          return;
        }
        let prevDraft = messageOverride == null ? previousDraft : undefined;
        let recoveryComposer: { draft: string; attachments: ChatAttachment[] } | undefined;
        const recoveryScope = resolveStoredChatOutboxScope(host, submittedSessionKey);
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
          if (waitsForPicker) {
            const cleared = clearSubmittedComposerState(host, previousDraft, attachmentsToSend);
            prevDraft = cleared.previousDraft;
            if (cleared.previousDraft !== undefined) {
              recoveryComposer = {
                draft: cleared.previousDraft,
                attachments: cleared.previousAttachments ?? [],
              };
            }
          } else {
            recoveryComposer = {
              draft: previousDraft,
              attachments: parsed.command.key === "export-session" ? [] : attachmentsToSend,
            };
            host.chatMessage = "";
            // Export stays put; /new must clear attachments before route handoff.
            if (parsed.command.key !== "export-session") {
              host.chatAttachments = [];
            }
            resetChatInputHistoryNavigation(host);
          }
        }
        const recovery = captureChatCommandComposerRecovery(host, recoveryScope, recoveryComposer);
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          parsed.command.key,
          parsed.args,
          {
            previousDraft: prevDraft,
            restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
            sendResetMessage: (resetMessage, resetOpts) =>
              chatOutboxDrainDependencies.sendResetSlashCommand(host, resetMessage, resetOpts),
          },
        );
        if (dispatchResult === "failed") {
          if (messageOverride != null || submittedCommandScopeIsVisible(host, recovery)) {
            opts?.onLocalCommandSendRejected?.();
          }
        }
        if (dispatchResult === "failed" || dispatchResult === "cancelled") {
          if (!restoreFailedCommandComposer(host, recovery)) {
            releaseChatAttachmentPayloads(
              excludeComposerAttachments(host, recovery.composer?.attachments),
            );
          }
        } else if (dispatchResult === "completed") {
          if (submittedCommandConnectionIsCurrent(host, recovery)) {
            clearOwnedCommandComposerFallback(host, recovery);
          }
          if (!commandComposerFallbackRetainsAttachments(host, recovery)) {
            releaseChatAttachmentPayloads(
              excludeComposerAttachments(host, recovery.composer?.attachments),
            );
          }
        }
      };
      if (waitsForPicker) {
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, dispatchLocalCommand);
      } else {
        await dispatchLocalCommand();
      }
      return undefined;
    }
  }

  const replyTarget = isInlineEditSubmission ? null : host.chatReplyTarget;
  // Persisted ids use replyToId; synthetic replies fall back to a quote.
  const replyToId = isInlineEditSubmission
    ? inlineEdit.replyToId
    : replyTarget?.sourceMessageId?.trim() || undefined;
  const effectiveMessage =
    replyTarget && !replyToId && !intent ? prependReplyQuote(message, replyTarget) : message;

  const refreshSessions = Boolean(intent) || isChatResetCommand(message);
  // A row edit and a composer send may intentionally carry the same payload.
  // Keep their guards independent so submitting one cannot suppress the other.
  const submitKind = requestedEditId ? "queued-edit" : intent ? "goal" : "message";
  const submitKey = chatSubmitKey(host, submitKind, effectiveMessage, attachmentsToSend);
  let accepted = false;
  const submitMessage = async () => {
    if (host.chatLoading) {
      // A terminal event can render before its authoritative leaf arrives.
      // Reuse the in-flight history request before fencing the follow-up send.
      if (!(await loadChatHistory(host))) {
        return;
      }
      expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
    }
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const submittedAgentId = scopedAgentIdForSession(host, submittedSessionKey);
    if (!visibleSessionMatches(host, submittedSessionKey, submittedAgentId)) {
      setChatError(host, t("mcpServers.sessionUnavailable"));
      return;
    }
    if (intent && (isChatBusy(host) || hasDirectSessionRun(host))) {
      setChatError(host, t("chat.goals.busy"));
      return;
    }
    // History can await while the operator cancels or changes the row edit.
    // Never admit a replacement captured from a stale row-local draft.
    const resumedEditCandidate = activeQueuedMessageEdit(host);
    if (
      isInlineEditSubmission &&
      (resumedEditCandidate !== inlineEdit ||
        resumedEditCandidate.revision !== submittedInlineEditRevision)
    ) {
      return;
    }
    const cleared =
      messageOverride == null
        ? clearSubmittedComposerState(
            host,
            previousDraft,
            attachmentsToSend,
            Boolean(rawParsedCommand),
          )
        : {};
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, userMessage);
    }

    const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
    const waitingForSettings = Boolean(pendingSettings);
    const directRunActive = hasDirectSessionRun(host);
    // Only an explicit browser override replaces inherited Gateway policy.
    const followUpMode =
      opts?.followUpMode ??
      host.chatFollowUpMode ??
      normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode);
    const activeRunQueueMode =
      !intent && directRunActive && followUpMode !== "queue" ? followUpMode : undefined;
    // The edited row hands its place to the replacement and is retired by the same
    // store write, so a rejected write leaves the original queued and editable.
    const resumedEdit =
      requestedEditId && resumedEditCandidate?.id === requestedEditId ? resumedEditCandidate : null;
    const queued = enqueuePendingSendMessage(
      host,
      effectiveMessage,
      deliveredAttachments.length ? deliveredAttachments : undefined,
      refreshSessions,
      submittedAtMs,
      waitingForSettings ? "waiting-model" : reconnectSafeQueuedSendState(host),
      replyToId,
      resumedEdit?.orderKey,
      activeRunQueueMode,
      intent,
      expectedLeafEntryId,
    );
    if (!queued) {
      return;
    }
    const admittedDurably = admitQueuedMessageForSession(
      host,
      submittedSessionKey,
      queued,
      resumedEdit
        ? {
            id: resumedEdit.id,
            expected: resumedEdit.source,
          }
        : undefined,
    );
    if (resumedEdit) {
      retireEditedQueuedMessageSource(host, admittedDurably, queued.attachments, resumedEdit);
    }
    const canSendFromMemory =
      !admittedDurably &&
      (!resumedEdit || !resumedEdit.sourceWasDurable) &&
      // A still-open edit means its stored source outlived the rejected write;
      // sending the replacement from memory would strand the original as a duplicate.
      !activeQueuedMessageEdit(host) &&
      !waitingForSettings &&
      canSendVolatileQueueItem(host, queued, submittedSessionKey);
    if (!admittedDurably && !canSendFromMemory) {
      cancelChatDelivery(host, queued, {
        previousDraft: cleared.previousDraft,
        previousAttachments: cleared.previousAttachments,
      });
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
    const sendResult = await deliverChatQueueItem(host, queued, {
      previousDraft: cleared.previousDraft,
      previousAttachments: cleared.previousAttachments,
      ...(intent || (directRunActive && followUpMode !== "queue")
        ? { allowActiveRunSend: true }
        : {}),
      ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
      ...(pendingSettings ? { pendingSettings } : {}),
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      restoreOnTerminalFailure: Boolean(rawParsedCommand || intent),
      routingSessionKey: submittedSessionKey,
      storageMode: canSendFromMemory ? "memory" : "durable",
    });
    const pending = readQueuedMessageById(host, queued.id);
    accepted = sendResult !== "failed";
    const pendingBusySend =
      sendResult === "pending" &&
      pending?.sendState === "waiting-idle" &&
      host.sessionKey === submittedSessionKey &&
      visibleSessionMatches(host, submittedSessionKey, pending.agentId) &&
      (isChatBusy(host) || hasDirectSessionRun(host));
    if (pendingBusySend) {
      recordChatSendTiming(host, pending, "queued-busy", submittedAtMs);
    }
    if (
      (sendResult !== "failed" || pending?.sendState === "failed") &&
      replyTarget &&
      host.chatReplyTarget?.messageId === replyTarget.messageId &&
      host.sessionKey === submittedSessionKey
    ) {
      // The reconnect queue owns the quote; later offline turns must not reuse it.
      host.chatReplyTarget = null;
    }
  };
  await withChatSubmitGuard(host, submitKey, submitMessage, submissionAction);
  return accepted;
}

function prependReplyQuote(
  message: string,
  replyTarget: NonNullable<ChatHost["chatReplyTarget"]>,
): string {
  const label = escapeMarkdownInline(replyTarget.senderLabel ?? "User");
  const text = replyTarget.text.trim();
  if (!text.includes("\n")) {
    return `> **${label}:** ${text}\n\n${message}`;
  }
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}:**\n${quoted}\n\n${message}`;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}
