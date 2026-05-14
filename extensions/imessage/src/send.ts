import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { kindFromMime, resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { rememberIMessageReplyCache } from "./monitor-reply-cache.js";
import { rememberPersistedIMessageEcho } from "./monitor/persisted-echo-cache.js";
import { formatIMessageChatTarget, type IMessageService, parseIMessageTarget } from "./targets.js";

type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  replyToId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
  config: OpenClawConfig;
  account?: ResolvedIMessageAccount;
  resolveAttachmentImpl?: (
    mediaUrl: string,
    maxBytes: number,
    options?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    },
  ) => Promise<{ path: string; contentType?: string }>;
  createClient?: (params: { cliPath: string; dbPath?: string }) => Promise<IMessageRpcClient>;
};

type IMessageSendResult = {
  messageId: string;
  sentText: string;
  echoText?: string;
  receipt: MessageReceipt;
};

const MAX_REPLY_TO_ID_LENGTH = 256;

function stripUnsafeReplyTagChars(value: string): string {
  let next = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127 || ch === "[" || ch === "]") {
      continue;
    }
    next += ch;
  }
  return next;
}

function sanitizeReplyToId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = stripUnsafeReplyTagChars(trimmed).trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length > MAX_REPLY_TO_ID_LENGTH) {
    return sanitized.slice(0, MAX_REPLY_TO_ID_LENGTH);
  }
  return sanitized;
}

function resolveMessageId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) {
    return null;
  }
  const raw =
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? raw.trim() : null;
}

function resolveOutboundEchoText(text: string, mediaContentType?: string): string | undefined {
  if (text.trim()) {
    return text;
  }
  const kind = kindFromMime(mediaContentType ?? undefined);
  if (!kind) {
    return undefined;
  }
  return kind === "image" ? "<media:image>" : `<media:${kind}>`;
}

function createIMessageSendReceipt(params: {
  messageId: string;
  target: ReturnType<typeof parseIMessageTarget>;
  kind: MessageReceiptPartKind;
  replyToId?: string;
}): MessageReceipt {
  const messageId = params.messageId.trim();
  const results: MessageReceiptSourceResult[] =
    messageId && messageId !== "unknown" && messageId !== "ok"
      ? [
          {
            channel: "imessage",
            messageId,
            meta: {
              targetKind: params.target.kind,
            },
          },
        ]
      : [];
  if (results[0]) {
    if (params.target.kind === "chat_id") {
      results[0].chatId = String(params.target.chatId);
    } else if (params.target.kind === "chat_guid") {
      results[0].conversationId = params.target.chatGuid;
    } else if (params.target.kind === "chat_identifier") {
      results[0].conversationId = params.target.chatIdentifier;
    }
  }
  const receiptParams: Parameters<typeof createMessageReceiptFromOutboundResults>[0] = {
    results,
    kind: params.kind,
  };
  if (params.replyToId) {
    receiptParams.replyToId = params.replyToId;
  }
  return createMessageReceiptFromOutboundResults(receiptParams);
}

function resolveOutboundEchoScope(params: {
  accountId: string;
  target: ReturnType<typeof parseIMessageTarget>;
}): string | null {
  if (params.target.kind === "chat_id") {
    return `${params.accountId}:${formatIMessageChatTarget(params.target.chatId)}`;
  }
  if (params.target.kind === "chat_guid") {
    return `${params.accountId}:chat_guid:${params.target.chatGuid}`;
  }
  if (params.target.kind === "chat_identifier") {
    return `${params.accountId}:chat_identifier:${params.target.chatIdentifier}`;
  }
  return `${params.accountId}:imessage:${params.target.to}`;
}

