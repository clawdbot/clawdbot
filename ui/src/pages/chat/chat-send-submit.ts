import { shouldForwardModelCommandToServer } from "../../../../src/auto-reply/commands-registry.shared.js";
import { normalizeChatFollowUpModeOverride, setLastActiveSessionKey } from "../../app/settings.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { extractSideQuestionDisplayText } from "../../lib/chat/side-question.ts";
import { retirePendingChatSideQuestion } from "../../lib/chat/side-result.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { dispatchChatSlashCommand, shouldQueueLocalSlashCommand } from "./chat-commands.ts";
import type { ChatState } from "./chat-history.ts";
import { scheduleStoredChatOutboxDrain } from "./chat-outbox-drain.ts";
import {
  admitQueuedMessageForSession,
  enqueueChatMessage,
  excludeComposerAttachments,
  removeQueuedMessageWithoutReleasing,
  updateQueuedMessage,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { sendChatMessageWithGeneratedRunId, steerSendDependencies } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  canSendVolatileQueueItem,
  enqueuePendingSendMessage,
  reconnectSafeQueuedSendState,
  setChatError,
  waitForPendingChatSettings,
} from "./chat-send-queue-state.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import { recordChatSendTiming } from "./chat-send-timing.ts";
import {
  cancelPendingSendBeforeRequest,
  chatOutboxDrainDependencies,
  pendingComposerRestorePlan,
  sendChatMessageNow,
  withChatSubmitGuard,
} from "./chat-send.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";
import { INTERRUPTED_SETTINGS_WAIT_ERROR, listStoredChatOutboxes } from "./composer-persistence.ts";
import {
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import { controlUiNowMs } from "./performance.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  isChatBusy,
  isChatStopCommand,
} from "./run-lifecycle.ts";
import {
  formatTerminalChatSendAckError,
  OFFLINE_QUEUE_STORAGE_ERROR,
  sendQueuedChatMessageWithQueueMode as sendQueuedChatMessageWithQueueModeLifecycle,
} from "./steer-lifecycle.ts";

type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
  /** Side-chat follow-ups embed prior-turn context in the /btw command; the
   * pending turn must display the user's typed question instead. */
  sideQuestionDisplayText?: string;
  /** Lets the side-chat panel restore its typed follow-up when the detached
   * send is not accepted (the panel input is not a managed draft). */
  onSideQuestionSendRejected?: () => void;
  /** Lets request-scoped UI actions recover when their local slash command
   * fails before the Gateway accepts it. */
  onLocalCommandSendRejected?: () => void;
};

function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  if (!parsed || (parsed.command.key !== "new" && parsed.command.key !== "reset")) {
    return false;
  }
  if (parsed.command.key === "new") {
    return true;
  }
  if (/^soft(?:\s|$)/.test(normalizeLowercaseStringOrEmpty(parsed.args))) {
    return false;
  }
  return true;
}

function isBtwCommand(text: string) {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
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
  kind: "detached" | "local" | "message",
  message: string,
  attachments: ChatAttachment[],
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    skillWorkshopRevision?.proposalId ?? "",
    skillWorkshopRevision?.agentId ?? "",
    attachments.map(attachmentSubmitSignature),
  ]);
}

function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
): {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
} {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every((attachment, index) => {
      const submitted = submittedAttachments[index];
      return (
        submitted !== undefined &&
        attachmentSubmitSignature(attachment) === attachmentSubmitSignature(submitted)
      );
    });
  const clearedDraft = host.chatMessage === submittedDraft && attachmentsUnchanged;
  const clearedAttachments = clearedDraft;
  if (clearedDraft) {
    host.chatMessage = "";
  }
  if (clearedAttachments) {
    host.chatAttachments = [];
  }
  if (clearedDraft || clearedAttachments) {
    resetChatInputHistoryNavigation(host);
  }
  return {
    previousAttachments: clearedAttachments ? submittedAttachments : undefined,
    previousDraft: clearedDraft ? submittedDraft : undefined,
  };
}

