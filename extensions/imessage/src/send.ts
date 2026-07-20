// Imessage plugin module implements send behavior.
import { constants, accessSync } from "node:fs";
import { createRequire } from "node:module";
import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { kindFromMime, resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { sleep as delay } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import {
  hasExclusiveIMessageLocalDatabase,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "./accounts.js";
import {
  appendIMessageApprovalReactionHintForOutboundMessage,
  extractIMessageApprovalPromptBinding,
  type IMessageApprovalConversationKey,
  registerIMessageApprovalReactionTargetForOutboundMessage,
} from "./approval-reactions.js";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import { runIMessageCliJsonCommand } from "./cli-output.js";
import { resolveIMessageChatDbLookupPath } from "./cli-path.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_SEND_TIMEOUT_MS } from "./constants.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { resolveAuthorizedIMessageReplyReference } from "./message-resource.js";
import { rememberIMessageReplyCache } from "./monitor-reply-cache.js";
import {
  forgetPersistedIMessageEchoKey,
  rememberPersistedIMessageEcho,
} from "./monitor/persisted-echo-cache.js";
import {
  formatIMessageChatTarget,
  type IMessageService,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const require = createRequire(import.meta.url);
type ParsedIMessageTarget = ReturnType<typeof parseIMessageTarget>;
const MIN_PENDING_PERSISTED_ECHO_TTL_MS = 60_000;
const PENDING_PERSISTED_ECHO_GRACE_MS = 5_000;
type IMessageSendTransport = "auto" | "bridge" | "applescript";

type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  conversationReadOrigin?: "delegated" | "direct-operator";
  replyToId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  audioAsVoice?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
  config: OpenClawConfig;
  account?: ResolvedIMessageAccount;
  approvalKind?: "exec" | "plugin";
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
  resolveMessageGuidImpl?: (params: {
    dbPath?: string;
    messageId: string;
  }) => Promise<string | null> | string | null;
  resolveSentMessageGuidImpl?: (params: {
    dbPath?: string;
    target: ParsedIMessageTarget;
    text: string;
    sentAfterMs?: number;
  }) => Promise<string | null> | string | null;
};

type IMessageSendResult = {
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
  echoMedia?: MediaPlaceholderTextFact;
  receipt: MessageReceipt;
};

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

function isNumericMessageRowId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function resolveTargetService(target: ParsedIMessageTarget): IMessageService | undefined {
  if (target.kind !== "handle") {
    return undefined;
  }
  if (target.serviceExplicit || target.service !== "auto") {
    return target.service;
  }
  return undefined;
}

function normalizeResolvedMessageGuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && !isNumericMessageRowId(trimmed) ? trimmed : null;
}

function loadNodeSqlite(): typeof import("node:sqlite") | null {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return null;
  }
}

function resolveMessageGuidFromChatDb(params: {
  dbPath?: string;
  messageId: string;
}): string | null {
  const dbPath = params.dbPath?.trim();
  const messageId = params.messageId.trim();
  if (!dbPath || !isNumericMessageRowId(messageId)) {
    return null;
  }
  const sqlite = loadNodeSqlite();
  if (!sqlite) {
    return null;
  }
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT guid FROM message WHERE ROWID = ?").get(messageId) as
      | { guid?: unknown }
      | undefined;
    return normalizeResolvedMessageGuid(row?.guid);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort cleanup
    }
  }
}

function getStringRowValue(row: Record<string, unknown> | undefined, key: string): string | null {
  return normalizeResolvedMessageGuid(row?.[key]);
}

function appleMessageDateLowerBoundMs(sentAfterMs: number | undefined): number | null {
  if (!Number.isFinite(sentAfterMs)) {
    return null;
  }
  // chat.db stores message.date as nanoseconds since 2001-01-01. Give the
  // bridge a small amount of clock/write skew so a just-sent row is included.
  return Math.max(0, Math.floor(((sentAfterMs as number) - 978_307_200_000 - 5_000) * 1_000_000));
}

