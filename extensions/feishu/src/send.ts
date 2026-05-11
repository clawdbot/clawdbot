import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createFeishuApiError, requestFeishuApi } from "./comment-shared.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent, buildMentionedMessage } from "./mention.js";
import { parsePostContent } from "./post.js";
import {
  assertFeishuMessageApiSuccess,
  resolveFeishuReceiptKind,
  toFeishuSendResult,
} from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import type { FeishuChatType, FeishuMessageInfo, FeishuSendResult } from "./types.js";

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
const INTERACTIVE_CARD_FALLBACK_TEXT = "[Interactive Card]";
const POST_FALLBACK_TEXT = "[Rich text message]";
const FEISHU_CARD_TEMPLATES = new Set([
  "blue",
  "green",
  "red",
  "orange",
  "purple",
  "indigo",
  "wathet",
  "turquoise",
  "yellow",
  "grey",
  "carmine",
  "violet",
  "lime",
]);

function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true;
  }
  const msg = normalizeLowercaseStringOrEmpty(response.msg);
  return msg.includes("withdrawn") || msg.includes("not found");
}

/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  // SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true;
  }
  // AxiosError shape: err.response.data.code
  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response;
  if (
    typeof response?.data?.code === "number" &&
    WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)
  ) {
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type FeishuCreateMessageClient = {
  im: {
    message: {
      reply: (opts: {
        path: { message_id: string };
        data: { content: string; msg_type: string; reply_in_thread?: true };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
      create: (opts: {
        params: { receive_id_type: "chat_id" | "email" | "open_id" | "union_id" | "user_id" };
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

type FeishuMessageSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

type FeishuMessageGetItem = {
  message_id?: string;
  chat_id?: string;
  chat_type?: FeishuChatType;
  thread_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: FeishuMessageSender;
  create_time?: string;
};

type FeishuGetMessageResponse = {
  code?: number;
  msg?: string;
  data?: FeishuMessageGetItem & {
    items?: FeishuMessageGetItem[];
  };
};

/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    receiveId: string;
    receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
    content: string;
    msgType: string;
  },
  errorPrefix: string,
): Promise<FeishuSendResult> {
  const response = await requestFeishuApi(
    () =>
      client.im.message.create({
        params: { receive_id_type: params.receiveIdType },
        data: {
          receive_id: params.receiveId,
          content: params.content,
          msg_type: params.msgType,
        },
      }),
    errorPrefix,
    { includeNestedErrorLogId: true },
  );
  assertFeishuMessageApiSuccess(response, errorPrefix);
  return toFeishuSendResult(response, params.receiveId, resolveFeishuReceiptKind(params.msgType));
}

async function sendReplyOrFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    replyToMessageId?: string;
    replyInThread?: boolean;
    allowTopLevelReplyFallback?: boolean;
    content: string;
    msgType: string;
    directParams: {
      receiveId: string;
      receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
      content: string;
      msgType: string;
    };
    directErrorPrefix: string;
    replyErrorPrefix: string;
  },
): Promise<FeishuSendResult> {
  if (!params.replyToMessageId) {
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }

  const replyTargetFallbackError =
    params.replyInThread && params.allowTopLevelReplyFallback !== true
      ? new Error(
          "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
        )
      : null;

  let response: { code?: number; msg?: string; data?: { message_id?: string } };
  try {
    response = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        content: params.content,
        msg_type: params.msgType,
        ...(params.replyInThread ? { reply_in_thread: true } : {}),
      },
    });
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      throw createFeishuApiError(err, params.replyErrorPrefix, { includeNestedErrorLogId: true });
    }
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  if (shouldFallbackFromReplyTarget(response)) {
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
  return toFeishuSendResult(
    response,
    params.directParams.receiveId,
    resolveFeishuReceiptKind(params.msgType),
  );
}

function normalizeCardTemplateVariable(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readCardTemplateVariables(parsed: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  for (const source of [parsed.template_variable, parsed.template_variables]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeCardTemplateVariable(value);
      if (normalized !== undefined) {
        variables.set(key, normalized);
      }
    }
  }
  return variables;
}

function applyCardTemplateVariables(text: string, variables: Map<string, string>): string {
  if (variables.size === 0) {
    return text;
  }
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
    const variableName = typeof a === "string" ? a : b;
    return variables.get(variableName) ?? match;
  });
}

