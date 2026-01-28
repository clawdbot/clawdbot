import fs from "node:fs/promises";

import { resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { logInboundDrop } from "../../channels/logging.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { waitForTransportReady } from "../../infra/transport-ready.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { resolveIMessageAccount } from "../accounts.js";
import { createIMessageRpcClient } from "../client.js";
import { probeIMessage } from "../probe.js";
import { sendMessageIMessage } from "../send.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
} from "../targets.js";
import { deliverReplies } from "./deliver.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";

/**
 * Try to detect remote host from an SSH wrapper script like:
 *   exec ssh -T moltbot@192.168.64.3 /opt/homebrew/bin/imsg "$@"
 *   exec ssh -T mac-mini imsg "$@"
 * Returns the user@host or host portion if found, undefined otherwise.
 */
async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    // Expand ~ to home directory
    const expanded = cliPath.startsWith("~")
      ? cliPath.replace(/^~/, process.env.HOME ?? "")
      : cliPath;
    const content = await fs.readFile(expanded, "utf8");

    // Match user@host pattern first (e.g., moltbot@192.168.64.3)
    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) return userHostMatch[1];

    // Fallback: match host-only before imsg command (e.g., ssh -T mac-mini imsg)
    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch {
    return undefined;
  }
}

type IMessageReplyContext = {
  id?: string;
  body: string;
  sender?: string;
};

function normalizeReplyField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") return String(value);
  return undefined;
}

function describeReplyContext(message: IMessagePayload): IMessageReplyContext | null {
  const body = normalizeReplyField(message.reply_to_text);
  if (!body) return null;
  const id = normalizeReplyField(message.reply_to_id);
  const sender = normalizeReplyField(message.reply_to_sender);
  return { body, id, sender };
}

