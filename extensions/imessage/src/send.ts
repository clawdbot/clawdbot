import { spawn } from "node:child_process";
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
import {
  appendIMessageApprovalReactionHintForOutboundMessage,
  type IMessageApprovalConversationKey,
  registerIMessageApprovalReactionTargetForOutboundMessage,
} from "./approval-reactions.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { rememberIMessageReplyCache } from "./monitor-reply-cache.js";
import { rememberPersistedIMessageEcho } from "./monitor/persisted-echo-cache.js";
import {
  formatIMessageChatTarget,
  type IMessageService,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

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
  runCliJson?: (args: readonly string[]) => Promise<Record<string, unknown>>;
};

export type IMessageSendResult = {
  /**
   * Generic identifier returned by the bridge. May be a GUID string, a
   * numeric ROWID stringified, or the literal "ok"/"unknown" placeholders
   * when the bridge declines to return one. Most callers (reply cache, echo
   * cache, receipts) want this field — it is the broadest match for
   * downstream lookups.
   */
  messageId: string;
  /**
   * GUID-only identifier suitable for matching inbound `reacted_to_guid`
   * fields. Undefined when the bridge returned only a numeric ROWID or
   * placeholder. Approval-reaction bindings MUST use this field so the
   * outbound key matches what the inbound tapback will surface.
   */
  guid?: string;
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

// Approval-reaction bindings need to match `reacted_to_guid` on the inbound
// tapback, which is always the iMessage GUID (never a numeric ROWID). Some imsg
// bridge variants return a numeric `message_id` from `send` without a `guid` —
// for the approval path we strictly require the string GUID so we never bind
// against a numeric id that the inbound side can't produce.
function resolveOutboundMessageGuid(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) {
    return null;
  }
  const candidates = [result.guid, result.messageId, result.message_id, result.id];
  for (const value of candidates) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    // Reject all-digit strings: they came from numeric ROWIDs coerced to
    // strings (e.g. "12345"), not real GUIDs (which look like
    // "p:0/ABCD-EFGH-..." or contain non-digit characters).
    if (trimmed && !/^\d+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
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

function buildIMessageCliJsonArgs(args: readonly string[], dbPath?: string): string[] {
  const trimmedDbPath = dbPath?.trim();
  return [...args, ...(trimmedDbPath ? ["--db", trimmedDbPath] : []), "--json"];
}

function resolveIMessageCliFailure(result: Record<string, unknown>): string | null {
  if (result.success !== false) {
    return null;
  }
  return typeof result.error === "string" && result.error.trim()
    ? result.error.trim()
    : "iMessage action failed";
}

async function runIMessageCliJson(
  cliPath: string,
  dbPath: string | undefined,
  args: readonly string[],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cliPath, buildIMessageCliJsonArgs(args, dbPath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            killEscalation = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // best-effort
              }
            }, 2000);
            reject(new Error(`iMessage action timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killEscalation) {
        clearTimeout(killEscalation);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killEscalation) {
        clearTimeout(killEscalation);
      }
      const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = lines.at(-1);
      let parsed: Record<string, unknown> | null = null;
      if (last) {
        try {
          const json = JSON.parse(last) as unknown;
          if (json && typeof json === "object" && !Array.isArray(json)) {
            parsed = json as Record<string, unknown>;
          }
        } catch {
          // handled below
        }
      }
      if (code === 0 && parsed) {
        const failure = resolveIMessageCliFailure(parsed);
        if (failure) {
          reject(new Error(failure));
          return;
        }
        resolve(parsed);
        return;
      }
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        reject(new Error(parsed.error.trim()));
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `imsg exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAttachmentCommandFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|invalid|unsupported)\s+(?:command|subcommand)|not a recognized command|send-attachment.*(?:not found|unsupported|unavailable)|private api bridge.*unavailable|requires the imsg private api bridge|run imsg launch/iu.test(
    message,
  );
}

async function resolveAttachmentChatGuid(params: {
  target: ReturnType<typeof parseIMessageTarget>;
  runCliJson: (args: readonly string[]) => Promise<Record<string, unknown>>;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") {
    return params.target.chatGuid;
  }
  if (params.target.kind !== "chat_id") {
    return null;
  }
  const result = await params.runCliJson(["group", "--chat-id", String(params.target.chatId)]);
  return stringValue(result.guid) ?? stringValue(result.chat_guid) ?? null;
}

async function trySendAttachmentForExplicitChat(params: {
  accountId: string;
  target: ReturnType<typeof parseIMessageTarget>;
  filePath: string;
  echoText?: string;
  runCliJson: (args: readonly string[]) => Promise<Record<string, unknown>>;
}): Promise<IMessageSendResult | null> {
  let attachmentChatGuid: string | null = null;
  try {
    attachmentChatGuid = await resolveAttachmentChatGuid({
      target: params.target,
      runCliJson: params.runCliJson,
    });
  } catch (error) {
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }
  if (!attachmentChatGuid) {
    return null;
  }

  let result: Record<string, unknown>;
  try {
    result = await params.runCliJson([
      "send-attachment",
      "--chat",
      attachmentChatGuid,
      "--file",
      params.filePath,
      "--transport",
      "auto",
    ]);
  } catch (error) {
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }
  const failure = resolveIMessageCliFailure(result);
  if (failure) {
    const error = new Error(failure);
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }

  const resolvedId = resolveMessageId(result);
  const approvalBindingMessageId = resolveOutboundMessageGuid(result);
  const messageId = resolvedId ?? (result.ok || result.success ? "ok" : "unknown");
  const echoScope = resolveOutboundEchoScope({
    accountId: params.accountId,
    target: params.target,
  });
  if (echoScope) {
    rememberPersistedIMessageEcho({
      scope: echoScope,
      text: params.echoText,
      messageId: resolvedId ?? undefined,
    });
  }
  if (resolvedId) {
    rememberIMessageReplyCache({
      accountId: params.accountId,
      messageId: resolvedId,
      chatGuid: params.target.kind === "chat_guid" ? params.target.chatGuid : attachmentChatGuid,
      chatId: params.target.kind === "chat_id" ? params.target.chatId : undefined,
      timestamp: Date.now(),
      isFromMe: true,
    });
  }
  return {
    messageId,
    ...(approvalBindingMessageId ? { guid: approvalBindingMessageId } : {}),
    sentText: "",
    ...(params.echoText ? { echoText: params.echoText } : {}),
    receipt: createIMessageSendReceipt({
      messageId,
      target: params.target,
      kind: "media",
    }),
  };
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
  let message = text ? appendIMessageApprovalReactionHintForOutboundMessage(text) : "";
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
  const runCliJson =
    opts.runCliJson ??
    ((args: readonly string[]) => runIMessageCliJson(cliPath, dbPath, args, opts.timeoutMs));

  if (filePath && !message.trim() && !resolvedReplyToId) {
    const attachmentResult = await trySendAttachmentForExplicitChat({
      accountId: account.accountId,
      target,
      filePath,
      echoText,
      runCliJson,
    });
    if (attachmentResult) {
      return attachmentResult;
    }
  }
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
    // GUID-only id for approval-reaction binding (inbound `reacted_to_guid`
    // never carries a numeric ROWID, so the bind key must match). Undefined
    // when the bridge only returned a numeric or placeholder id.
    const approvalBindingMessageId = resolveOutboundMessageGuid(result);
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
      if (message) {
        if (approvalBindingMessageId) {
          const handleForKey =
            target.kind === "handle" ? normalizeIMessageHandle(target.to) : undefined;
          const conversation: IMessageApprovalConversationKey = {
            ...(target.kind === "chat_guid" ? { chatGuid: target.chatGuid } : {}),
            ...(target.kind === "chat_identifier" ? { chatIdentifier: target.chatIdentifier } : {}),
            ...(target.kind === "chat_id" ? { chatId: target.chatId } : {}),
            ...(handleForKey ? { handle: handleForKey } : {}),
          };
          registerIMessageApprovalReactionTargetForOutboundMessage({
            accountId: account.accountId,
            conversation,
            messageId: approvalBindingMessageId,
            text: message,
          });
        }
      }
    }
    return {
      messageId,
      ...(approvalBindingMessageId ? { guid: approvalBindingMessageId } : {}),
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
