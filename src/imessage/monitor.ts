import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../agents/identity.js";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveProviderGroupPolicy,
  resolveProviderGroupRequireMention,
} from "../config/group-policy.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { mediaKindFromMime } from "../media/constants.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { truncateUtf16Safe } from "../utils.js";
import { resolveIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
} from "./targets.js";

type IMessageAttachment = {
  original_path?: string | null;
  mime_type?: string | null;
  missing?: boolean | null;
};

type IMessagePayload = {
  id?: number | null;
  chat_id?: number | null;
  sender?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  created_at?: string | null;
  attachments?: IMessageAttachment[] | null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

export type MonitorIMessageOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  cliPath?: string;
  dbPath?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  requireMention?: boolean;
};

function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId } =
    params;
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, textLimit)) {
        await sendMessageIMessage(target, chunk, {
          maxBytes,
          client,
          accountId,
        });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageIMessage(target, caption, {
          mediaUrl: url,
          maxBytes,
          client,
          accountId,
        });
      }
    }
    runtime.log?.(`imessage: delivered reply to ${target}`);
  }
}

export async function monitorIMessageProvider(
  opts: MonitorIMessageOpts = {},
): Promise<void> {
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
  const textLimit = resolveTextChunkLimit(
    cfg,
    "imessage",
    accountInfo.accountId,
  );
  const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      imessageCfg.groupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0
        ? imessageCfg.allowFrom
        : []),
  );
  const groupPolicy = imessageCfg.groupPolicy ?? "open";
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const includeAttachments =
    opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;

  const handleMessage = async (raw: unknown) => {
    const params = raw as { message?: IMessagePayload | null };
    const message = params?.message ?? null;
    if (!message) return;

    const senderRaw = message.sender ?? "";
    const sender = senderRaw.trim();
    if (!sender) return;
    if (message.is_from_me) return;

    const chatId = message.chat_id ?? undefined;
    const chatGuid = message.chat_guid ?? undefined;
    const chatIdentifier = message.chat_identifier ?? undefined;

    const groupIdCandidate = chatId !== undefined ? String(chatId) : undefined;
    const groupListPolicy = groupIdCandidate
      ? resolveProviderGroupPolicy({
          cfg,
          provider: "imessage",
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
      groupIdCandidate &&
        groupListPolicy.allowlistEnabled &&
        groupListPolicy.groupConfig,
    );

    const isGroup = Boolean(message.is_group) || treatAsGroupByConfig;
    if (isGroup && !chatId) return;

    const groupId = isGroup ? groupIdCandidate : undefined;
    const storeAllowFrom = await readProviderAllowFromStore("imessage").catch(
      () => [],
    );
    const effectiveDmAllowFrom = Array.from(
      new Set([...allowFrom, ...storeAllowFrom]),
    )
      .map((v) => String(v).trim())
      .filter(Boolean);
    const effectiveGroupAllowFrom = Array.from(
      new Set([...groupAllowFrom, ...storeAllowFrom]),
    )
      .map((v) => String(v).trim())
      .filter(Boolean);

    if (isGroup) {
      if (groupPolicy === "disabled") {
        logVerbose("Blocked iMessage group message (groupPolicy: disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerbose(
            "Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)",
          );
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
          logVerbose(
            `Blocked iMessage sender ${sender} (not in groupAllowFrom)`,
          );
          return;
        }
      }
      if (groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
        logVerbose(
          `imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`,
        );
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
          const { code, created } = await upsertProviderPairingRequest({
            provider: "imessage",
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
                  provider: "imessage",
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
              logVerbose(
                `imessage pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            `Blocked iMessage sender ${sender} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }

    const route = resolveAgentRoute({
      cfg,
      provider: "imessage",
      accountId: accountInfo.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup
          ? String(chatId ?? "unknown")
          : normalizeIMessageHandle(sender),
      },
    });
    const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
    const messageText = (message.text ?? "").trim();
    const mentioned = isGroup
      ? matchesMentionPatterns(messageText, mentionRegexes)
      : true;
    const requireMention = resolveProviderGroupRequireMention({
      cfg,
      provider: "imessage",
      accountId: accountInfo.accountId,
      groupId,
      requireMentionOverride: opts.requireMention,
      overrideOrder: "before-config",
    });
    const canDetectMention = mentionRegexes.length > 0;
    const commandAuthorized = isGroup
      ? effectiveGroupAllowFrom.length > 0
        ? isAllowedIMessageSender({
            allowFrom: effectiveGroupAllowFrom,
            sender,
            chatId: chatId ?? undefined,
            chatGuid,
            chatIdentifier,
          })
        : true
      : dmAuthorized;
    const shouldBypassMention =
      isGroup &&
      requireMention &&
      !mentioned &&
      commandAuthorized &&
      hasControlCommand(messageText);
    const effectiveWasMentioned = mentioned || shouldBypassMention;
    if (
      isGroup &&
      requireMention &&
      canDetectMention &&
      !mentioned &&
      !shouldBypassMention
    ) {
      logVerbose(`imessage: skipping group message (no mention)`);
      return;
    }

    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    const firstAttachment = attachments?.find(
      (entry) => entry?.original_path && !entry?.missing,
    );
    const mediaPath = firstAttachment?.original_path ?? undefined;
    const mediaType = firstAttachment?.mime_type ?? undefined;
    const kind = mediaKindFromMime(mediaType ?? undefined);
    const placeholder = kind
      ? `<media:${kind}>`
      : attachments?.length
        ? "<media:attachment>"
        : "";
    const bodyText = messageText || placeholder;
    if (!bodyText) return;

    const chatTarget = formatIMessageChatTarget(chatId);
    const fromLabel = isGroup
      ? `${message.chat_name || "iMessage Group"} id:${chatId ?? "unknown"}`
      : `${normalizeIMessageHandle(sender)} id:${sender}`;
    const createdAt = message.created_at
      ? Date.parse(message.created_at)
      : undefined;
    const body = formatAgentEnvelope({
      provider: "iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: bodyText,
    });
    let combinedBody = body;
    const historyKey = isGroup
      ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
      : undefined;
    if (isGroup && historyKey && historyLimit > 0) {
      combinedBody = buildHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
        entry: {
          sender: normalizeIMessageHandle(sender),
          body: bodyText,
          timestamp: createdAt,
          messageId: message.id ? String(message.id) : undefined,
        },
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            provider: "iMessage",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${
              entry.messageId ? ` [id:${entry.messageId}]` : ""
            }`,
          }),
      });
    }

    const imessageTo = chatTarget || `imessage:${sender}`;
    const ctxPayload = {
      Body: combinedBody,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: isGroup ? `group:${chatId}` : `imessage:${sender}`,
      To: imessageTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (message.chat_name ?? undefined) : undefined,
      GroupMembers: isGroup
        ? (message.participants ?? []).filter(Boolean).join(", ")
        : undefined,
      SenderName: sender,
      SenderId: sender,
      Provider: "imessage",
      Surface: "imessage",
      MessageSid: message.id ? String(message.id) : undefined,
      Timestamp: createdAt,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      WasMentioned: effectiveWasMentioned,
      CommandAuthorized: commandAuthorized,
      // Originating channel for reply routing.
      OriginatingChannel: "imessage" as const,
      OriginatingTo: imessageTo,
    };

    if (!isGroup) {
      const sessionCfg = cfg.session;
      const storePath = resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      const to = chatTarget || sender;
      if (to) {
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          provider: "imessage",
          to,
          accountId: route.accountId,
        });
      }
    }

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    let didSendReply = false;
    const dispatcher = createReplyDispatcher({
      responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
        .responsePrefix,
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
        didSendReply = true;
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(`imessage ${info.kind} reply failed: ${String(err)}`),
        );
      },
    });

    const { queuedFinal } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof accountInfo.config.blockStreaming === "boolean"
            ? !accountInfo.config.blockStreaming
            : undefined,
      },
    });
    if (!queuedFinal) {
      if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
        clearHistoryEntries({ historyMap: groupHistories, historyKey });
      }
      return;
    }
    if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
      clearHistoryEntries({ historyMap: groupHistories, historyKey });
    }
  };

  const client = await createIMessageRpcClient({
    cliPath: opts.cliPath ?? imessageCfg.cliPath,
    dbPath: opts.dbPath ?? imessageCfg.dbPath,
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
    const result = await client.request<{ subscription?: number }>(
      "watch.subscribe",
      { attachments: includeAttachments },
    );
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
