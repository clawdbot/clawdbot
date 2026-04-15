import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
import {
  encodeQuery,
  extractReplyText,
  isRecord,
  normalizeString,
  parseCommentContentElements,
  type ParsedCommentContent,
  type ParsedCommentLinkedDocument,
  readString,
} from "./comment-shared.js";
import { normalizeCommentFileType, type CommentFileType } from "./comment-target.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_COMMENT_VERIFY_TIMEOUT_MS = 3_000;
const FEISHU_COMMENT_LIST_PAGE_SIZE = 100;
const FEISHU_COMMENT_LIST_PAGE_LIMIT = 5;
const FEISHU_COMMENT_REPLY_PAGE_SIZE = 100;
const FEISHU_COMMENT_REPLY_PAGE_LIMIT = 5;
const FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS = 1_000;
const FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT = 6;
const FEISHU_COMMENT_THREAD_PROMPT_LIMIT = 20;
const FEISHU_WHOLE_COMMENT_PROMPT_LIMIT = 12;
const FEISHU_PROMPT_TEXT_LIMIT = 220;

type FeishuDriveCommentUserId = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
};

export type FeishuDriveCommentNoticeEvent = {
  comment_id?: string;
  event_id?: string;
  is_mentioned?: boolean;
  notice_meta?: {
    file_token?: string;
    file_type?: string;
    from_user_id?: FeishuDriveCommentUserId;
    notice_type?: string;
    to_user_id?: FeishuDriveCommentUserId;
  };
  reply_id?: string;
  timestamp?: string;
  type?: string;
};

type ResolveDriveCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
  createClient?: (account: ResolvedFeishuAccount) => FeishuRequestClient;
  verificationTimeoutMs?: number;
  logger?: (message: string) => void;
  waitMs?: (ms: number) => Promise<void>;
};

export type ResolvedDriveCommentEventTurn = {
  eventId: string;
  messageId: string;
  commentId: string;
  replyId?: string;
  noticeType: "add_comment" | "add_reply";
  fileToken: string;
  fileType: CommentFileType;
  isWholeComment?: boolean;
  senderId: string;
  senderUserId?: string;
  timestamp?: string;
  isMentioned?: boolean;
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
  prompt: string;
  preview: string;
};

type FeishuRequestClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "GET" | "POST";
    url: string;
    data: unknown;
    timeout: number;
  }): Promise<unknown>;
};

type FeishuOpenApiResponse<T> = {
  code?: number;
  log_id?: string;
  msg?: string;
  data?: T;
};

type FeishuDriveMetaBatchQueryResponse = FeishuOpenApiResponse<{
  metas?: Array<{
    doc_token?: string;
    title?: string;
    url?: string;
  }>;
}>;

type FeishuDriveCommentReply = {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content?: {
    elements?: unknown[];
  };
};

type FeishuDriveCommentCard = {
  comment_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  is_whole?: boolean;
  has_more?: boolean;
  page_token?: string;
  quote?: string;
  reply_list?: {
    replies?: FeishuDriveCommentReply[];
  };
};

type FeishuDriveCommentBatchQueryResponse = FeishuOpenApiResponse<{
  items?: FeishuDriveCommentCard[];
}>;

type FeishuDriveCommentListResponse = FeishuOpenApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentCard[];
  page_token?: string;
}>;

type FeishuDriveCommentRepliesListResponse = FeishuOpenApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentReply[];
  page_token?: string;
}>;

type ResolvedCommentReplyContext = {
  replyId?: string;
  userId?: string;
  createTime?: number;
  isBotAuthored: boolean;
  content: ParsedCommentContent;
};

type ResolvedWholeCommentTimelineEntry = {
  commentId: string;
  userId?: string;
  createTime?: number;
  isCurrentComment: boolean;
  isBotAuthored: boolean;
  content: ParsedCommentContent;
};

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      error: formatErrorMessage(error),
    });
  }
}