export async function monitorIMessageProvider(opts: MonitorIMessageOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const imessageCfg = accountInfo.config;
  const historyLimit = Math.max(
    0,
    imessageCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
  const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      imessageCfg.groupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []),
  );
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = imessageCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
  const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
  const dbPath = opts.dbPath ?? imessageCfg.dbPath;

  // Resolve remoteHost: explicit config, or auto-detect from SSH wrapper script
  let remoteHost = imessageCfg.remoteHost;
  if (!remoteHost && cliPath && cliPath !== "imsg") {
    remoteHost = await detectRemoteHostFromCliPath(cliPath);
    if (remoteHost) {
      logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
    }
  }

  const inboundDebounceMs = resolveInboundDebounceMs({ cfg, channel: "imessage" });
  const inboundDebouncer = createInboundDebouncer<{ message: IMessagePayload }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const sender = entry.message.sender?.trim();
      if (!sender) return null;
      const conversationId =
        entry.message.chat_id != null
          ? `chat:${entry.message.chat_id}`
          : (entry.message.chat_guid ?? entry.message.chat_identifier ?? "unknown");
      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.message.text?.trim() ?? "";
      if (!text) return false;
      if (entry.message.attachments && entry.message.attachments.length > 0) return false;
      return !hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleMessageNow(last.message);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.message.text ?? "")
        .filter(Boolean)
        .join("\n");
      const syntheticMessage: IMessagePayload = {
        ...last.message,
        text: combinedText,
        attachments: null,
      };
      await handleMessageNow(syntheticMessage);
    },
    onError: (err) => {
      runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
    },
  });

  async function handleMessageNow(message: IMessagePayload) {
    const senderRaw = message.sender ?? "";
    const sender = senderRaw.trim();
    if (!sender) return;
    const senderNormalized = normalizeIMessageHandle(sender);
    if (message.is_from_me) return;

    const chatId = message.chat_id ?? undefined;
    const chatGuid = message.chat_guid ?? undefined;
    const chatIdentifier = message.chat_identifier ?? undefined;

    const groupIdCandidate = chatId !== undefined ? String(chatId) : undefined;
    const groupListPolicy = groupIdCandidate
      ? resolveChannelGroupPolicy({
          cfg,
          channel: "imessage",
          accountId: accountInfo.accountId,
          groupId: groupIdCandidate,
        })
      : {
          allowlistEnabled: false,
          allowed: true,
          groupConfig: undefined,
          defaultConfig: undefined,
        };

    // Some iMessage threads can have multiple participants but still report
    // is_group=false depending on how Messages stores the identifier.
    // If the owner explicitly configures a chat_id under imessage.groups, treat
    // that thread as a "group" for permission gating and session isolation.
    const treatAsGroupByConfig = Boolean(
      groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig,
    );

    const isGroup = Boolean(message.is_group) || treatAsGroupByConfig;
    if (isGroup && !chatId) return;

    const groupId = isGroup ? groupIdCandidate : undefined;
    const storeAllowFrom = await readChannelAllowFromStore("imessage").catch(() => []);
    const effectiveDmAllowFrom = Array.from(new Set([...allowFrom, ...storeAllowFrom]))
      .map((v) => String(v).trim())
      .filter(Boolean);
    const effectiveGroupAllowFrom = Array.from(new Set([...groupAllowFrom, ...storeAllowFrom]))
      .map((v) => String(v).trim())
      .filter(Boolean);

    if (isGroup) {
      if (groupPolicy === "disabled") {
        logVerbose("Blocked iMessage group message (groupPolicy: disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerbose("Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)");
          return;
        }
        const allowed = isAllowedIMessageSender({
          allowFrom: effectiveGroupAllowFrom,
          sender,
          chatId: chatId ?? undefined,
          chatGuid,
          chatIdentifier,
        });
        if (!allowed) {
          logVerbose(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
          return;
        }
      }
      if (groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
        logVerbose(`imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`);
        return;
      }
    }

    const dmHasWildcard = effectiveDmAllowFrom.includes("*");
    const dmAuthorized =
      dmPolicy === "open"
        ? true
        : dmHasWildcard ||
          (effectiveDmAllowFrom.length > 0 &&
            isAllowedIMessageSender({
              allowFrom: effectiveDmAllowFrom,
              sender,
              chatId: chatId ?? undefined,
              chatGuid,
              chatIdentifier,
            }));
    if (!isGroup) {
      if (dmPolicy === "disabled") return;
      if (!dmAuthorized) {
        if (dmPolicy === "pairing") {
          const senderId = normalizeIMessageHandle(sender);
          const { code, created } = await upsertChannelPairingRequest({
            channel: "imessage",
            id: senderId,
            meta: {
              sender: senderId,
              chatId: chatId ? String(chatId) : undefined,
            },
          });
          if (created) {
            logVerbose(`imessage pairing request sender=${senderId}`);
            try {
              await sendMessageIMessage(
                sender,
                buildPairingReply({
                  channel: "imessage",
                  idLine: `Your iMessage sender id: ${senderId}`,
                  code,
                }),
                {
                  client,
                  maxBytes: mediaMaxBytes,
                  accountId: accountInfo.accountId,
                  ...(chatId ? { chatId } : {}),
                },
              );
            } catch (err) {
              logVerbose(`imessage pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(`Blocked iMessage sender ${sender} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    }

    const route = resolveAgentRoute({
      cfg,
      channel: "imessage",
      accountId: accountInfo.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? String(chatId ?? "unknown") : normalizeIMessageHandle(sender),
      },
    });
    const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
    const messageText = (message.text ?? "").trim();
    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    // Filter to valid attachments with paths
    const validAttachments = attachments.filter((entry) => entry?.original_path && !entry?.missing);
    const firstAttachment = validAttachments[0];
    const mediaPath = firstAttachment?.original_path ?? undefined;
    const mediaType = firstAttachment?.mime_type ?? undefined;
    // Build arrays for all attachments (for multi-image support)
    const mediaPaths = validAttachments.map((a) => a.original_path).filter(Boolean) as string[];
    const mediaTypes = validAttachments.map((a) => a.mime_type ?? undefined);
    const kind = mediaKindFromMime(mediaType ?? undefined);
    const placeholder = kind ? `<media:${kind}>` : attachments?.length ? "<media:attachment>" : "";
    const bodyText = messageText || placeholder;
    if (!bodyText) return;
    const replyContext = describeReplyContext(message);
    const createdAt = message.created_at ? Date.parse(message.created_at) : undefined;
    const historyKey = isGroup
      ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
      : undefined;
    const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
    const requireMention = resolveChannelGroupRequireMention({
      cfg,
      channel: "imessage",
      accountId: accountInfo.accountId,
      groupId,
      requireMentionOverride: opts.requireMention,
      overrideOrder: "before-config",
    });
    const canDetectMention = mentionRegexes.length > 0;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands =
      effectiveDmAllowFrom.length > 0
        ? isAllowedIMessageSender({
            allowFrom: effectiveDmAllowFrom,
            sender,
            chatId: chatId ?? undefined,
            chatGuid,
            chatIdentifier,
          })
        : false;
    const groupAllowedForCommands =
      effectiveGroupAllowFrom.length > 0
        ? isAllowedIMessageSender({
            allowFrom: effectiveGroupAllowFrom,
            sender,
            chatId: chatId ?? undefined,
            chatGuid,
            chatIdentifier,
          })
        : false;
    const hasControlCommandInMessage = hasControlCommand(messageText, cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveDmAllowFrom.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });
    const commandAuthorized = isGroup ? commandGate.commandAuthorized : dmAuthorized;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "imessage",
        reason: "control command (unauthorized)",
        target: sender,
      });
      return;
    }
    const shouldBypassMention =
      isGroup && requireMention && !mentioned && commandAuthorized && hasControlCommandInMessage;
    const effectiveWasMentioned = mentioned || shouldBypassMention;
    if (isGroup && requireMention && canDetectMention && !mentioned && !shouldBypassMention) {
      logVerbose(`imessage: skipping group message (no mention)`);
      recordPendingHistoryEntryIfEnabled({
        historyMap: groupHistories,
        historyKey: historyKey ?? "",
        limit: historyLimit,
        entry: historyKey
          ? {
              sender: senderNormalized,
              body: bodyText,
              timestamp: createdAt,
              messageId: message.id ? String(message.id) : undefined,
            }
          : null,
      });
      return;
    }

    const chatTarget = formatIMessageChatTarget(chatId);
    const fromLabel = formatInboundFromLabel({
      isGroup,
      groupLabel: message.chat_name ?? undefined,
      groupId: chatId !== undefined ? String(chatId) : "unknown",
      groupFallback: "Group",
      directLabel: senderNormalized,
      directId: sender,
    });
    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const replySuffix = replyContext
      ? `\n\n[Replying to ${replyContext.sender ?? "unknown sender"}${
          replyContext.id ? ` id:${replyContext.id}` : ""
        }]\n${replyContext.body}\n[/Replying]`
      : "";
    const body = formatInboundEnvelope({
      channel: "iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: `${bodyText}${replySuffix}`,
      chatType: isGroup ? "group" : "direct",
      sender: { name: senderNormalized, id: sender },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    if (isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatInboundEnvelope({
            channel: "iMessage",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }

    const imessageTo = (isGroup ? chatTarget : undefined) || `imessage:${sender}`;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: isGroup ? `imessage:group:${chatId ?? "unknown"}` : `imessage:${sender}`,
      To: imessageTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: isGroup ? (message.chat_name ?? undefined) : undefined,
      GroupMembers: isGroup ? (message.participants ?? []).filter(Boolean).join(", ") : undefined,
      SenderName: senderNormalized,
      SenderId: sender,
      Provider: "imessage",
      Surface: "imessage",
      MessageSid: message.id ? String(message.id) : undefined,
      ReplyToId: replyContext?.id,
      ReplyToBody: replyContext?.body,
      ReplyToSender: replyContext?.sender,
      Timestamp: createdAt,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaRemoteHost: remoteHost,
      WasMentioned: effectiveWasMentioned,
      CommandAuthorized: commandAuthorized,
      // Originating channel for reply routing.
      OriginatingChannel: "imessage" as const,
      OriginatingTo: imessageTo,
    });

    const updateTarget = (isGroup ? chatTarget : undefined) || sender;
    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute:
        !isGroup && updateTarget
          ? {
              sessionKey: route.mainSessionKey,
              channel: "imessage",
              to: updateTarget,
              accountId: route.accountId,
            }
          : undefined,
      onRecordError: (err) => {
        logVerbose(`imessage: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

    const dispatcher = createReplyDispatcher({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        await deliverReplies({
          replies: [payload],
          target: ctxPayload.To,
          client,
          accountId: accountInfo.accountId,
          runtime,
          maxBytes: mediaMaxBytes,
          textLimit,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
      },
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof accountInfo.config.blockStreaming === "boolean"
            ? !accountInfo.config.blockStreaming
            : undefined,
        onModelSelected: prefixContext.onModelSelected,
      },
    });
    if (!queuedFinal) {
      if (isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: historyLimit,
        });
      }
      return;
    }
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  }

  const handleMessage = async (raw: unknown) => {
    const params = raw as { message?: IMessagePayload | null };
    const message = params?.message ?? null;
    if (!message) return;
    await inboundDebouncer.enqueue({ message });
  };

  await waitForTransportReady({
    label: "imsg rpc",
    timeoutMs: 30_000,
    logAfterMs: 10_000,
    logIntervalMs: 10_000,
    pollIntervalMs: 500,
    abortSignal: opts.abortSignal,
    runtime,
    check: async () => {
      const probe = await probeIMessage(2000, { cliPath, dbPath, runtime });
      if (probe.ok) return { ok: true };
      if (probe.fatal) {
        throw new Error(probe.error ?? "imsg rpc unavailable");
      }
      return { ok: false, error: probe.error ?? "unreachable" };
    },
  });

  if (opts.abortSignal?.aborted) return;

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime,
    onNotification: (msg) => {
      if (msg.method === "message") {
        void handleMessage(msg.params).catch((err) => {
          runtime.error?.(`imessage: handler failed: ${String(err)}`);
        });
      } else if (msg.method === "error") {
        runtime.error?.(`imessage: watch error ${JSON.stringify(msg.params)}`);
      }
    },
  });

  let subscriptionId: number | null = null;
  const abort = opts.abortSignal;
  const onAbort = () => {
    if (subscriptionId) {
      void client
        .request("watch.unsubscribe", {
          subscription: subscriptionId,
        })
        .catch(() => {
          // Ignore disconnect errors during shutdown.
        });
    }
    void client.stop().catch(() => {
      // Ignore disconnect errors during shutdown.
    });
  };
  abort?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await client.request<{ subscription?: number }>("watch.subscribe", {
      attachments: includeAttachments,
    });
    subscriptionId = result?.subscription ?? null;
    await client.waitForClose();
  } catch (err) {
    if (abort?.aborted) return;
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    abort?.removeEventListener("abort", onAbort);
    await client.stop();
  }
}
