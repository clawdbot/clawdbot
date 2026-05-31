import { spawn } from "node:child_process";
import { constants, accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import {
  appendIMessageApprovalReactionHintForOutboundMessage,
  extractIMessageApprovalPromptBinding,
  type IMessageApprovalConversationKey,
  registerIMessageApprovalReactionTargetForOutboundMessage,
} from "./approval-reactions.js";
import { appendIMessageCliStderrTail, appendIMessageCliStdout } from "./cli-output.js";
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

const require = createRequire(import.meta.url);
type ParsedIMessageTarget = ReturnType<typeof parseIMessageTarget>;

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
const sshWrapperCliPathCache = new Map<string, boolean>();

function safeHomeDir(): string | undefined {
  const home = process.env.HOME?.trim();
  if (home) {
    return home;
  }
  try {
    return os.homedir().trim() || undefined;
  } catch {
    return undefined;
  }
}

function expandCliPathForInspection(cliPath: string): string {
  if (!cliPath.startsWith("~")) {
    return cliPath;
  }
  const home = safeHomeDir();
  return home ? cliPath.replace(/^~(?=$|[\\/])/, home) : cliPath;
}

function isSshIMessageCliWrapper(cliPath: string): boolean {
  if (cliPath === "imsg") {
    return false;
  }
  const cached = sshWrapperCliPathCache.get(cliPath);
  if (cached !== undefined) {
    return cached;
  }
  let detected = false;
  try {
    const content = readFileSync(expandCliPathForInspection(cliPath), "utf8");
    detected = /\bssh\b[\s\S]*\bimsg\b/u.test(content);
  } catch {
    detected = false;
  }
  // cliPath scripts are process-stable channel metadata; cache inspection so
  // repeated sends do not poll wrapper files on the hot path.
  sshWrapperCliPathCache.set(cliPath, detected);
  return detected;
}

function isLocalIMessageCliPath(params: { cliPath: string; remoteHost?: string }): boolean {
  const cliPath = params.cliPath.trim();
  if (params.remoteHost?.trim() || isSshIMessageCliWrapper(cliPath)) {
    return false;
  }
  return cliPath === "imsg" || path.basename(cliPath) === "imsg";
}

function resolveChatDbLookupPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  const configured = params.dbPath?.trim();
  if (configured) {
    return configured;
  }
  if (!isLocalIMessageCliPath({ cliPath: params.cliPath, remoteHost: params.remoteHost })) {
    return undefined;
  }
  const home = safeHomeDir();
  return home ? path.join(home, "Library", "Messages", "chat.db") : undefined;
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  return await new Promise((resolve, reject) => {
    const child = spawn(cliPath, buildIMessageCliJsonArgs(args, dbPath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const clearTimers = (options: { keepKillEscalation?: boolean } = {}): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killEscalation && !options.keepKillEscalation) {
        clearTimeout(killEscalation);
      }
    };
    const fail = (error: Error, options: { keepKillEscalation?: boolean } = {}): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers(options);
      reject(error);
    };
    const succeed = (value: Record<string, unknown>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve(value);
    };
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
            fail(new Error(`iMessage action timed out after ${timeoutMs}ms`), {
              keepKillEscalation: true,
            });
          }, timeoutMs)
        : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) {
        return;
      }
      const appended = appendIMessageCliStdout(stdout, chunk);
      if (!appended.ok) {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
        fail(new Error(appended.message));
        return;
      }
      stdout = appended.value;
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendIMessageCliStderrTail(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        clearTimers();
        return;
      }
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) {
        clearTimers();
        return;
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
          fail(new Error(failure));
          return;
        }
        succeed(parsed);
        return;
      }
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        fail(new Error(parsed.error.trim()));
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `imsg exited with code ${code}`;
      fail(new Error(detail));
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
  dbPath?: string;
  target: ReturnType<typeof parseIMessageTarget>;
  filePath: string;
  echoText?: string;
  runCliJson: (args: readonly string[]) => Promise<Record<string, unknown>>;
  resolveMessageGuidImpl?: IMessageSendOpts["resolveMessageGuidImpl"];
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
  const approvalBindingMessageId = await resolveApprovalBindingMessageGuid({
    dbPath: params.dbPath,
    messageId: resolvedId,
    result,
    resolveMessageGuidImpl: params.resolveMessageGuidImpl,
  });
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
  const chatDbLookupPath = resolveChatDbLookupPath({
    cliPath,
    dbPath,
    remoteHost: account.config.remoteHost,
  });
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const service =
    opts.service ??
    resolveTargetService(target) ??
    (account.config.service as IMessageService | undefined);
  const timeoutMs = opts.timeoutMs ?? account.config.probeTimeoutMs;
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
    ((args: readonly string[]) => runIMessageCliJson(cliPath, dbPath, args, timeoutMs));

  if (filePath && !message.trim() && !resolvedReplyToId) {
    const attachmentResult = await trySendAttachmentForExplicitChat({
      accountId: account.accountId,
      dbPath: chatDbLookupPath,
      target,
      filePath,
      echoText,
      runCliJson,
      resolveMessageGuidImpl: opts.resolveMessageGuidImpl,
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
  let result: Record<string, unknown>;
  const sendStartedAtMs = Date.now();
  try {
    try {
      result = await client.request<Record<string, unknown>>("send", params, {
        timeoutMs,
      });
    } catch (error) {
      if (filePath || resolvedReplyToId || !isIMessageRpcSendTimeout(error)) {
        throw error;
      }
      if (
        !shouldRecoverApprovalPromptGuid({
          message,
          filePath,
          replyToId: resolvedReplyToId,
        })
      ) {
        throw error;
      }
      const recoveredGuid = await resolveFallbackSentMessageGuid({
        dbPath: chatDbLookupPath,
        target,
        text: message,
        sentAfterMs: sendStartedAtMs,
        resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
      });
      if (!recoveredGuid) {
        throw error;
      }
      result = { guid: recoveredGuid, status: "sent" };
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
        replyToId: resolvedReplyToId,
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
    if (message && approvalBindingMessageId) {
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