function truncatePromptText(
  text: string | undefined,
  maxLength = FEISHU_PROMPT_TEXT_LIMIT,
): string {
  const normalized = normalizeString(text);
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function formatPromptTextValue(text: string | undefined): string {
  return safeJsonStringify(truncatePromptText(text) || "");
}

function formatPromptBoolean(value: boolean | undefined): string {
  return value === true ? "yes" : "no";
}

function buildDriveCommentsListUrl(params: {
  fileToken: string;
  fileType: CommentFileType;
  pageToken?: string;
  isWholeOnly?: boolean;
}): string {
  return (
    `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments` +
    encodeQuery({
      file_type: params.fileType,
      is_whole: params.isWholeOnly === true ? "true" : undefined,
      page_size: String(FEISHU_COMMENT_LIST_PAGE_SIZE),
      page_token: params.pageToken,
      user_id_type: "open_id",
    })
  );
}

function compareCommentTimelineEntries(
  left: { createTime?: number; stableId?: string },
  right: { createTime?: number; stableId?: string },
): number {
  const leftTime = left.createTime ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.createTime ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (left.stableId ?? "").localeCompare(right.stableId ?? "");
}

function formatLinkedDocumentInline(link: ParsedCommentLinkedDocument): string {
  const parts = [
    `raw_url=${link.rawUrl}`,
    `url_kind=${link.urlKind}`,
    link.wikiNodeToken ? `wiki_node_token=${link.wikiNodeToken}` : null,
    `resolved_type=${link.resolvedObjType ?? "UNKNOWN"}`,
    `resolved_token=${link.resolvedObjToken ?? "UNKNOWN"}`,
    `same_as_current_document=${formatPromptBoolean(link.isCurrentDocument)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

function formatLinkedDocumentsPromptLines(params: {
  title: string;
  linkedDocuments: ParsedCommentLinkedDocument[];
}): string[] {
  if (params.linkedDocuments.length === 0) {
    return [];
  }
  return [
    params.title,
    ...params.linkedDocuments.map(
      (link, index) => `- [${index + 1}] ${formatLinkedDocumentInline(link)}`,
    ),
  ];
}

function formatLinkedDocumentsInlineSummary(
  linkedDocuments: ParsedCommentLinkedDocument[],
): string {
  if (linkedDocuments.length === 0) {
    return "none";
  }
  return linkedDocuments
    .map(
      (link) =>
        `${link.resolvedObjType ?? link.urlKind}:${link.resolvedObjToken ?? link.wikiNodeToken ?? "UNKNOWN"}`,
    )
    .join(",");
}

function summarizeCommentRepliesForLog(replies: FeishuDriveCommentReply[]): string {
  return safeJsonStringify(
    replies.map((reply) => ({
      reply_id: reply.reply_id,
      text_len: extractReplyText(reply)?.length ?? 0,
    })),
  );
}

async function resolveParsedCommentContent(params: {
  elements?: unknown[];
  botOpenIds?: Iterable<string | undefined>;
  currentDocument: {
    fileType: CommentFileType;
    fileToken: string;
  };
  client: FeishuRequestClient;
  wikiCache: Map<
    string,
    Promise<{
      resolvedObjType?: CommentFileType;
      resolvedObjToken?: string;
    } | null>
  >;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<ParsedCommentContent> {
  const parsed = parseCommentContentElements({
    elements: params.elements,
    botOpenIds: params.botOpenIds,
    currentDocument: params.currentDocument,
  });
  if (!parsed.linkedDocuments.some((link) => link.urlKind === "wiki" && link.wikiNodeToken)) {
    return parsed;
  }

  const resolvedLinkedDocuments = await Promise.all(
    parsed.linkedDocuments.map(async (link) => {
      if (link.urlKind !== "wiki" || !link.wikiNodeToken) {
        return link;
      }
      let pending = params.wikiCache.get(link.wikiNodeToken);
      if (!pending) {
        pending = params.client.wiki.space
          .getNode({
            params: {
              token: link.wikiNodeToken,
            },
          })
          .then((response) => {
            if (response.code !== 0) {
              params.logger?.(
                `feishu[${params.accountId}]: wiki link resolution failed token=${link.wikiNodeToken} ` +
                  `code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"}`,
              );
              return null;
            }
            const objType = normalizeCommentFileType(response.data?.node?.obj_type);
            const objToken = normalizeString(response.data?.node?.obj_token);
            if (!objType || !objToken) {
              return null;
            }
            return {
              resolvedObjType: objType,
              resolvedObjToken: objToken,
            };
          })
          .catch((error) => {
            params.logger?.(
              `feishu[${params.accountId}]: wiki link resolution threw token=${link.wikiNodeToken} error=${formatErrorMessage(error)}`,
            );
            return null;
          });
        params.wikiCache.set(link.wikiNodeToken, pending);
      }
      const resolved = await pending;
      if (!resolved) {
        return link;
      }
      return {
        ...link,
        resolvedObjType: resolved.resolvedObjType,
        resolvedObjToken: resolved.resolvedObjToken,
        isCurrentDocument:
          resolved.resolvedObjType === params.currentDocument.fileType &&
          resolved.resolvedObjToken === params.currentDocument.fileToken,
      };
    }),
  );

  return {
    ...parsed,
    linkedDocuments: resolvedLinkedDocuments,
  };
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDriveCommentTargetUrl(params: {
  fileToken: string;
  fileType: CommentFileType;
}): string {
  return (
    `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments/batch_query` +
    encodeQuery({
      file_type: params.fileType,
      user_id_type: "open_id",
    })
  );
}

function buildDriveCommentRepliesUrl(params: {
  fileToken: string;
  commentId: string;
  fileType: CommentFileType;
  pageToken?: string;
}): string {
  return (
    `/open-apis/drive/v1/files/${encodeURIComponent(params.fileToken)}/comments/${encodeURIComponent(
      params.commentId,
    )}/replies` +
    encodeQuery({
      file_type: params.fileType,
      page_token: params.pageToken,
      page_size: String(FEISHU_COMMENT_REPLY_PAGE_SIZE),
      user_id_type: "open_id",
    })
  );
}