function resolveLatestSentMessageGuidFromChatDb(params: {
  dbPath?: string;
  target: ParsedIMessageTarget;
  text: string;
  sentAfterMs?: number;
}): string | null {
  const dbPath = params.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  const sqlite = loadNodeSqlite();
  if (!sqlite) {
    return null;
  }
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const targetClauses: string[] = [];
    const targetParams: Array<string | number> = [];
    const lowerBound = appleMessageDateLowerBoundMs(params.sentAfterMs);
    if (params.text) {
      targetClauses.push("m.text = ?");
      targetParams.push(params.text);
    }
    if (lowerBound !== null) {
      targetClauses.push("m.date >= ?");
      targetParams.push(lowerBound);
    }
    if (params.target.kind === "chat_id") {
      targetClauses.push("cmj.chat_id = ?");
      targetParams.push(params.target.chatId);
    } else if (params.target.kind === "chat_guid") {
      targetClauses.push("c.guid = ?");
      targetParams.push(params.target.chatGuid);
    } else if (params.target.kind === "chat_identifier") {
      targetClauses.push("c.chat_identifier = ?");
      targetParams.push(params.target.chatIdentifier);
    } else {
      const normalizedHandle = normalizeIMessageHandle(params.target.to);
      targetClauses.push("(h.id = ? OR h.uncanonicalized_id = ?)");
      targetParams.push(normalizedHandle, params.target.to);
    }
    const targetWhere = targetClauses.length ? `AND ${targetClauses.join(" AND ")}` : "";
    const selectSql = `
      SELECT m.guid
      FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 1
      ${targetWhere}
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT 10
    `;
    const rows = db.prepare(selectSql).all(...targetParams) as Array<Record<string, unknown>>;
    return getStringRowValue(rows[0], "guid");
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort cleanup
    }
  }
}

