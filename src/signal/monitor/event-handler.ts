import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveIdentityName,
} from "../../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { formatInboundEnvelope, formatInboundFromLabel } from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { normalizeE164 } from "../../utils.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../identity.js";
import { sendMessageSignal } from "../send.js";

import type { SignalEventHandlerDeps, SignalReceivePayload } from "./event-handler.types.js";

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "signal" });

  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    commandAuthorized: boolean;
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
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey && deps.historyLimit > 0) {
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
          }),
      });
    }

    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: entry.isGroup ? "group" : "dm",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId,
      },
    });
    const signalTo = entry.isGroup ? `group:${entry.groupId}` : `signal:${entry.senderRecipient}`;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      RawBody: entry.bodyText,
      CommandBody: entry.bodyText,
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
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
    });

    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    void recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    }).catch((err) => {
      logVerbose(`signal: failed updating session meta: ${String(err)}`);
    });

    if (!entry.isGroup) {
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "signal",
          to: entry.senderRecipient,
          accountId: route.accountId,
        },
        ctx: ctxPayload,
      });
    }

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    // Create mutable context for response prefix template interpolation
    let prefixContext: ResponsePrefixContext = {
      identityName: resolveIdentityName(deps.cfg, route.agentId),
    };

    const dispatcher = createReplyDispatcher({
      responsePrefix: resolveEffectiveMessagesConfig(deps.cfg, route.agentId).responsePrefix,
      responsePrefixContextProvider: () => prefixContext,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      deliver: async (payload) => {
        await deps.deliverReplies({
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

    const { queuedFinal } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
        onModelSelected: (ctx) => {
          // Mutate the object directly instead of reassigning to ensure the closure sees updates
          prefixContext.provider = ctx.provider;
          prefixContext.model = extractShortModelName(ctx.model);
          prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
          prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
        },
      },
    });
    if (!queuedFinal) {
      if (entry.isGroup && historyKey && deps.historyLimit > 0) {
        clearHistoryEntries({ historyMap: deps.groupHistories, historyKey });
      }
      return;
    }
    if (entry.isGroup && historyKey && deps.historyLimit > 0) {
      clearHistoryEntries({ historyMap: deps.groupHistories, historyKey });
    }
  }

  const inboundDebouncer = createInboundDebouncer<SignalInboundEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) return null;
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.bodyText.trim()) return false;
      if (entry.mediaPath || entry.mediaType) return false;
      return !hasControlCommand(entry.bodyText, deps.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) return;
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) return;

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
    if (!envelope) return;
    if (envelope.syncMessage) return;

    const sender = resolveSignalSender(envelope);
    if (!sender) return;
    if (deps.account && sender.kind === "phone") {
      if (sender.e164 === normalizeE164(deps.account)) return;
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;
    const messageText = (dataMessage?.message ?? "").trim();
    const quoteText = dataMessage?.quote?.text?.trim() ?? "";
    const hasBodyContent =
      Boolean(messageText || quoteText) || Boolean(!reaction && dataMessage?.attachments?.length);

    if (reaction && !hasBodyContent) {
      if (reaction.isRemove) return; // Ignore reaction removals
      const emojiLabel = reaction.emoji?.trim() || "emoji";
      const senderDisplay = formatSignalSenderDisplay(sender);
      const senderName = envelope.sourceName ?? senderDisplay;
      logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
      const targets = deps.resolveSignalReactionTargets(reaction);
      const shouldNotify = deps.shouldEmitSignalReactionNotification({
        mode: deps.reactionMode,
        account: deps.account,
        targets,
        sender,
        allowlist: deps.reactionAllowlist,
      });
      if (!shouldNotify) return;

      const groupId = reaction.groupInfo?.groupId ?? undefined;
      const groupName = reaction.groupInfo?.groupName ?? undefined;
      const isGroup = Boolean(groupId);
      const senderPeerId = resolveSignalPeerId(sender);
      const route = resolveAgentRoute({
        cfg: deps.cfg,
        channel: "signal",
        accountId: deps.accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup ? (groupId ?? "unknown") : senderPeerId,
        },
      });
      const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
      const messageId = reaction.targetSentTimestamp
        ? String(reaction.targetSentTimestamp)
        : "unknown";
      const text = deps.buildSignalReactionSystemEventText({
        emojiLabel,
        actorLabel: senderName,
        messageId,
        targetLabel: targets[0]?.display,
        groupLabel,
      });
      const senderId = formatSignalSenderId(sender);
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
      return;
    }
    if (!dataMessage) return;

    const senderDisplay = formatSignalSenderDisplay(sender);
    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) return;
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupId = dataMessage.groupInfo?.groupId ?? undefined;
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const storeAllowFrom = await readChannelAllowFromStore("signal").catch(() => []);
    const effectiveDmAllow = [...deps.allowFrom, ...storeAllowFrom];
    const effectiveGroupAllow = [...deps.groupAllowFrom, ...storeAllowFrom];
    const dmAllowed =
      deps.dmPolicy === "open" ? true : isSignalSenderAllowed(sender, effectiveDmAllow);

    if (!isGroup) {
      if (deps.dmPolicy === "disabled") return;
      if (!dmAllowed) {
        if (deps.dmPolicy === "pairing") {
          const senderId = senderAllowId;
          const { code, created } = await upsertChannelPairingRequest({
            channel: "signal",
            id: senderId,
            meta: { name: envelope.sourceName ?? undefined },
          });
          if (created) {
            logVerbose(`signal pairing request sender=${senderId}`);
            try {
              await sendMessageSignal(
                `signal:${senderRecipient}`,
                buildPairingReply({
                  channel: "signal",
                  idLine: senderIdLine,
                  code,
                }),
                {
                  baseUrl: deps.baseUrl,
                  account: deps.account,
                  maxBytes: deps.mediaMaxBytes,
                  accountId: deps.accountId,
                },
              );
            } catch (err) {
              logVerbose(`signal pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(`Blocked signal sender ${senderDisplay} (dmPolicy=${deps.dmPolicy})`);
        }
        return;
      }
    }
    if (isGroup && deps.groupPolicy === "disabled") {
      logVerbose("Blocked signal group message (groupPolicy: disabled)");
      return;
    }
    if (isGroup && deps.groupPolicy === "allowlist") {
      if (effectiveGroupAllow.length === 0) {
        logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        return;
      }
      if (!isSignalSenderAllowed(sender, effectiveGroupAllow)) {
        logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, effectiveDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const commandAuthorized = isGroup
      ? resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: effectiveDmAllow.length > 0, allowed: ownerAllowedForCommands },
            { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
          ],
        })
      : dmAllowed;
    if (isGroup && hasControlCommand(messageText, deps.cfg) && !commandAuthorized) {
      logVerbose(`signal: drop control command from unauthorized sender ${senderDisplay}`);
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let placeholder = "";
    const firstAttachment = dataMessage.attachments?.[0];
    if (firstAttachment?.id && !deps.ignoreAttachments) {
      try {
        const fetched = await deps.fetchAttachment({
          baseUrl: deps.baseUrl,
          account: deps.account,
          attachment: firstAttachment,
          sender: senderRecipient,
          groupId,
          maxBytes: deps.mediaMaxBytes,
        });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? firstAttachment.contentType ?? undefined;
        }
      } catch (err) {
        deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
      }
    }

    const kind = mediaKindFromMime(mediaType ?? undefined);
    if (kind) placeholder = `<media:${kind}>`;
    else if (dataMessage.attachments?.length) placeholder = "<media:attachment>";

    const bodyText = messageText || placeholder || dataMessage.quote?.text?.trim() || "";
    if (!bodyText) return;

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
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      mediaPath,
      mediaType,
      commandAuthorized,
    });
  };
}
