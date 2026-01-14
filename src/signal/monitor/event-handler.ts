import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../../agents/identity.js";
import { formatAgentEnvelope } from "../../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
} from "../../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveStorePath, updateLastRoute } from "../../config/sessions.js";
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

import type {
  SignalEventHandlerDeps,
  SignalReceivePayload,
} from "./event-handler.types.js";

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
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

    const dataMessage =
      envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;
    const messageText = (dataMessage?.message ?? "").trim();
    const quoteText = dataMessage?.quote?.text?.trim() ?? "";
    const hasBodyContent =
      Boolean(messageText || quoteText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

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
      const groupLabel = isGroup
        ? `${groupName ?? "Signal Group"} id:${groupId}`
        : undefined;
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
    const storeAllowFrom = await readChannelAllowFromStore("signal").catch(
      () => [],
    );
    const effectiveDmAllow = [...deps.allowFrom, ...storeAllowFrom];
    const effectiveGroupAllow = [...deps.groupAllowFrom, ...storeAllowFrom];
    const dmAllowed =
      deps.dmPolicy === "open"
        ? true
        : isSignalSenderAllowed(sender, effectiveDmAllow);

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
              logVerbose(
                `signal pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            `Blocked signal sender ${senderDisplay} (dmPolicy=${deps.dmPolicy})`,
          );
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
        logVerbose(
          "Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)",
        );
        return;
      }
      if (!isSignalSenderAllowed(sender, effectiveGroupAllow)) {
        logVerbose(
          `Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`,
        );
        return;
      }
    }

    const commandAuthorized = isGroup
      ? effectiveGroupAllow.length > 0
        ? isSignalSenderAllowed(sender, effectiveGroupAllow)
        : true
      : dmAllowed;

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
          mediaType =
            fetched.contentType ?? firstAttachment.contentType ?? undefined;
        }
      } catch (err) {
        deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
      }
    }

    const kind = mediaKindFromMime(mediaType ?? undefined);
    if (kind) placeholder = `<media:${kind}>`;
    else if (dataMessage.attachments?.length)
      placeholder = "<media:attachment>";

    const bodyText =
      messageText || placeholder || dataMessage.quote?.text?.trim() || "";
    if (!bodyText) return;

    const fromLabel = isGroup
      ? `${groupName ?? "Signal Group"} id:${groupId}`
      : `${envelope.sourceName ?? senderDisplay} id:${senderDisplay}`;
    const body = formatAgentEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: envelope.timestamp ?? undefined,
      body: bodyText,
    });
    let combinedBody = body;
    const historyKey = isGroup ? String(groupId ?? "unknown") : undefined;
    if (isGroup && historyKey && deps.historyLimit > 0) {
      combinedBody = buildHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: bodyText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number"
              ? String(envelope.timestamp)
              : undefined,
        },
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          }),
      });
    }

    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? (groupId ?? "unknown") : senderPeerId,
      },
    });
    const signalTo = isGroup ? `group:${groupId}` : `signal:${senderRecipient}`;
    const ctxPayload = {
      Body: combinedBody,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: isGroup
        ? `group:${groupId ?? "unknown"}`
        : `signal:${senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (groupName ?? undefined) : undefined,
      SenderName: envelope.sourceName ?? senderDisplay,
      SenderId: senderDisplay,
      Provider: "signal" as const,
      Surface: "signal" as const,
      MessageSid: envelope.timestamp ? String(envelope.timestamp) : undefined,
      Timestamp: envelope.timestamp ?? undefined,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
    };

    if (!isGroup) {
      const sessionCfg = deps.cfg.session;
      const storePath = resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        channel: "signal",
        to: senderRecipient,
        accountId: route.accountId,
      });
    }

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    let didSendReply = false;
    const dispatcher = createReplyDispatcher({
      responsePrefix: resolveEffectiveMessagesConfig(deps.cfg, route.agentId)
        .responsePrefix,
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
        didSendReply = true;
      },
      onError: (err, info) => {
        deps.runtime.error?.(
          danger(`signal ${info.kind} reply failed: ${String(err)}`),
        );
      },
    });

    const { queuedFinal } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof deps.blockStreaming === "boolean"
            ? !deps.blockStreaming
            : undefined,
      },
    });
    if (!queuedFinal) {
      if (isGroup && historyKey && deps.historyLimit > 0 && didSendReply) {
        clearHistoryEntries({ historyMap: deps.groupHistories, historyKey });
      }
      return;
    }
    if (isGroup && historyKey && deps.historyLimit > 0 && didSendReply) {
      clearHistoryEntries({ historyMap: deps.groupHistories, historyKey });
    }
  };
}