async function fetchDriveComments(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  isWholeOnly?: boolean;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<FeishuDriveCommentCard[]> {
  const comments: FeishuDriveCommentCard[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < FEISHU_COMMENT_LIST_PAGE_LIMIT; page += 1) {
    const response = await requestFeishuOpenApi<FeishuDriveCommentListResponse>({
      client: params.client,
      method: "GET",
      url: buildDriveCommentsListUrl({
        fileToken: params.fileToken,
        fileType: params.fileType,
        isWholeOnly: params.isWholeOnly,
        pageToken,
      }),
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to list drive comments for ${params.fileToken}`,
    });
    if (response?.code !== 0) {
      if (response) {
        params.logger?.(
          `feishu[${params.accountId}]: failed to list drive comments for ${params.fileToken}: ` +
            `${response.msg ?? "unknown error"} log_id=${response.log_id?.trim() || "unknown"}`,
        );
      }
      break;
    }
    comments.push(...(response.data?.items ?? []));
    if (response.data?.has_more !== true || !response.data.page_token?.trim()) {
      break;
    }
    pageToken = response.data.page_token.trim();
  }
  return comments;
}

async function requestFeishuOpenApi<T>(params: {
  client: FeishuRequestClient;
  method: "GET" | "POST";
  url: string;
  data?: unknown;
  timeoutMs: number;
  logger?: (message: string) => void;
  errorLabel: string;
}): Promise<T | null> {
  const formatErrorDetails = (error: unknown): string => {
    if (!isRecord(error)) {
      return typeof error === "string" ? error : JSON.stringify(error);
    }
    const response = isRecord(error.response) ? error.response : undefined;
    const responseData = isRecord(response?.data) ? response?.data : undefined;
    const details = {
      message:
        typeof error.message === "string"
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error),
      code: readString(error.code),
      method: readString(isRecord(error.config) ? error.config.method : undefined),
      url: readString(isRecord(error.config) ? error.config.url : undefined),
      http_status: typeof response?.status === "number" ? response.status : undefined,
      feishu_code:
        typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
      feishu_msg: readString(responseData?.msg),
      feishu_log_id: readString(responseData?.log_id),
    };
    return safeJsonStringify(details);
  };

  const result = await raceWithTimeoutAndAbort(
    params.client.request({
      method: params.method,
      url: params.url,
      data: params.data ?? {},
      timeout: params.timeoutMs,
    }),
    { timeoutMs: params.timeoutMs },
  )
    .then((resolved) => (resolved.status === "resolved" ? resolved.value : null))
    .catch((error) => {
      params.logger?.(`${params.errorLabel}: ${formatErrorDetails(error)}`);
      return null;
    });
  if (!result) {
    params.logger?.(`${params.errorLabel}: request timed out or returned no data`);
  }
  return result;
}

async function fetchDriveCommentReplies(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<{ replies: FeishuDriveCommentReply[]; logIds: string[] }> {
  const replies: FeishuDriveCommentReply[] = [];
  const logIds: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < FEISHU_COMMENT_REPLY_PAGE_LIMIT; page += 1) {
    const response = await requestFeishuOpenApi<FeishuDriveCommentRepliesListResponse>({
      client: params.client,
      method: "GET",
      url: buildDriveCommentRepliesUrl({
        fileToken: params.fileToken,
        commentId: params.commentId,
        fileType: params.fileType,
        pageToken,
      }),
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}`,
    });
    if (response?.log_id?.trim()) {
      logIds.push(response.log_id.trim());
    }
    if (response?.code !== 0) {
      if (response) {
        params.logger?.(
          `feishu[${params.accountId}]: failed to fetch comment replies for ${params.commentId}: ` +
            `${response.msg ?? "unknown error"} ` +
            `log_id=${response.log_id?.trim() || "unknown"}`,
        );
      }
      break;
    }
    replies.push(...(response.data?.items ?? []));
    if (response.data?.has_more !== true || !response.data.page_token?.trim()) {
      break;
    }
    pageToken = response.data.page_token.trim();
  }
  return { replies, logIds };
}

async function resolveCommentReplyContext(params: {
  reply: FeishuDriveCommentReply;
  botOpenIds?: Iterable<string | undefined>;
  currentDocument: {
    fileType: CommentFileType;
    fileToken: string;
  };
  client: FeishuRequestClient;
  wikiCache: Map<
    string,
    Promise<{
      resolvedObjType?: CommentFileType;
      resolvedObjToken?: string;
    } | null>
  >;
  logger?: (message: string) => void;
  accountId: string;
}): Promise<ResolvedCommentReplyContext> {
  const userId = normalizeString(params.reply.user_id);
  const normalizedBotOpenIds = new Set(
    Array.from(params.botOpenIds ?? [])
      .map((botId) => normalizeString(botId))
      .filter((botId): botId is string => Boolean(botId)),
  );
  return {
    replyId: normalizeString(params.reply.reply_id),
    userId,
    createTime: typeof params.reply.create_time === "number" ? params.reply.create_time : undefined,
    isBotAuthored: typeof userId === "string" && normalizedBotOpenIds.has(userId),
    content: await resolveParsedCommentContent({
      elements: isRecord(params.reply.content) ? params.reply.content.elements : undefined,
      botOpenIds: params.botOpenIds,
      currentDocument: params.currentDocument,
      client: params.client,
      wikiCache: params.wikiCache,
      logger: params.logger,
      accountId: params.accountId,
    }),
  };
}

function selectCommentThreadPromptReplies(
  replies: ResolvedCommentReplyContext[],
  targetReplyId?: string,
): ResolvedCommentReplyContext[] {
  if (replies.length <= FEISHU_COMMENT_THREAD_PROMPT_LIMIT) {
    return replies;
  }
  const targetIndex = replies.findIndex((reply) => reply.replyId === targetReplyId);
  const currentIndex = targetIndex >= 0 ? targetIndex : replies.length - 1;
  const selected = new Set<number>([0, currentIndex, replies.length - 1]);
  for (let radius = 1; selected.size < FEISHU_COMMENT_THREAD_PROMPT_LIMIT; radius += 1) {
    const before = currentIndex - radius;
    const after = currentIndex + radius;
    if (before >= 0) {
      selected.add(before);
    }
    if (selected.size >= FEISHU_COMMENT_THREAD_PROMPT_LIMIT) {
      break;
    }
    if (after < replies.length) {
      selected.add(after);
    }
    if (before < 0 && after >= replies.length) {
      break;
    }
  }
  return [...selected]
    .toSorted((left, right) => left - right)
    .map((index) => replies[index])
    .filter((reply): reply is ResolvedCommentReplyContext => Boolean(reply));
}

function formatCommentThreadPromptLines(params: {
  replies: ResolvedCommentReplyContext[];
  targetReplyId?: string;
}): string[] {
  const promptReplies = selectCommentThreadPromptReplies(params.replies, params.targetReplyId);
  return promptReplies.map((reply, index) => {
    const text = reply.content.semanticText ?? reply.content.plainText;
    return (
      `- [${index + 1}] author=${reply.isBotAuthored ? "assistant" : "user"} ` +
      `user_id=${reply.userId ?? "UNKNOWN"} ` +
      `reply_id=${reply.replyId ?? "UNKNOWN"} ` +
      `current_event=${reply.replyId === params.targetReplyId ? "yes" : "no"} ` +
      `text=${formatPromptTextValue(text)} ` +
      `referenced_docs=${formatLinkedDocumentsInlineSummary(reply.content.linkedDocuments)}`
    );
  });
}

function findNearestBotTimelineEntry(params: {
  entries: ResolvedWholeCommentTimelineEntry[];
  currentIndex: number;
  direction: "before" | "after";
}): ResolvedWholeCommentTimelineEntry | undefined {
  const step = params.direction === "after" ? 1 : -1;
  for (
    let index = params.currentIndex + step;
    index >= 0 && index < params.entries.length;
    index += step
  ) {
    const candidate = params.entries[index];
    if (candidate?.isBotAuthored) {
      return candidate;
    }
  }
  return undefined;
}

function selectWholeCommentTimelineEntries(params: {
  entries: ResolvedWholeCommentTimelineEntry[];
  currentCommentId: string;
}): ResolvedWholeCommentTimelineEntry[] {
  if (params.entries.length <= FEISHU_WHOLE_COMMENT_PROMPT_LIMIT) {
    return params.entries;
  }
  const currentIndex = params.entries.findIndex(
    (entry) => entry.commentId === params.currentCommentId,
  );
  if (currentIndex < 0) {
    return params.entries.slice(-FEISHU_WHOLE_COMMENT_PROMPT_LIMIT);
  }
  const selected = new Set<number>([currentIndex]);
  const nearestBotAfter = params.entries.findIndex(
    (entry, index) => index > currentIndex && entry.isBotAuthored,
  );
  if (nearestBotAfter >= 0) {
    selected.add(nearestBotAfter);
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (params.entries[index]?.isBotAuthored) {
      selected.add(index);
      break;
    }
  }
  for (let radius = 1; selected.size < FEISHU_WHOLE_COMMENT_PROMPT_LIMIT; radius += 1) {
    const before = currentIndex - radius;
    const after = currentIndex + radius;
    if (before >= 0) {
      selected.add(before);
    }
    if (selected.size >= FEISHU_WHOLE_COMMENT_PROMPT_LIMIT) {
      break;
    }
    if (after < params.entries.length) {
      selected.add(after);
    }
    if (before < 0 && after >= params.entries.length) {
      break;
    }
  }
  return [...selected]
    .toSorted((left, right) => left - right)
    .map((index) => params.entries[index])
    .filter((entry): entry is ResolvedWholeCommentTimelineEntry => Boolean(entry));
}

function formatWholeCommentTimelinePromptLines(params: {
  entries: ResolvedWholeCommentTimelineEntry[];
  currentCommentId: string;
}): string[] {
  return selectWholeCommentTimelineEntries(params).map((entry, index) => {
    const text = entry.content.semanticText ?? entry.content.plainText;
    return (
      `- [${index + 1}] create_time=${entry.createTime ?? "UNKNOWN"} ` +
      `comment_id=${entry.commentId} ` +
      `author=${entry.isBotAuthored ? "assistant" : "user"} ` +
      `user_id=${entry.userId ?? "UNKNOWN"} ` +
      `current_comment=${entry.commentId === params.currentCommentId ? "yes" : "no"} ` +
      `text=${formatPromptTextValue(text)} ` +
      `referenced_docs=${formatLinkedDocumentsInlineSummary(entry.content.linkedDocuments)}`
    );
  });
}

async function fetchDriveCommentContext(params: {
  client: FeishuRequestClient;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  replyId?: string;
  botOpenIds?: Iterable<string | undefined>;
  timeoutMs: number;
  logger?: (message: string) => void;
  accountId: string;
  waitMs: (ms: number) => Promise<void>;
}): Promise<{
  documentTitle?: string;
  documentUrl?: string;
  isWholeComment?: boolean;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
  rootCommentContent?: ParsedCommentContent;
  targetReplyContent?: ParsedCommentContent;
  currentCommentThreadReplies: ResolvedCommentReplyContext[];
  wholeCommentTimeline: ResolvedWholeCommentTimelineEntry[];
  nearestBotWholeCommentAfter?: ResolvedWholeCommentTimelineEntry;
  nearestBotWholeCommentBefore?: ResolvedWholeCommentTimelineEntry;
}> {
  const [metaResponse, commentResponse] = await Promise.all([
    requestFeishuOpenApi<FeishuDriveMetaBatchQueryResponse>({
      client: params.client,
      method: "POST",
      url: "/open-apis/drive/v1/metas/batch_query",
      data: {
        request_docs: [{ doc_token: params.fileToken, doc_type: params.fileType }],
        with_url: true,
      },
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch drive metadata for ${params.fileToken}`,
    }),
    requestFeishuOpenApi<FeishuDriveCommentBatchQueryResponse>({
      client: params.client,
      method: "POST",
      url: buildDriveCommentTargetUrl({
        fileToken: params.fileToken,
        fileType: params.fileType,
      }),
      data: {
        comment_ids: [params.commentId],
      },
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      errorLabel: `feishu[${params.accountId}]: failed to fetch drive comment ${params.commentId}`,
    }),
  ]);
  const wikiCache = new Map<
    string,
    Promise<{
      resolvedObjType?: CommentFileType;
      resolvedObjToken?: string;
    } | null>
  >();

  const commentCard =
    commentResponse?.code === 0
      ? (commentResponse.data?.items ?? []).find(
          (item) => item.comment_id?.trim() === params.commentId,
        )
      : undefined;
  const embeddedReplies = commentCard?.reply_list?.replies ?? [];
  params.logger?.(
    `feishu[${params.accountId}]: embedded comment replies comment=${params.commentId} ` +
      `count=${embeddedReplies.length} summary=${summarizeCommentRepliesForLog(embeddedReplies)}`,
  );
  const embeddedTargetReply = params.replyId
    ? embeddedReplies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : embeddedReplies.at(-1);

  let replies = embeddedReplies;
  let fetchedMatchedReply = params.replyId
    ? replies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
    : undefined;
  const needsExtraReplies =
    !embeddedTargetReply || replies.length === 0 || commentCard?.has_more === true;
  if (needsExtraReplies) {
    params.logger?.(
      `feishu[${params.accountId}]: fetching extra comment replies comment=${params.commentId} ` +
        `requested_reply=${params.replyId ?? "none"} ` +
        `embedded_count=${embeddedReplies.length} ` +
        `embedded_hit=${embeddedTargetReply ? "yes" : "no"} ` +
        `embedded_has_more=${commentCard?.has_more === true ? "yes" : "no"}`,
    );
    const fetched = await fetchDriveCommentReplies(params);
    if (fetched.replies.length > 0) {
      params.logger?.(
        `feishu[${params.accountId}]: fetched extra comment replies comment=${params.commentId} ` +
          `count=${fetched.replies.length} ` +
          `log_ids=${safeJsonStringify(fetched.logIds)} ` +
          `summary=${summarizeCommentRepliesForLog(fetched.replies)}`,
      );
      replies = fetched.replies;
      fetchedMatchedReply = params.replyId
        ? replies.find((reply) => reply.reply_id?.trim() === params.replyId?.trim())
        : undefined;
    }
    if (params.replyId && !embeddedTargetReply && !fetchedMatchedReply) {
      for (let attempt = 1; attempt <= FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT; attempt += 1) {
        params.logger?.(
          `feishu[${params.accountId}]: retrying comment reply lookup comment=${params.commentId} ` +
            `requested_reply=${params.replyId} attempt=${attempt}/${FEISHU_COMMENT_REPLY_MISS_RETRY_LIMIT} ` +
            `delay_ms=${FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS}`,
        );
        await params.waitMs(FEISHU_COMMENT_REPLY_MISS_RETRY_DELAY_MS);
        const retried = await fetchDriveCommentReplies(params);
        if (retried.replies.length > 0) {
          params.logger?.(
            `feishu[${params.accountId}]: fetched retried comment replies comment=${params.commentId} ` +
              `attempt=${attempt} count=${retried.replies.length} ` +
              `log_ids=${safeJsonStringify(retried.logIds)} ` +
              `summary=${summarizeCommentRepliesForLog(retried.replies)}`,
          );
          replies = retried.replies;
        }
        fetchedMatchedReply = replies.find((reply) => reply.reply_id?.trim() === params.replyId);
        if (fetchedMatchedReply) {
          break;
        }
      }
    }
  }

  const rootReply = replies[0] ?? embeddedReplies[0];
  const targetReply = params.replyId
    ? (embeddedTargetReply ?? fetchedMatchedReply ?? undefined)
    : (replies.at(-1) ?? embeddedTargetReply ?? rootReply);
  const matchSource = params.replyId
    ? embeddedTargetReply
      ? "embedded"
      : fetchedMatchedReply
        ? "fetched"
        : "miss"
    : targetReply === rootReply
      ? "fallback_root"
      : targetReply === embeddedTargetReply
        ? "embedded_latest"
        : "fetched_latest";
  params.logger?.(
    `feishu[${params.accountId}]: comment reply resolution comment=${params.commentId} ` +
      `requested_reply=${params.replyId ?? "none"} match_source=${matchSource} ` +
      `root=${safeJsonStringify({ reply_id: rootReply?.reply_id, text_len: extractReplyText(rootReply)?.length ?? 0 })} ` +
      `target=${safeJsonStringify({ reply_id: targetReply?.reply_id, text_len: extractReplyText(targetReply)?.length ?? 0 })}`,
  );
  const meta = metaResponse?.code === 0 ? metaResponse.data?.metas?.[0] : undefined;
  const currentDocument = {
    fileType: params.fileType,
    fileToken: params.fileToken,
  };
  const resolvedReplies = await Promise.all(
    replies.map((reply) =>
      resolveCommentReplyContext({
        reply,
        botOpenIds: params.botOpenIds,
        currentDocument,
        client: params.client,
        wikiCache,
        logger: params.logger,
        accountId: params.accountId,
      }),
    ),
  );
  resolvedReplies.sort((left, right) =>
    compareCommentTimelineEntries(
      {
        createTime: left.createTime,
        stableId: left.replyId,
      },
      {
        createTime: right.createTime,
        stableId: right.replyId,
      },
    ),
  );
  const rootReplyContext =
    resolvedReplies.find((reply) => reply.replyId === normalizeString(rootReply?.reply_id)) ??
    resolvedReplies[0];
  const targetReplyContext =
    resolvedReplies.find((reply) => reply.replyId === normalizeString(targetReply?.reply_id)) ??
    (params.replyId ? undefined : (resolvedReplies.at(-1) ?? rootReplyContext));

  let wholeCommentTimeline: ResolvedWholeCommentTimelineEntry[] = [];
  if (commentCard?.is_whole === true) {
    const allComments = await fetchDriveComments({
      client: params.client,
      fileToken: params.fileToken,
      fileType: params.fileType,
      isWholeOnly: true,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      accountId: params.accountId,
    });
    const wholeComments = allComments.filter((comment) => comment.is_whole === true);
    wholeCommentTimeline = await Promise.all(
      wholeComments.map(async (comment) => {
        const rootWholeReply = comment.reply_list?.replies?.[0];
        const normalizedBotOpenIds = new Set(
          Array.from(params.botOpenIds ?? [])
            .map((botId) => normalizeString(botId))
            .filter((botId): botId is string => Boolean(botId)),
        );
        const content = await resolveParsedCommentContent({
          elements: isRecord(rootWholeReply?.content) ? rootWholeReply.content.elements : undefined,
          botOpenIds: params.botOpenIds,
          currentDocument,
          client: params.client,
          wikiCache,
          logger: params.logger,
          accountId: params.accountId,
        });
        const commentUserId =
          normalizeString(rootWholeReply?.user_id) || normalizeString(comment.user_id);
        return {
          commentId: normalizeString(comment.comment_id) ?? "",
          userId: commentUserId,
          createTime:
            typeof comment.create_time === "number"
              ? comment.create_time
              : typeof rootWholeReply?.create_time === "number"
                ? rootWholeReply.create_time
                : undefined,
          isCurrentComment: normalizeString(comment.comment_id) === params.commentId,
          isBotAuthored:
            typeof commentUserId === "string" && normalizedBotOpenIds.has(commentUserId),
          content,
        };
      }),
    );
    wholeCommentTimeline = wholeCommentTimeline
      .filter((entry) => Boolean(entry.commentId))
      .toSorted((left, right) =>
        compareCommentTimelineEntries(
          {
            createTime: left.createTime,
            stableId: left.commentId,
          },
          {
            createTime: right.createTime,
            stableId: right.commentId,
          },
        ),
      );
  }

  const currentWholeCommentIndex = wholeCommentTimeline.findIndex(
    (entry) => entry.commentId === params.commentId,
  );

  return {
    documentTitle: normalizeString(meta?.title),
    documentUrl: normalizeString(meta?.url),
    isWholeComment: commentCard?.is_whole,
    quoteText: normalizeString(commentCard?.quote),
    rootCommentText: rootReplyContext?.content.semanticText ?? rootReplyContext?.content.plainText,
    targetReplyText:
      targetReplyContext?.content.semanticText ?? targetReplyContext?.content.plainText,
    rootCommentContent: rootReplyContext?.content,
    targetReplyContent: targetReplyContext?.content,
    currentCommentThreadReplies: resolvedReplies,
    wholeCommentTimeline,
    nearestBotWholeCommentAfter:
      currentWholeCommentIndex >= 0
        ? findNearestBotTimelineEntry({
            entries: wholeCommentTimeline,
            currentIndex: currentWholeCommentIndex,
            direction: "after",
          })
        : undefined,
    nearestBotWholeCommentBefore:
      currentWholeCommentIndex >= 0
        ? findNearestBotTimelineEntry({
            entries: wholeCommentTimeline,
            currentIndex: currentWholeCommentIndex,
            direction: "before",
          })
        : undefined,
  };
}

function buildDriveCommentSurfacePrompt(params: {
  noticeType: "add_comment" | "add_reply";
  fileType: CommentFileType;
  fileToken: string;
  commentId: string;
  replyId?: string;
  isWholeComment?: boolean;
  isMentioned?: boolean;
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
  rootCommentContent?: ParsedCommentContent;
  targetReplyContent?: ParsedCommentContent;
  currentCommentThreadReplies: ResolvedCommentReplyContext[];
  wholeCommentTimeline: ResolvedWholeCommentTimelineEntry[];
  nearestBotWholeCommentAfter?: ResolvedWholeCommentTimelineEntry;
  nearestBotWholeCommentBefore?: ResolvedWholeCommentTimelineEntry;
}): string {
  const documentLabel = params.documentTitle
    ? `"${params.documentTitle}"`
    : `${params.fileType} document ${params.fileToken}`;
  const actionLabel = params.noticeType === "add_reply" ? "reply" : "comment";
  const firstLine = `The user added a ${actionLabel} in ${documentLabel}.`;
  const lines = [firstLine];
  if (params.targetReplyText) {
    lines.push(`Current user comment text: ${formatPromptTextValue(params.targetReplyText)}`);
  }
  if (
    params.noticeType === "add_reply" &&
    params.rootCommentText &&
    params.rootCommentText !== params.targetReplyText
  ) {
    lines.push(`Original comment text: ${formatPromptTextValue(params.rootCommentText)}`);
  }
  if (params.quoteText) {
    lines.push(`Quoted content: ${formatPromptTextValue(params.quoteText)}`);
  }
  if (params.isMentioned === true) {
    lines.push("This comment mentioned you.");
  }
  if (params.documentUrl) {
    lines.push(`Document link: ${params.documentUrl}`);
  }
  lines.push(
    "Current commented document:",
    `- file_type=${params.fileType}`,
    `- file_token=${params.fileToken}`,
  );
  if (params.documentTitle) {
    lines.push(`- title=${params.documentTitle}`);
  }
  if (params.documentUrl) {
    lines.push(`- url=${params.documentUrl}`);
  }
  lines.push(
    `Event type: ${params.noticeType}`,
    `file_token: ${params.fileToken}`,
    `file_type: ${params.fileType}`,
    `comment_id: ${params.commentId}`,
  );
  if (params.isWholeComment === true) {
    lines.push("This is a whole-document comment.");
  }
  if (params.replyId?.trim()) {
    lines.push(`reply_id: ${params.replyId.trim()}`);
  }
  if (params.targetReplyContent?.semanticText) {
    lines.push(
      `Current user comment semantic text: ${formatPromptTextValue(
        params.targetReplyContent.semanticText,
      )}`,
    );
  }
  if (params.targetReplyContent?.botMentioned) {
    lines.push(
      "Bot routing mention detected in the current user comment. Treat that mention as routing only, not task content.",
    );
  }
  const nonBotMentions = (params.targetReplyContent?.mentions ?? [])
    .filter((mention) => !mention.isBotMention)
    .map((mention) => mention.displayText);
  if (nonBotMentions.length > 0) {
    lines.push(`Other mentioned users in current comment: ${nonBotMentions.join(", ")}`);
  }
  lines.push(
    ...formatLinkedDocumentsPromptLines({
      title: "Referenced documents from current user comment:",
      linkedDocuments: params.targetReplyContent?.linkedDocuments ?? [],
    }),
  );
  if (!params.isWholeComment && params.currentCommentThreadReplies.length > 0) {
    lines.push(
      "Current comment card timeline (primary context for follow-ups on this comment card):",
      ...formatCommentThreadPromptLines({
        replies: params.currentCommentThreadReplies,
        targetReplyId: params.replyId,
      }),
      "For this non-whole comment, use the current comment card timeline above as the primary source for phrases like 'above', 'previous result', 'that summary', or 'insert it'.",
      "Document-level session history is auxiliary background only. Do not use another comment card's recent output as the primary referent.",
    );
  }
  if (params.isWholeComment && params.wholeCommentTimeline.length > 0) {
    lines.push(
      "Whole-document comment timeline (primary context for whole-comment follow-ups):",
      ...formatWholeCommentTimelinePromptLines({
        entries: params.wholeCommentTimeline,
        currentCommentId: params.commentId,
      }),
    );
    if (params.nearestBotWholeCommentAfter) {
      lines.push(
        `Nearest bot-authored whole-comment after the current comment: comment_id=${params.nearestBotWholeCommentAfter.commentId} text=${formatPromptTextValue(
          params.nearestBotWholeCommentAfter.content.semanticText ??
            params.nearestBotWholeCommentAfter.content.plainText,
        )}`,
      );
    }
    if (params.nearestBotWholeCommentBefore) {
      lines.push(
        `Nearest bot-authored whole-comment before the current comment: comment_id=${params.nearestBotWholeCommentBefore.commentId} text=${formatPromptTextValue(
          params.nearestBotWholeCommentBefore.content.semanticText ??
            params.nearestBotWholeCommentBefore.content.plainText,
        )}`,
      );
    }
    lines.push(
      "For this whole-document comment, use the whole-comment timeline above as the primary source for phrases like 'just now', 'previous result', 'that summary', or 'write it back'.",
      "Document-level session history is auxiliary background only. Do not resolve whole-comment follow-ups by blindly using the most recent document-session output.",
    );
  }
  lines.push(
    "This is a Feishu document comment thread.",
    "It is not a Feishu IM chat.",
    "Your final text reply will be posted to the current comment thread automatically.",
    "Use the thread timeline above as the main context for follow-up requests.",
    "Do not use another comment card or document-session output as the main reference.",
    "If you need comment thread context, use feishu_drive.list_comments or feishu_drive.list_comment_replies.",
    "If you modify the document, post a user-visible follow-up in the comment thread.",
    "Use feishu_drive.reply_comment or feishu_drive.add_comment for that follow-up.",
    "Whole-document comments do not support direct replies.",
    "For whole-document comments, use feishu_drive.add_comment.",
    'Only treat URLs listed under "Referenced documents from current user comment" as structured Feishu document references.',
    "URLs that appear only in comment text are plain links unless you verify them.",
    "If the user asks about a linked Feishu document or wiki page, treat that linked document as the read target.",
    "If the user asks you to use a linked document as guidance, treat the linked document as the reference source and the current commented document as the edit target.",
    "If a referenced document resolves to the same file_token and file_type as the current commented document, treat it as the current document.",
    "If the user asks you to modify document content, you must use feishu_doc to make the change.",
    'Do not reply with only "done", "I\'ll handle it", or a restated plan without calling tools.',
    "If the comment quotes document content, treat the quoted content as the main anchor.",
    'For requests like "insert xxx below this content", locate the quoted content first, then edit the document.',
    'For requests like "summarize the content below", "explain this section", or "continue writing from here", use the quoted content as the main target.',
    "If the quote is not enough, use feishu_doc.read or feishu_doc.list_blocks to read nearby context.",
    "Do not guess document content from the comment alone.",
    "Do not give a vague answer before reading enough context.",
    "Unless the user asks for the whole document, handle only the local content around the quoted anchor.",
    "If document edits are involved, read the anchor first, then edit.",
    "If the edit fails or the anchor cannot be found, say so clearly.",
    "If this is a reading task, such as summarization, explanation, or extraction, you may output the final answer directly after confirming the context.",
    "Use the same language as the user's comment or reply, unless the user asks for another language.",
    "Use plain text only.",
    "Do not use Markdown.",
    "Do not use headings.",
    "Do not use bullet lists.",
    "Do not use numbered lists.",
    "Do not use tables.",
    "Do not use blockquotes.",
    "Do not use code blocks.",
    "Do not show reasoning.",
    "Do not show analysis.",
    "Do not show chain-of-thought.",
    "Do not show scratch work.",
    "Do not describe your plan.",
    "Do not describe your steps.",
    "Do not describe tool use.",
    'Do not start with phrases like "I will", "I’ll first", "I need to", "The user wants", or "I have updated".',
    "Output only the final user-facing reply.",
    "If you already sent the user-visible reply with feishu_drive.reply_comment or feishu_drive.add_comment, output exactly NO_REPLY.",
    "If no user-visible reply is needed, output exactly NO_REPLY.",
    "Be concise.",
    "Do not omit requested content.",
  );
  lines.push(
    "Choose one outcome: output the final plain-text reply, edit the document and then post a user-visible follow-up in the comment thread, or output exactly NO_REPLY.",
  );
  return lines.join("\n");
}

async function resolveDriveCommentEventCore(params: ResolveDriveCommentEventParams): Promise<{
  eventId: string;
  commentId: string;
  replyId?: string;
  noticeType: "add_comment" | "add_reply";
  fileToken: string;
  fileType: CommentFileType;
  isWholeComment?: boolean;
  senderId: string;
  senderUserId?: string;
  timestamp?: string;
  isMentioned?: boolean;
  context: {
    documentTitle?: string;
    documentUrl?: string;
    quoteText?: string;
    rootCommentText?: string;
    targetReplyText?: string;
    rootCommentContent?: ParsedCommentContent;
    targetReplyContent?: ParsedCommentContent;
    currentCommentThreadReplies: ResolvedCommentReplyContext[];
    wholeCommentTimeline: ResolvedWholeCommentTimelineEntry[];
    nearestBotWholeCommentAfter?: ResolvedWholeCommentTimelineEntry;
    nearestBotWholeCommentBefore?: ResolvedWholeCommentTimelineEntry;
  };
} | null> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    createClient = (account) => createFeishuClient(account) as FeishuRequestClient,
    verificationTimeoutMs = FEISHU_COMMENT_VERIFY_TIMEOUT_MS,
    logger,
    waitMs = delayMs,
  } = params;
  const eventId = event.event_id?.trim();
  const commentId = event.comment_id?.trim();
  const replyId = event.reply_id?.trim();
  const noticeType = event.notice_meta?.notice_type?.trim();
  const fileToken = event.notice_meta?.file_token?.trim();
  const fileType = normalizeCommentFileType(event.notice_meta?.file_type);
  const senderId = event.notice_meta?.from_user_id?.open_id?.trim();
  const senderUserId = normalizeString(event.notice_meta?.from_user_id?.user_id);
  if (!eventId || !commentId || !noticeType || !fileToken || !fileType || !senderId) {
    logger?.(
      `feishu[${accountId}]: drive comment notice missing required fields event=${eventId ?? "unknown"} comment=${commentId ?? "unknown"}`,
    );
    return null;
  }
  if (noticeType !== "add_comment" && noticeType !== "add_reply") {
    logger?.(`feishu[${accountId}]: unsupported drive comment notice type ${noticeType}`);
    return null;
  }
  if (!botOpenId) {
    logger?.(
      `feishu[${accountId}]: skipping drive comment notice because bot open_id is unavailable ` +
        `event=${eventId}`,
    );
    return null;
  }
  if (senderId === botOpenId) {
    logger?.(
      `feishu[${accountId}]: ignoring self-authored drive comment notice event=${eventId} sender=${senderId}`,
    );
    return null;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const client = createClient(account);
  const context = await fetchDriveCommentContext({
    client,
    fileToken,
    fileType,
    commentId,
    replyId,
    botOpenIds: [botOpenId, event.notice_meta?.to_user_id?.open_id],
    timeoutMs: verificationTimeoutMs,
    logger,
    accountId,
    waitMs,
  });
  return {
    eventId,
    commentId,
    replyId,
    noticeType,
    fileToken,
    fileType,
    isWholeComment: context.isWholeComment,
    senderId,
    senderUserId,
    timestamp: event.timestamp,
    isMentioned: event.is_mentioned,
    context,
  };
}

export function parseFeishuDriveCommentNoticeEventPayload(
  value: unknown,
): FeishuDriveCommentNoticeEvent | null {
  if (!isRecord(value) || !isRecord(value.notice_meta)) {
    return null;
  }
  const noticeMeta = value.notice_meta;
  const fromUserId = isRecord(noticeMeta.from_user_id) ? noticeMeta.from_user_id : undefined;
  const toUserId = isRecord(noticeMeta.to_user_id) ? noticeMeta.to_user_id : undefined;
  return {
    comment_id: readString(value.comment_id),
    event_id: readString(value.event_id),
    is_mentioned: readBoolean(value.is_mentioned),
    notice_meta: {
      file_token: readString(noticeMeta.file_token),
      file_type: readString(noticeMeta.file_type),
      from_user_id: fromUserId
        ? {
            open_id: readString(fromUserId.open_id),
            user_id: readString(fromUserId.user_id),
            union_id: readString(fromUserId.union_id),
          }
        : undefined,
      notice_type: readString(noticeMeta.notice_type),
      to_user_id: toUserId
        ? {
            open_id: readString(toUserId.open_id),
            user_id: readString(toUserId.user_id),
            union_id: readString(toUserId.union_id),
          }
        : undefined,
    },
    reply_id: readString(value.reply_id),
    timestamp: readString(value.timestamp),
    type: readString(value.type),
  };
}

export async function resolveDriveCommentEventTurn(
  params: ResolveDriveCommentEventParams,
): Promise<ResolvedDriveCommentEventTurn | null> {
  const resolved = await resolveDriveCommentEventCore(params);
  if (!resolved) {
    return null;
  }
  const prompt = buildDriveCommentSurfacePrompt({
    noticeType: resolved.noticeType,
    fileType: resolved.fileType,
    fileToken: resolved.fileToken,
    commentId: resolved.commentId,
    replyId: resolved.replyId,
    isWholeComment: resolved.isWholeComment,
    isMentioned: resolved.isMentioned,
    documentTitle: resolved.context.documentTitle,
    documentUrl: resolved.context.documentUrl,
    quoteText: resolved.context.quoteText,
    rootCommentText: resolved.context.rootCommentText,
    targetReplyText: resolved.context.targetReplyText,
    rootCommentContent: resolved.context.rootCommentContent,
    targetReplyContent: resolved.context.targetReplyContent,
    currentCommentThreadReplies: resolved.context.currentCommentThreadReplies,
    wholeCommentTimeline: resolved.context.wholeCommentTimeline,
    nearestBotWholeCommentAfter: resolved.context.nearestBotWholeCommentAfter,
    nearestBotWholeCommentBefore: resolved.context.nearestBotWholeCommentBefore,
  });
  const preview = prompt.replace(/\s+/g, " ").slice(0, 160);
  return {
    eventId: resolved.eventId,
    messageId: `drive-comment:${resolved.eventId}`,
    commentId: resolved.commentId,
    replyId: resolved.replyId,
    noticeType: resolved.noticeType,
    fileToken: resolved.fileToken,
    fileType: resolved.fileType,
    isWholeComment: resolved.isWholeComment,
    senderId: resolved.senderId,
    senderUserId: resolved.senderUserId,
    timestamp: resolved.timestamp,
    isMentioned: resolved.isMentioned,
    documentTitle: resolved.context.documentTitle,
    documentUrl: resolved.context.documentUrl,
    quoteText: resolved.context.quoteText,
    rootCommentText: resolved.context.rootCommentText,
    targetReplyText: resolved.context.targetReplyText,
    prompt,
    preview,
  };
}