function canResolveLatestSentMessageGuidFromChatDb(dbPath?: string): boolean {
  const normalizedDbPath = dbPath?.trim();
  if (!normalizedDbPath || !loadNodeSqlite()) {
    return false;
  }
  try {
    accessSync(normalizedDbPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveApprovalBindingMessageGuid(params: {
  dbPath?: string;
  messageId: string | null;
  result: Record<string, unknown> | null | undefined;
  resolveMessageGuidImpl?: IMessageSendOpts["resolveMessageGuidImpl"];
}): Promise<string | null> {
  const immediateGuid = resolveOutboundMessageGuid(params.result);
  if (immediateGuid) {
    return immediateGuid;
  }
  const messageId = params.messageId?.trim();
  if (!messageId || !isNumericMessageRowId(messageId)) {
    return null;
  }
  const resolver = params.resolveMessageGuidImpl ?? resolveMessageGuidFromChatDb;
  return normalizeResolvedMessageGuid(
    await resolver({
      dbPath: params.dbPath,
      messageId,
    }),
  );
}

async function resolveFallbackSentMessageGuid(params: {
  dbPath?: string;
  target: ParsedIMessageTarget;
  text: string;
  sentAfterMs?: number;
  resolveSentMessageGuidImpl?: IMessageSendOpts["resolveSentMessageGuidImpl"];
}): Promise<string | null> {
  const resolver = params.resolveSentMessageGuidImpl ?? resolveLatestSentMessageGuidFromChatDb;
  if (
    !params.resolveSentMessageGuidImpl &&
    !canResolveLatestSentMessageGuidFromChatDb(params.dbPath)
  ) {
    return null;
  }
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() <= deadlineMs) {
    const resolved = normalizeResolvedMessageGuid(
      await resolver({
        dbPath: params.dbPath,
        target: params.target,
        text: params.text,
        sentAfterMs: params.sentAfterMs,
      }),
    );
    if (resolved) {
      return resolved;
    }
    if (Date.now() >= deadlineMs) {
      return null;
    }
    await delay(250);
  }
  return null;
}

function shouldRecoverApprovalPromptGuid(params: {
  message: string;
  filePath?: string;
  replyToId?: string | null;
}): boolean {
  return (
    !params.filePath &&
    !params.replyToId &&
    Boolean(params.message.trim()) &&
    Boolean(extractIMessageApprovalPromptBinding(params.message))
  );
}

function canCheckSentMessageAfterRpcTimeout(params: {
  dbPath?: string;
  resolveSentMessageGuidImpl?: IMessageSendOpts["resolveSentMessageGuidImpl"];
}): boolean {
  return (
    Boolean(params.resolveSentMessageGuidImpl) ||
    canResolveLatestSentMessageGuidFromChatDb(params.dbPath)
  );
}

function resolveOutboundEchoText(text: string): string | undefined {
  return text.trim() || undefined;
}

function resolveOutboundEchoMedia(
  mediaContentType: string | undefined,
): MediaPlaceholderTextFact | undefined {
  if (!mediaContentType) {
    return undefined;
  }
  return { contentType: mediaContentType, kind: kindFromMime(mediaContentType) ?? "unknown" };
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

function isConcreteIMessageMessageId(messageId: string | undefined): boolean {
  const trimmed = messageId?.trim();
  return Boolean(trimmed && trimmed !== "unknown" && trimmed !== "ok");
}

function canSynthesizeAttachmentChatHandle(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.includes("@") || trimmed.startsWith("+");
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

function resolveIMessageCliFailure(result: Record<string, unknown>): string | null {
  if (result.success !== false) {
    return null;
  }
  return typeof result.error === "string" && result.error.trim()
    ? result.error.trim()
    : "iMessage action failed";
}

function isIMessageRpcSendTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /imsg rpc timeout \(send\)/i.test(message);
}

async function runIMessageCliJson(
  cliPath: string,
  dbPath: string | undefined,
  args: readonly string[],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return await runIMessageCliJsonCommand({
    args,
    cliPath,
    dbPath,
    timeoutMs,
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resultService(value: unknown): IMessageService | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === "imessage" || normalized === "sms" ? normalized : undefined;
}

function resolvePendingPersistedEchoTtlMs(timeoutMs: number): number {
  return Math.max(
    MIN_PENDING_PERSISTED_ECHO_TTL_MS,
    Math.max(0, timeoutMs) + PENDING_PERSISTED_ECHO_GRACE_MS,
  );
}

function isAttachmentCommandFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|invalid|unsupported)\s+(?:command|subcommand)|not a recognized command|send-attachment.*(?:not found|unsupported|unavailable)|private api bridge.*unavailable|requires the imsg private api bridge|run imsg launch/iu.test(
    message,
  );
}

// A threaded reply (reply_to) needs the private-API bridge transport; on an
// AppleScript-only deployment imsg rejects it outright. Detect that specific
// error so we can resend the message unthreaded instead of dropping it (#99638).
function isThreadedReplyUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reply_to requires bridge transport|cannot send threaded repl|threaded repl(?:y|ies)\b.*(?:unsupported|not supported|requires|unavailable)|requires bridge transport/iu.test(
    message,
  );
}

async function resolveAttachmentChatTarget(params: {
  target: ReturnType<typeof parseIMessageTarget>;
  service?: IMessageService;
  runCliJson: (args: readonly string[]) => Promise<Record<string, unknown>>;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") {
    return params.target.chatGuid;
  }
  if (params.target.kind === "handle") {
    if (!canSynthesizeAttachmentChatHandle(params.target.to)) {
      return null;
    }
    const normalizedHandle = normalizeIMessageHandle(params.target.to);
    if (!normalizedHandle) {
      return null;
    }
    const service = params.target.service !== "auto" ? params.target.service : params.service;
    if (service === "sms") {
      return `SMS;-;${normalizedHandle}`;
    }
    if (service === "imessage") {
      return `iMessage;-;${normalizedHandle}`;
    }
    return `any;-;${normalizedHandle}`;
  }
  if (params.target.kind !== "chat_id") {
    return null;
  }
  const result = await params.runCliJson(["group", "--chat-id", String(params.target.chatId)]);
  return stringValue(result.guid) ?? stringValue(result.chat_guid) ?? null;
}

async function trySendAttachmentForTarget(params: {
  accountId: string;
  dbPath?: string;
  target: ReturnType<typeof parseIMessageTarget>;
  service?: IMessageService;
  filePath: string;
  audioAsVoice?: boolean;
  replyToId?: string;
  echoText?: string;
  echoMedia?: MediaPlaceholderTextFact;
  pendingEchoTtlMs: number;
  runCliJson: (args: readonly string[]) => Promise<Record<string, unknown>>;
  resolveMessageGuidImpl?: IMessageSendOpts["resolveMessageGuidImpl"];
}): Promise<IMessageSendResult | null> {
  let attachmentChatTarget: string | null;
  try {
    attachmentChatTarget = await resolveAttachmentChatTarget({
      target: params.target,
      service: params.service,
      runCliJson: params.runCliJson,
    });
  } catch (error) {
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }
  if (!attachmentChatTarget) {
    return null;
  }

  const echoScope = resolveOutboundEchoScope({
    accountId: params.accountId,
    target: params.target,
  });
  let result: Record<string, unknown>;
  let pendingEchoKey: string | undefined;
  try {
    if (echoScope) {
      pendingEchoKey = rememberPersistedIMessageEcho({
        scope: echoScope,
        text: params.echoText,
        media: params.echoMedia,
        ttlMs: params.pendingEchoTtlMs,
        pending: true,
      });
    }
    result = await params.runCliJson([
      "send-attachment",
      "--chat",
      attachmentChatTarget,
      "--file",
      params.filePath,
      ...(params.audioAsVoice ? ["--audio"] : []),
      ...(params.replyToId ? ["--reply-to", params.replyToId] : []),
      "--transport",
      "auto",
    ]);
  } catch (error) {
    forgetPersistedIMessageEchoKey(pendingEchoKey);
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }
  const failure = resolveIMessageCliFailure(result);
  if (failure) {
    const error = new Error(failure);
    forgetPersistedIMessageEchoKey(pendingEchoKey);
    if (isAttachmentCommandFallbackError(error)) {
      return null;
    }
    throw error;
  }

  const resolvedId = resolveMessageId(result);
  const approvalBindingMessageId = await resolveApprovalBindingMessageGuid({
    dbPath: params.dbPath,
    messageId: resolvedId,
    result,
    resolveMessageGuidImpl: params.resolveMessageGuidImpl,
  });
  const messageId = resolvedId ?? (result.ok || result.success ? "ok" : "unknown");
  if (echoScope) {
    rememberPersistedIMessageEcho({
      scope: echoScope,
      text: params.echoText,
      media: params.echoMedia,
      messageId: resolvedId ?? undefined,
    });
  }
  if (resolvedId) {
    rememberIMessageReplyCache({
      accountId: params.accountId,
      messageId: resolvedId,
      chatGuid:
        params.target.kind === "chat_guid"
          ? params.target.chatGuid
          : params.target.kind === "chat_id"
            ? attachmentChatTarget
            : undefined,
      chatIdentifier:
        params.target.kind === "chat_identifier" || params.target.kind === "handle"
          ? attachmentChatTarget
          : undefined,
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
    ...(params.echoMedia ? { echoMedia: params.echoMedia } : {}),
    receipt: createIMessageSendReceipt({
      messageId,
      target: params.target,
      kind: params.audioAsVoice ? "voice" : "media",
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
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
  const chatDbLookupPath = resolveIMessageChatDbLookupPath({
    cliPath,
    dbPath,
    remoteHost: account.config.remoteHost,
  });
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const service =
    opts.service ??
    resolveTargetService(target) ??
    (account.config.service as IMessageService | undefined);
  const sendTransport = (account.config.sendTransport ?? "auto") as IMessageSendTransport;
  const resolvedReplyToId = resolveAuthorizedIMessageReplyReference({
    account,
    target,
    cliPath,
    dbPath,
    hasExclusiveLocalDatabase: hasExclusiveIMessageLocalDatabase({
      cfg,
      account,
      cliPath,
      dbPath,
    }),
    service,
    replyToId: opts.replyToId,
    conversationReadOrigin: opts.conversationReadOrigin,
  });
  // Sends use a dedicated longer default (not the 10s probe timeout) so macOS 26
  // bridge stalls aren't aborted mid-send. Explicit opts/probeTimeoutMs still win
  // for callers that tuned them. See DEFAULT_IMESSAGE_SEND_TIMEOUT_MS.
  const timeoutMs =
    opts.timeoutMs ?? account.config.probeTimeoutMs ?? DEFAULT_IMESSAGE_SEND_TIMEOUT_MS;
  const pendingEchoTtlMs = resolvePendingPersistedEchoTtlMs(timeoutMs);
  const region = opts.region?.trim() || account.config.region?.trim() || "US";
  const maxBytes =
    typeof opts.maxBytes === "number"
      ? opts.maxBytes
      : typeof account.config.mediaMaxMb === "number"
        ? account.config.mediaMaxMb * 1024 * 1024
        : 16 * 1024 * 1024;
  let message =
    text && opts.approvalKind ? appendIMessageApprovalReactionHintForOutboundMessage(text) : text;
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
  const echoText = resolveOutboundEchoText(message);
  const echoMedia = filePath ? resolveOutboundEchoMedia(mediaContentType) : undefined;
  // The reply id actually delivered. The threaded-reply fallback below clears it
  // so the receipt and approval binding report the unthreaded send it became,
  // not the threaded reply the transport rejected (#99638).
  let effectiveReplyToId = resolvedReplyToId;
  const runCliJson =
    opts.runCliJson ??
    ((args: readonly string[]) => runIMessageCliJson(cliPath, dbPath, args, timeoutMs));

  if (filePath && (!resolvedReplyToId || opts.audioAsVoice)) {
    const attachmentResult = await trySendAttachmentForTarget({
      accountId: account.accountId,
      dbPath: chatDbLookupPath,
      target,
      service,
      filePath,
      audioAsVoice: opts.audioAsVoice,
      ...(resolvedReplyToId ? { replyToId: resolvedReplyToId } : {}),
      echoMedia,
      pendingEchoTtlMs,
      runCliJson,
      resolveMessageGuidImpl: opts.resolveMessageGuidImpl,
    });
    if (attachmentResult) {
      if (!message.trim()) {
        return attachmentResult;
      }
      const captionResult = await sendMessageIMessage(to, text, {
        ...opts,
        ...(opts.client ? { client: opts.client } : {}),
        mediaUrl: undefined,
      });
      const messageId = isConcreteIMessageMessageId(attachmentResult.messageId)
        ? attachmentResult.messageId
        : captionResult.messageId;
      return {
        messageId,
        ...((captionResult.guid ?? attachmentResult.guid)
          ? { guid: captionResult.guid ?? attachmentResult.guid }
          : {}),
        sentText: captionResult.sentText,
        ...((captionResult.echoText ?? attachmentResult.echoText)
          ? { echoText: captionResult.echoText ?? attachmentResult.echoText }
          : {}),
        ...(attachmentResult.echoMedia ? { echoMedia: attachmentResult.echoMedia } : {}),
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ receipt: attachmentResult.receipt }, { receipt: captionResult.receipt }],
          sentAt: Math.max(attachmentResult.receipt.sentAt, captionResult.receipt.sentAt),
        }),
      };
    }
  }
  const params: Record<string, unknown> = {
    text: message,
    service: service || "auto",
    region,
    transport: sendTransport,
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

  const echoScope = resolveOutboundEchoScope({ accountId: account.accountId, target });

  const client =
    opts.client ??
    (opts.createClient
      ? await opts.createClient({ cliPath, dbPath })
      : await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldClose = !opts.client;
  let closedClient = false;
  const stopOwnedClient = async () => {
    if (!shouldClose || closedClient) {
      return;
    }
    closedClient = true;
    await client.stop();
  };
  let result: Record<string, unknown>;
  const sendStartedAtMs = Date.now();
  let pendingEchoKey: string | undefined;
  try {
    try {
      if (echoScope) {
        pendingEchoKey = rememberPersistedIMessageEcho({
          scope: echoScope,
          text: echoText,
          media: echoMedia,
          ttlMs: pendingEchoTtlMs,
          pending: true,
        });
      }
      result = await client.request<Record<string, unknown>>("send", params, {
        timeoutMs,
      });
    } catch (error) {
      if (resolvedReplyToId && isThreadedReplyUnsupportedError(error)) {
        // #99638: the transport cannot deliver a threaded reply, so resend the
        // message unthreaded rather than dropping it. Covers text and media
        // replies alike (both carry reply_to through this send). One retry with
        // reply_to stripped, keeping any file; a further failure propagates.
        const plainParams = { ...params };
        delete plainParams.reply_to;
        result = await client.request<Record<string, unknown>>("send", plainParams, {
          timeoutMs,
        });
        effectiveReplyToId = undefined;
      } else if (filePath || !isIMessageRpcSendTimeout(error)) {
        throw error;
      } else if (
        !shouldRecoverApprovalPromptGuid({
          message,
          filePath,
          replyToId: resolvedReplyToId,
        }) ||
        !canCheckSentMessageAfterRpcTimeout({
          dbPath: chatDbLookupPath,
          resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
        })
      ) {
        throw error;
      } else {
        const recoveredGuid = await resolveFallbackSentMessageGuid({
          dbPath: chatDbLookupPath,
          target,
          text: message,
          sentAfterMs: sendStartedAtMs,
          resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
        });
        if (recoveredGuid) {
          result = { guid: recoveredGuid, status: "sent" };
        } else {
          throw error;
        }
      }
    }
    const resolvedId = resolveMessageId(result);
    const messageId =
      resolvedId ?? (result?.ok || result?.success || result?.status === "sent" ? "ok" : "unknown");
    // GUID-only id for approval-reaction binding (inbound `reacted_to_guid`
    // never carries a numeric ROWID, so the bind key must match). Undefined
    // when the bridge only returned a placeholder id. Numeric ROWIDs are
    // resolved through chat.db when available so chat_id sends can still bind
    // to the stable GUID surfaced by inbound tapbacks.
    let approvalBindingMessageId = await resolveApprovalBindingMessageGuid({
      dbPath: chatDbLookupPath,
      messageId: resolvedId,
      result,
      resolveMessageGuidImpl: opts.resolveMessageGuidImpl,
    });
    if (
      !approvalBindingMessageId &&
      shouldRecoverApprovalPromptGuid({
        message,
        filePath,
        replyToId: effectiveReplyToId,
      })
    ) {
      approvalBindingMessageId = await resolveFallbackSentMessageGuid({
        dbPath: chatDbLookupPath,
        target,
        text: message,
        sentAfterMs: sendStartedAtMs,
        resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
      });
    }
    if (echoScope) {
      rememberPersistedIMessageEcho({
        scope: echoScope,
        text: echoText,
        media: echoMedia,
        messageId: resolvedId ?? undefined,
      });
    }
    // Record the outbound message in the reply cache with isFromMe=true so
    // edit/unsend actions can verify the agent actually sent the message
    // before dispatching. Inbound recording (in monitor/inbound-processing)
    // sets isFromMe=false, so the cache distinguishes own-sent from received.
    if (resolvedId) {
      const chatContext = chatContextFromIMessageTarget(
        target,
        resultService(result.service) ?? service,
      );
      const providerChatGuid = stringValue(result.chat_guid) ?? stringValue(result.chatGuid);
      rememberIMessageReplyCache({
        accountId: account.accountId,
        messageId: resolvedId,
        ...chatContext,
        ...(providerChatGuid ? { chatGuid: providerChatGuid } : {}),
        timestamp: Date.now(),
        isFromMe: true,
      });
    }
    if (message && approvalBindingMessageId && opts.approvalKind) {
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
        approvalKind: opts.approvalKind,
      });
    }
    return {
      messageId,
      ...(approvalBindingMessageId ? { guid: approvalBindingMessageId } : {}),
      sentText: message,
      ...(echoText ? { echoText } : {}),
      ...(echoMedia ? { echoMedia } : {}),
      receipt: createIMessageSendReceipt({
        messageId,
        target,
        kind: filePath ? "media" : "text",
        ...(effectiveReplyToId ? { replyToId: effectiveReplyToId } : {}),
      }),
    };
  } catch (error) {
    forgetPersistedIMessageEchoKey(pendingEchoKey);
    throw error;
  } finally {
    await stopOwnedClient();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