function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const tag = typeof element.tag === "string" ? element.tag : "";
  const text = isRecord(element.text) ? element.text : undefined;

  if (tag === "div" && typeof text?.content === "string") {
    return applyCardTemplateVariables(text.content, variables);
  }
  if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if (tag === "plain_text" && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  return undefined;
}

function extractInteractiveElementsText(
  elements: unknown[],
  variables: Map<string, string>,
): string {
  const texts: string[] = [];
  for (const element of elements) {
    const text = extractInteractiveElementText(element, variables);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.join("\n").trim();
}

function readInteractiveElementArrays(parsed: Record<string, unknown>): unknown[][] {
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  const elementArrays: unknown[][] = [];

  for (const candidate of [parsed.elements, body?.elements]) {
    if (Array.isArray(candidate)) {
      elementArrays.push(candidate);
    }
  }

  for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const localeElements of Object.values(candidate)) {
      if (Array.isArray(localeElements)) {
        elementArrays.push(localeElements);
      }
    }
  }

  return elementArrays;
}

function parseInteractivePostFallback(parsed: unknown): string | undefined {
  const textContent = parsePostContent(JSON.stringify(parsed)).textContent.trim();
  return textContent && textContent !== POST_FALLBACK_TEXT ? textContent : undefined;
}

function parseInteractiveCardContent(parsed: unknown): string {
  if (!isRecord(parsed)) {
    return INTERACTIVE_CARD_FALLBACK_TEXT;
  }

  const variables = readCardTemplateVariables(parsed);
  for (const elements of readInteractiveElementArrays(parsed)) {
    const text = extractInteractiveElementsText(elements, variables);
    if (text) {
      return text;
    }
  }

  return parseInteractivePostFallback(parsed) ?? INTERACTIVE_CARD_FALLBACK_TEXT;
}

function parseFeishuMessageContent(rawContent: string, msgType: string): string {
  if (!rawContent) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "[Text message]";
  }

  if (msgType === "post") {
    return parsePostContent(rawContent).textContent;
  }

  if (msgType === "interactive") {
    return parseInteractiveCardContent(parsed);
  }

  if (typeof parsed === "string") {
    return parsed;
  }

  const genericText = (parsed as { text?: unknown; title?: unknown } | null)?.text;
  if (typeof genericText === "string" && genericText.trim()) {
    return genericText;
  }
  const genericTitle = (parsed as { title?: unknown } | null)?.title;
  if (typeof genericTitle === "string" && genericTitle.trim()) {
    return genericTitle;
  }

  return `[${msgType || "unknown"} message]`;
}

function parseFeishuMessageItem(
  item: FeishuMessageGetItem,
  fallbackMessageId?: string,
): FeishuMessageInfo {
  const msgType = item.msg_type ?? "text";
  const rawContent = item.body?.content ?? "";

  return {
    messageId: item.message_id ?? fallbackMessageId ?? "",
    chatId: item.chat_id ?? "",
    chatType:
      item.chat_type === "group" ||
      item.chat_type === "topic_group" ||
      item.chat_type === "private" ||
      item.chat_type === "p2p"
        ? item.chat_type
        : undefined,
    senderId: item.sender?.id,
    senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
    senderType: item.sender?.sender_type,
    content: parseFeishuMessageContent(rawContent, msgType),
    contentType: msgType,
    createTime: item.create_time ? Number.parseInt(item.create_time, 10) : undefined,
    threadId: item.thread_id || undefined,
  };
}

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.get({
      path: { message_id: messageId },
    })) as FeishuGetMessageResponse;

    if (response.code !== 0) {
      return null;
    }

    // Support both list shape (data.items[0]) and single-object shape (data as message)
    const rawItem = response.data?.items?.[0] ?? response.data;
    const item =
      rawItem &&
      (rawItem.body !== undefined || (rawItem as { message_id?: string }).message_id !== undefined)
        ? rawItem
        : null;
    if (!item) {
      return null;
    }

    return parseFeishuMessageItem(item, messageId);
  } catch {
    return null;
  }
}