function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return {
      ...attachment,
      ...(dataUrl ? { dataUrl } : {}),
    };
  });
}

async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    runId?: string;
  },
) {
  const ack = await sendChatMessageWithGeneratedRunId(
    host as unknown as ChatState,
    message,
    opts?.attachments,
    { runId: opts?.runId },
  );
  const ok = ack?.status === "ok" || ack?.status === "started" || ack?.status === "in_flight";
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (isTerminalFailureChatSendAck(ack)) {
    setChatError(host, formatTerminalChatSendAckError(ack, "detached"));
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts?.attachments));
  }
  return ack;
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const expectedLeafEntryId = resolveDisplayedLeafEntryId(host as unknown as ChatState);
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? snapshotChatAttachments(attachments) : [];
  const hasAttachments = attachmentsToSend.length > 0;
  const skillWorkshopRevision = opts?.skillWorkshopRevision;
  const shouldInterpretChatCommands = !skillWorkshopRevision;

  if (!message && !hasAttachments) {
    return;
  }

  if (
    messageOverride != null &&
    opts?.confirmReset &&
    isChatResetCommand(message) &&
    (typeof globalThis.confirm !== "function" ||
      !globalThis.confirm("Start a new thread? This will reset the current chat."))
  ) {
    return;
  }

  host.chatRunError = null;

  if (shouldInterpretChatCommands) {
    // Natural words such as "wait" and "exit" are stop aliases only while a
    // run exists. Keep the explicit /stop command available at any time.
    const shouldAbort =
      isChatStopCommand(message) &&
      (message.trim().startsWith("/") || hasAbortableSessionRun(host));
    if (shouldAbort) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      await handleAbortChat(host);
      return;
    }

    const parsed = parseSlashCommand(message);
    // The backend resolves /approve before active-run admission. Send it now so
    // the approval command cannot queue behind the run that is waiting for it.
    const shouldSendDetachedCommand =
      isBtwCommand(message) || (parsed?.command.key === "approve" && isChatBusy(host));
    if (shouldSendDetachedCommand) {
      const submitKey = chatSubmitKey(host, "detached", message, attachmentsToSend);
      // Covers every non-accepted path — early exits, guard dedupe, and
      // rejected acks — so the side-chat panel can restore its typed
      // follow-up even when no request was sent.
      let detachedSendAccepted = false;
      await withChatSubmitGuard(host, submitKey, async () => {
        const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
        if (
          pendingSettings &&
          !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
        ) {
          return;
        }
        if (host.sessionKey !== submittedSessionKey) {
          return;
        }
        const cleared =
          messageOverride == null
            ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
            : {};
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
        }
        // BTW runs detached and delivers via chat.side_result only; show a
        // pending turn immediately so the send has visible feedback. The run
        // id is generated upfront so the turn is correlatable before the ack
        // returns.
        const btwPending = isBtwCommand(message)
          ? {
              question: opts?.sideQuestionDisplayText ?? extractSideQuestionDisplayText(message),
              ts: Date.now(),
              runId: generateUUID(),
            }
          : null;
        if (btwPending) {
          // The superseded run loses its pending record; retire it so its
          // late side_result/terminal events cannot reach the panel or the
          // transcript. Completed turns stay: the panel is a conversation.
          retirePendingChatSideQuestion(host);
          host.chatSideResultPending = btwPending;
          host.chatSideChatHidden = false;
          host.requestUpdate?.();
        }
        const ack = await sendDetachedCommandMessage(host, message, {
          previousDraft: cleared.previousDraft,
          attachments: hasAttachments ? attachmentsToSend : undefined,
          previousAttachments: cleared.previousAttachments,
          runId: btwPending?.runId,
        });
        detachedSendAccepted =
          ack?.status === "ok" || ack?.status === "started" || ack?.status === "in_flight";
        // Touch only this send's card: a side_result (or a newer question)
        // may already have replaced it while the ack was in flight.
        if (btwPending && host.chatSideResultPending === btwPending && !detachedSendAccepted) {
          host.chatSideResultPending = null;
          host.requestUpdate?.();
        }
      });
      if (!detachedSendAccepted) {
        opts?.onSideQuestionSendRejected?.();
      }
      return;
    }

    // Intercept local slash commands (/status, /model, /compact, etc.)
    const forwardModelCommand =
      parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
    if (parsed?.command.executeLocal && !forwardModelCommand) {
      const shouldQueueCommand = shouldQueueLocalSlashCommand(parsed.command.key);
      if (shouldQueueCommand) {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
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
          resolveCurrentUserIdentity(host.hello, host.client?.instanceId) ?? undefined,
        );
        if (queued) {
          queued.sendState = reconnectSafeQueuedSendState(host);
        }
        if (!queued) {
          return;
        }
        if (!admitQueuedMessageForSession(host, host.sessionKey, queued)) {
          removeQueuedMessageWithoutReleasing(host, queued.id);
          if (messageOverride == null) {
            host.chatMessage = previousDraft;
            host.chatAttachments = attachmentsToSend;
          }
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        if (host.connected && host.client && !isChatBusy(host)) {
          const outbox = listStoredChatOutboxes(host).find((candidate) =>
            candidate.queue.some((entry) => entry.id === queued.id),
          );
          if (outbox) {
            await scheduleStoredChatOutboxDrain(
              host,
              outbox,
              chatOutboxDrainDependencies,
              queued.id,
              {
                routingSessionKey: host.sessionKey,
              },
            );
          }
        }
        return;
      }
      const waitsForPicker = parsed.command.key === "redirect";
      const dispatchLocalCommand = async () => {
        if (waitsForPicker) {
          const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
          if (
            pendingSettings &&
            !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
          ) {
            return;
          }
          if (host.sessionKey !== submittedSessionKey) {
            return;
          }
        }
        let prevDraft = messageOverride == null ? previousDraft : undefined;
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
          if (waitsForPicker) {
            prevDraft = clearSubmittedComposerState(
              host,
              previousDraft,
              attachmentsToSend,
            ).previousDraft;
          } else {
            host.chatMessage = "";
            host.chatAttachments = [];
            resetChatInputHistoryNavigation(host);
          }
        }
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
          opts?.onLocalCommandSendRejected?.();
        }
        if (
          (dispatchResult === "failed" || dispatchResult === "cancelled") &&
          messageOverride == null
        ) {
          const restorePlan = pendingComposerRestorePlan(host, {
            previousAttachments: attachmentsToSend,
            previousDraft,
          });
          if (restorePlan.willRestoreDraft) {
            host.chatMessage = previousDraft;
          }
          if (restorePlan.willRestoreAttachments) {
            host.chatAttachments = attachmentsToSend;
          }
        }
      };
      if (waitsForPicker) {
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, dispatchLocalCommand);
      } else {
        await dispatchLocalCommand();
      }
      return;
    }
  }

  const replyTarget = host.chatReplyTarget;
  // Persisted transcript ids ride chat.send as replyToId so the Gateway can
  // hydrate reply context like Discord; synthetic ids fall back to a quote.
  const replyToId = replyTarget?.sourceMessageId?.trim() || undefined;
  const effectiveMessage =
    replyTarget && !replyToId ? prependReplyQuote(message, replyTarget) : message;

  const refreshSessions = shouldInterpretChatCommands && isChatResetCommand(message);
  const submitKey = chatSubmitKey(
    host,
    "message",
    effectiveMessage,
    attachmentsToSend,
    skillWorkshopRevision,
  );
  await withChatSubmitGuard(host, submitKey, async () => {
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const cleared =
      messageOverride == null
        ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
        : {};
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }

    const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
    const waitingForSettings = pendingSettings !== undefined;
    const initialSendState: ChatQueueItem["sendState"] = waitingForSettings
      ? "waiting-model"
      : reconnectSafeQueuedSendState(host);
    const queued = enqueuePendingSendMessage(
      host,
      effectiveMessage,
      hasAttachments ? attachmentsToSend : undefined,
      refreshSessions,
      submittedAtMs,
      initialSendState,
      skillWorkshopRevision,
      replyToId,
    );
    if (!queued) {
      return;
    }
    const admittedDurably = admitQueuedMessageForSession(host, submittedSessionKey, queued);
    const canSendFromMemory =
      !admittedDurably &&
      !waitingForSettings &&
      canSendVolatileQueueItem(host, queued, submittedSessionKey);
    if (!admittedDurably && !canSendFromMemory) {
      cancelPendingSendBeforeRequest(host, queued, {
        previousDraft: cleared.previousDraft,
        previousAttachments: cleared.previousAttachments,
      });
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }

    if (
      pendingSettings &&
      !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
    ) {
      const canRestoreComposer =
        cleared.previousDraft !== undefined &&
        !host.chatMessage.trim() &&
        host.chatAttachments.length === 0;
      const submittedScopeVisible =
        host.sessionKey === submittedSessionKey &&
        visibleSessionMatches(host, submittedSessionKey, queued.agentId);
      if (canRestoreComposer && submittedScopeVisible) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: cleared.previousDraft,
          previousAttachments: cleared.previousAttachments,
        });
      } else {
        updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
          ...item,
          sendError: INTERRUPTED_SETTINGS_WAIT_ERROR,
          sendState: "failed",
        }));
      }
      return;
    }
    if (waitingForSettings) {
      const ready = updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: reconnectSafeQueuedSendState(host),
      }));
      if (!ready) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
    }
    if (
      host.sessionKey !== submittedSessionKey ||
      !visibleSessionMatches(host, submittedSessionKey, queued.agentId)
    ) {
      const parked = updateQueuedMessageForSession(
        host,
        submittedSessionKey,
        queued.id,
        (item) => ({
          ...item,
          sendError: undefined,
          sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
        }),
      );
      if (!parked) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      const outbox = listStoredChatOutboxes(host).find((candidate) =>
        candidate.queue.some((item) => item.id === queued.id),
      );
      if (outbox) {
        await scheduleStoredChatOutboxDrain(host, outbox, chatOutboxDrainDependencies);
      }
      return;
    }

    let sendResult: "sent" | "pending" | "failed";
    if (isChatBusy(host) || hasAbortableSessionRun(host)) {
      const pending = updateQueuedMessage(host, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
      }));
      if (!pending) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        sendResult = "failed";
      } else {
        recordChatSendTiming(host, pending, "queued-busy", submittedAtMs);
        sendResult = "pending";
        // Inherited policy belongs to the Gateway: preserve steer, followup,
        // collect, and interrupt semantics. Browser-local queueing only applies
        // to an explicit browser override.
        const followUpMode =
          host.chatFollowUpMode ??
          normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode);
        if (
          !skillWorkshopRevision &&
          followUpMode !== "queue" &&
          host.connected &&
          hasAbortableSessionRun(host)
        ) {
          void sendQueuedChatMessageWithQueueModeLifecycle(
            host,
            pending.id,
            followUpMode,
            steerSendDependencies,
          );
        }
      }
    } else {
      sendResult = await sendChatMessageNow(host, effectiveMessage, {
        queueItemId: queued.id,
        previousDraft: cleared.previousDraft,
        restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
        attachments: hasAttachments ? attachmentsToSend : undefined,
        previousAttachments: cleared.previousAttachments,
        ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
        restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
        refreshSessions,
        routingSessionKey: submittedSessionKey,
        storageMode: canSendFromMemory ? "memory" : "durable",
        submittedAtMs,
      });
    }
    if (
      sendResult !== "failed" &&
      replyTarget &&
      host.chatReplyTarget?.messageId === replyTarget.messageId &&
      host.sessionKey === submittedSessionKey
    ) {
      // A reconnect queue owns the quoted turn before the Gateway ACK. Consume
      // its reply target so later offline turns cannot reuse stale context.
      host.chatReplyTarget = null;
    }
  });
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