export async function sendMessageIMessage(
  to: string,
  text: string,
  opts: IMessageSendOpts,
): Promise<IMessageSendResult> {
  const cfg = requireRuntimeConfig(opts.config, "iMessage send");
  const account =
    opts.account ??
    resolveIMessageAccount({
      cfg,
      accountId: opts.accountId,
    });
  const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const service =
    opts.service ??
    (target.kind === "handle" ? target.service : undefined) ??
    (account.config.service as IMessageService | undefined);
  const region = opts.region?.trim() || account.config.region?.trim() || "US";
  const maxBytes =
    typeof opts.maxBytes === "number"
      ? opts.maxBytes
      : typeof account.config.mediaMaxMb === "number"
        ? account.config.mediaMaxMb * 1024 * 1024
        : 16 * 1024 * 1024;
  let message = text ?? "";
  let filePath: string | undefined;
  let mediaContentType: string | undefined;

  if (opts.mediaUrl?.trim()) {
    const resolveAttachmentFn = opts.resolveAttachmentImpl ?? resolveOutboundAttachmentFromUrl;
    const resolved = await resolveAttachmentFn(opts.mediaUrl.trim(), maxBytes, {
      localRoots: opts.mediaLocalRoots,
      readFile: opts.mediaReadFile,
    });
    filePath = resolved.path;
    mediaContentType = resolved.contentType ?? undefined;
  }

  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  if (message.trim()) {
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "imessage",
      accountId: account.accountId,
    });
    message = convertMarkdownTables(message, tableMode);
  }
  message = stripInlineDirectiveTagsForDelivery(message).text;
  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  // Extract markdown bold/italic/underline/strikethrough into typed-run
  // ranges that the imsg bridge applies via attributedBody. macOS 15+
  // recipients render the runs natively; earlier macOS recipients still
  // see the marker-stripped text without literal asterisks.
  const formatted = message.trim()
    ? extractMarkdownFormatRuns(message)
    : { text: message, ranges: [] };
  message = formatted.text;
  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  const echoText = resolveOutboundEchoText(message, filePath ? mediaContentType : undefined);
  const resolvedReplyToId = sanitizeReplyToId(opts.replyToId);
  const params: Record<string, unknown> = {
    text: message,
    service: service || "auto",
    region,
  };
  if (resolvedReplyToId) {
    params.reply_to = resolvedReplyToId;
  }
  if (formatted.ranges.length > 0) {
    params.formatting = formatted.ranges;
  }
  if (filePath) {
    params.file = filePath;
  }

  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }

  const client =
    opts.client ??
    (opts.createClient
      ? await opts.createClient({ cliPath, dbPath })
      : await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldClose = !opts.client;
  try {
    const result = await client.request<{ ok?: string }>("send", params, {
      timeoutMs: opts.timeoutMs,
    });
    const resolvedId = resolveMessageId(result);
    const messageId = resolvedId ?? (result?.ok ? "ok" : "unknown");
    const echoScope = resolveOutboundEchoScope({ accountId: account.accountId, target });
    if (echoScope) {
      rememberPersistedIMessageEcho({
        scope: echoScope,
        text: echoText,
        messageId: resolvedId ?? undefined,
      });
    }
    // Record the outbound message in the reply cache with isFromMe=true so
    // edit/unsend actions can verify the agent actually sent the message
    // before dispatching. Inbound recording (in monitor/inbound-processing)
    // sets isFromMe=false, so the cache distinguishes own-sent from received.
    if (resolvedId) {
      rememberIMessageReplyCache({
        accountId: account.accountId,
        messageId: resolvedId,
        chatGuid: target.kind === "chat_guid" ? target.chatGuid : undefined,
        chatIdentifier:
          target.kind === "chat_identifier"
            ? target.chatIdentifier
            : target.kind === "handle"
              ? `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}`
              : undefined,
        chatId: target.kind === "chat_id" ? target.chatId : undefined,
        timestamp: Date.now(),
        isFromMe: true,
      });
    }
    return {
      messageId,
      sentText: message,
      ...(echoText ? { echoText } : {}),
      receipt: createIMessageSendReceipt({
        messageId,
        target,
        kind: filePath ? "media" : "text",
        ...(resolvedReplyToId ? { replyToId: resolvedReplyToId } : {}),
      }),
    };
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}
