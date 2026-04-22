import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  createChannelInboundDebouncer,
  formatInboundEnvelope,
  formatInboundFromLabel,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
  resolveEnvelopeFormatOptions,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  DM_GROUP_ACCESS_REASON,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeE164, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
  type SignalSender,
} from "../identity.js";
import { normalizeSignalMessagingTarget } from "../normalize.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalReactionMessage,
  SignalReceivePayload,
} from "./event-handler.types.js";
import { resolveSignalQuoteContext } from "./inbound-context.js";
import { renderSignalMentions } from "./mentions.js";

function formatAttachmentKindCount(kind: string, count: number): string {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}

function formatAttachmentSummaryPlaceholder(contentTypes: Array<string | undefined>): string {
  const kindCounts = new Map<string, number>();
  for (const contentType of contentTypes) {
    const kind = kindFromMime(contentType) ?? "attachment";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(([kind, count]) =>
    formatAttachmentKindCount(kind, count),
  );
  return `[${parts.join(" + ")} attached]`;
}

function resolveSignalInboundRoute(params: {
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: SignalEventHandlerDeps["accountId"];
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
    },
  });
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    commandBody: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
    wasMentioned?: boolean;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup: entry.isGroup,
      groupId: entry.groupId,
      senderPeerId: entry.senderPeerId,
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? (entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
            sender: historyEntry.sender,
            body: historyEntry.body,
            timestamp: historyEntry.timestamp,
          }))
        : undefined;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: entry.bodyText,
      InboundHistory: inboundHistory,
      RawBody: entry.bodyText,
      CommandBody: entry.commandBody,
      BodyForCommands: entry.commandBody,
      From: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: "signal" as const,
      Surface: "signal" as const,
      MessageSid: entry.messageId,
      ReplyToBody: entry.replyToBody,
      ReplyToSender: entry.replyToSender,
      ReplyToIsQuote: entry.replyToIsQuote,
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaUrls: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
    });

    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup
        ? {
            sessionKey: route.mainSessionKey,
            channel: "signal",
            to: entry.senderRecipient,
            accountId: route.accountId,
            mainDmOwnerPin: (() => {
              const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
                dmScope: deps.cfg.session?.dmScope,
                allowFrom: deps.allowFrom,
                normalizeEntry: normalizeSignalAllowRecipient,
              });
              if (!pinnedOwner) {
                return undefined;
              }
              return {
                ownerRecipient: pinnedOwner,
                senderRecipient: entry.senderRecipient,
                onSkip: ({ ownerRecipient, senderRecipient }) => {
                  logVerbose(
                    `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                  );
                },
              };
            })(),
          }
        : undefined,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: "signal",
      accountId: route.accountId,
      typing: {
        start: async () => {
          if (!ctxPayload.To) {
            return;
          }
          await sendTypingSignal(ctxPayload.To, {
            cfg: deps.cfg,
            baseUrl: deps.baseUrl,
            account: deps.account,
            accountId: deps.accountId,
          });
        },
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "signal",
            target: ctxPayload.To ?? undefined,
            error: err,
          });
        },
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload) => {
        await deps.deliverReplies({
          cfg: deps.cfg,
          replies: [payload],
          target: ctxPayload.To,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
          runtime: deps.runtime,
          maxBytes: deps.mediaMaxBytes,
          textLimit: deps.textLimit,
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
        onModelSelected,
      },
    });
    markDispatchIdle();
    if (!queuedFinal) {
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: deps.groupHistories,
          historyKey,
          limit: deps.historyLimit,
        });
      }
      return;
    }
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
      });
    }
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: "signal",
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      return shouldDebounceTextInbound({
        text: entry.bodyText,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType || entry.mediaPaths?.length),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
        mediaPaths: undefined,
        mediaTypes: undefined,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    resolveAccessDecision: (isGroup: boolean) => {
      decision: "allow" | "block" | "pairing";
      reason: string;
    };
  }): boolean {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove) {
      return true; // Ignore reaction removals
    }
    const emojiLabel = normalizeOptionalString(params.reaction.emoji) ?? "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? undefined;
    const groupName = params.reaction.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const reactionAccess = params.resolveAccessDecision(isGroup);
    if (reactionAccess.decision !== "allow") {
      logVerbose(
        `Blocked signal reaction sender ${params.senderDisplay} (${reactionAccess.reason})`,
      );
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist,
    });
    if (!shouldNotify) {
      return true;
    }

    const senderPeerId = resolveSignalPeerId(params.sender);
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      messageId,
      targetLabel: targets[0]?.display,
      groupLabel,
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      "signal",
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? "",
    ]
      .filter(Boolean)
      .join(":");
    enqueueSystemEvent(text, { sessionKey: route.sessionKey, contextKey });
    return true;
  }

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null = null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }

    // Check for syncMessage (e.g., sentTranscript from other devices)
    // We need to check if it's from our own account to prevent self-reply loops
    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }

    // Check if the message is from our own account to prevent loop/self-reply
    // This handles both phone number and UUID based identification
    const normalizedAccount = deps.account ? normalizeE164(deps.account) : undefined;
    const isOwnMessage =
      (sender.kind === "phone" && normalizedAccount != null && sender.e164 === normalizedAccount) ||
      (sender.kind === "uuid" && deps.accountUuid != null && sender.raw === deps.accountUuid);
    if (isOwnMessage) {
      return;
    }

    // Filter all sync messages (sentTranscript, readReceipts, etc.).
    // signal-cli may set syncMessage to null instead of omitting it, so
    // check property existence rather than truthiness to avoid replaying
    // the bot's own sent messages on daemon restart.
    if ("syncMessage" in envelope) {
      return;
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();
    const groupId = dataMessage?.groupInfo?.groupId ?? undefined;
    const isGroup = Boolean(groupId);

    const senderDisplay = formatSignalSenderDisplay(sender);
    const { resolveAccessDecision, dmAccess, effectiveDmAllow, effectiveGroupAllow } =
      await resolveSignalAccessState({
        accountId: deps.accountId,
        dmPolicy: deps.dmPolicy,
        groupPolicy: deps.groupPolicy,
        allowFrom: deps.allowFrom,
        groupAllowFrom: deps.groupAllowFrom,
        sender,
      });
    const quoteText = normalizeOptionalString(dataMessage?.quote?.text) ?? "";
    const { contextVisibilityMode, quoteSenderAllowed, visibleQuoteText, visibleQuoteSender } =
      resolveSignalQuoteContext({
        cfg: deps.cfg,
        accountId: deps.accountId,
        isGroup,
        dataMessage,
        effectiveGroupAllow,
      });
    if (quoteText && !visibleQuoteText && isGroup) {
      logVerbose(
        `signal: drop quote context (mode=${contextVisibilityMode}, sender_allowed=${quoteSenderAllowed ? "yes" : "no"})`,
      );
    }
    const hasBodyContent =
      Boolean(messageText || visibleQuoteText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

    if (
      reaction &&
      handleReactionOnlyInbound({
        envelope,
        sender,
        senderDisplay,
        reaction,
        hasBodyContent,
        resolveAccessDecision,
      })
    ) {
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;

    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        dmPolicy: deps.dmPolicy,
        dmAccessDecision: dmAccess.decision,
        senderId: senderAllowId,
        senderIdLine,
        senderDisplay,
        senderName: envelope.sourceName ?? undefined,
        accountId: deps.accountId,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`signal:${senderRecipient}`, text, {
            cfg: deps.cfg,
            baseUrl: deps.baseUrl,
            account: deps.account,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId,
          });
        },
        log: logVerbose,
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      const groupAccess = resolveAccessDecision(true);
      if (groupAccess.decision !== "allow") {
        if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const commandDmAllow = isGroup ? deps.allowFrom : effectiveDmAllow;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, commandDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });
    const commandAuthorized = commandGate.commandAuthorized;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        wasMentioned,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized,
      },
    });
    const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const attachmentTypes = (dataMessage.attachments ?? []).map((attachment) =>
          typeof attachment?.contentType === "string" ? attachment.contentType : undefined,
        );
        if (attachmentTypes.length > 1) {
          return formatAttachmentSummaryPlaceholder(attachmentTypes);
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = kindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || visibleQuoteText;
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: pendingBodyText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        },
      });
      const signalGroupPolicy = resolveChannelGroupPolicy({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
      if (
        (signalGroupPolicy.groupConfig?.ingest ?? signalGroupPolicy.defaultConfig?.ingest) === true
      ) {
        const canonicalGroupTarget =
          normalizeSignalMessagingTarget(`group:${groupId}`) ?? `group:${groupId}`;
        fireAndForgetHook(
          triggerInternalHook(
            createInternalHookEvent(
              "message",
              "received",
              route.sessionKey,
              toInternalMessageReceivedContext({
                from: `group:${groupId}`,
                to: canonicalGroupTarget,
                content: pendingBodyText,
                timestamp: envelope.timestamp ?? undefined,
                channelId: "signal",
                accountId: deps.accountId,
                conversationId: canonicalGroupTarget,
                messageId:
                  typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
                senderId: senderDisplay,
                senderName: envelope.sourceName ?? undefined,
                provider: "signal",
                surface: "signal",
                originatingChannel: "signal",
                originatingTo: canonicalGroupTarget,
                isGroup: true,
                groupId: canonicalGroupTarget,
              }),
            ),
          ),
          "signal: mention-skip message hook failed",
        );
      }
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let placeholder = "";
    const attachments = dataMessage.attachments ?? [];
    if (!deps.ignoreAttachments) {
      for (const attachment of attachments) {
        if (!attachment?.id) {
          continue;
        }
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            mediaTypes.push(
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream",
            );
            if (!mediaPath) {
              mediaPath = fetched.path;
              mediaType = fetched.contentType ?? attachment.contentType ?? undefined;
            }
          }
        } catch (err) {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
    }

    if (mediaPaths.length > 1) {
      placeholder = formatAttachmentSummaryPlaceholder(mediaTypes);
    } else {
      const kind = kindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (attachments.length) {
        placeholder = "<media:attachment>";
      }
    }

    const bodyText = messageText || placeholder || visibleQuoteText || "";
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          cfg: deps.cfg,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
    const messageId =
      typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined;
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText,
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      mediaPath,
      mediaType,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
      replyToBody: visibleQuoteText || undefined,
      replyToSender: visibleQuoteSender,
      replyToIsQuote: visibleQuoteText ? true : undefined,
    });
  };
}