export type FeishuThreadMessageInfo = {
  messageId: string;
  senderId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

/**
 * List messages in a Feishu thread (topic).
 * Uses container_id_type=thread to directly query thread messages,
 * which includes both the root message and all replies (including bot replies).
 */
export async function listFeishuThreadMessages(params: {
  cfg: ClawdbotConfig;
  threadId: string;
  currentMessageId?: string;
  /** Exclude the root message (already provided separately as ThreadStarterBody). */
  rootMessageId?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuThreadMessageInfo[]> {
  const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = (await client.im.message.list({
    params: {
      container_id_type: "thread",
      container_id: threadId,
      // Fetch newest messages first so long threads keep the most recent turns.
      // Results are reversed below to restore chronological order.
      sort_type: "ByCreateTimeDesc",
      page_size: Math.min(limit + 1, 50),
    },
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<
        {
          message_id?: string;
          root_id?: string;
          parent_id?: string;
        } & FeishuMessageGetItem
      >;
    };
  };

  if (response.code !== 0) {
    throw new Error(
      `Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
    );
  }

  const items = response.data?.items ?? [];
  const results: FeishuThreadMessageInfo[] = [];

  for (const item of items) {
    if (currentMessageId && item.message_id === currentMessageId) {
      continue;
    }
    if (rootMessageId && item.message_id === rootMessageId) {
      continue;
    }

    const parsed = parseFeishuMessageItem(item);

    results.push({
      messageId: parsed.messageId,
      senderId: parsed.senderId,
      senderType: parsed.senderType,
      content: parsed.content,
      contentType: parsed.contentType,
      createTime: parsed.createTime,
    });

    if (results.length >= limit) {
      break;
    }
  }

  // Restore chronological order (oldest first) since we fetched newest-first.
  results.reverse();
  return results;
}

export type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

export function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: messageText,
            },
          ],
        ],
      },
    }),
    msgType: "post",
  };
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    mentions,
    accountId,
  } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = text ?? "";
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  const messageText = convertMarkdownTables(rawText, tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const directParams = { receiveId, receiveIdType, content, msgType };
  return sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    content,
    msgType,
    directParams,
    directErrorPrefix: "Feishu send failed",
    replyErrorPrefix: "Feishu reply failed",
  });
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, allowTopLevelReplyFallback, accountId } =
    params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const content = JSON.stringify(card);

  const directParams = { receiveId, receiveIdType, content, msgType: "interactive" };
  return sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    content,
    msgType: "interactive",
    directParams,
    directErrorPrefix: "Feishu card send failed",
    replyErrorPrefix: "Feishu card reply failed",
  });
}

export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text?: string;
  card?: Record<string, unknown>;
  accountId?: string;
}): Promise<{ messageId: string; contentType: "post" | "interactive" }> {
  const { cfg, messageId, text, card, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const hasText = typeof text === "string" && text.trim().length > 0;
  const hasCard = Boolean(card);
  if (hasText === hasCard) {
    throw new Error("Feishu edit requires exactly one of text or card.");
  }

  const client = createFeishuClient(account);

  if (card) {
    const content = JSON.stringify(card);
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
    }

    return { messageId, contentType: "interactive" };
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = convertMarkdownTables(text!, tableMode);
  const payload = buildFeishuPostMessagePayload({ messageText });
  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: payload.content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }

  return { messageId, contentType: "post" };
}

export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const content = JSON.stringify(card);

  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };
}

/** Header configuration for structured Feishu cards. */
export type CardHeaderConfig = {
  /** Header title text, e.g. "💻 Coder" */
  title: string;
  /** Feishu header color template (blue, green, red, orange, purple, grey, etc.). Defaults to "blue". */
  template?: string;
};

export function resolveFeishuCardTemplate(template?: string): string | undefined {
  const normalized = normalizeOptionalLowercaseString(template);
  if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Build a Feishu interactive card with optional header and note footer.
 * When header/note are omitted, behaves identically to buildMarkdownCard.
 */
export function buildStructuredCard(
  text: string,
  options?: {
    header?: CardHeaderConfig;
    note?: string;
  },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content: text }];
  if (options?.note) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<font color='grey'>${options.note}</font>` });
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { width_mode: "fill" },
    body: { elements },
  };
  if (options?.header) {
    card.header = {
      title: { tag: "plain_text", content: options.header.title },
      template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
    };
  }
  return card;
}

/**
 * Send a message as a structured card with optional header and note.
 */
export async function sendStructuredCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  mentions?: MentionTarget[];
  accountId?: string;
  header?: CardHeaderConfig;
  note?: string;
}): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    mentions,
    accountId,
    header,
    note,
  } = params;
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildStructuredCard(cardText, { header, note });
  return sendCardFeishu({
    cfg,
    to,
    card,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    accountId,
  });
}

/**
 * Send a message as a markdown card (interactive message).
 * This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    mentions,
    accountId,
  } = params;
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({
    cfg,
    to,
    card,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    accountId,
  });
}
