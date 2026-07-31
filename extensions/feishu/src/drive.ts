// Feishu plugin module implements drive behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import {
  encodeQuery,
  extractReplyText,
  formatFeishuApiError,
  isRecord,
  readString,
} from "./comment-shared.js";
import { parseFeishuCommentTarget, type CommentFileType } from "./comment-target.js";
import { FeishuDriveSchema, type FeishuDriveParams } from "./drive-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { toolExecutionErrorResult, unknownToolActionResult } from "./tool-result.js";

// ============ Actions ============

type FeishuExplorerRootFolderMetaResponse = {
  code: number;
  msg?: string;
  data?: {
    token?: string;
  };
};

type FeishuDriveInternalClient = Lark.Client & {
  domain?: string;
  httpInstance: Pick<Lark.HttpInstance, "get">;
  request(params: {
    method: "GET" | "POST";
    url: string;
    params?: Record<string, string | undefined>;
    data: unknown;
    timeout?: number;
  }): Promise<unknown>;
};

type FeishuDriveApiResponse<T> = {
  code: number;
  log_id?: string;
  msg?: string;
  data?: T;
};

class FeishuReplyCommentError extends Error {
  httpStatus?: number;
  feishuCode?: number | string;
  feishuMsg?: string;
  feishuLogId?: string;

  constructor(params: {
    message: string;
    httpStatus?: number;
    feishuCode?: number | string;
    feishuMsg?: string;
    feishuLogId?: string;
  }) {
    super(params.message);
    this.name = "FeishuReplyCommentError";
    this.httpStatus = params.httpStatus;
    this.feishuCode = params.feishuCode;
    this.feishuMsg = params.feishuMsg;
    this.feishuLogId = params.feishuLogId;
  }
}

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
  is_solved?: boolean;
  is_whole?: boolean;
  has_more?: boolean;
  page_token?: string;
  quote?: string;
  reply_list?: {
    replies?: FeishuDriveCommentReply[];
  };
};

type FeishuDriveListCommentsResponse = FeishuDriveApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentCard[];
  page_token?: string;
}>;

type FeishuDriveListRepliesResponse = FeishuDriveApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentReply[];
  page_token?: string;
}>;

type FeishuDriveToolContext = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
};

const FEISHU_DRIVE_REQUEST_TIMEOUT_MS = 30_000;

function getDriveInternalClient(client: Lark.Client): FeishuDriveInternalClient {
  return client as FeishuDriveInternalClient;
}

function buildReplyElements(content: string) {
  return [{ type: "text", text: content }];
}

async function requestDriveApi<T>(params: {
  client: Lark.Client;
  method: "GET" | "POST";
  url: string;
  query?: Record<string, string | undefined>;
  data?: unknown;
}): Promise<T> {
  const internalClient = getDriveInternalClient(params.client);
  return (await internalClient.request({
    method: params.method,
    url: params.url,
    params: params.query ?? {},
    data: params.data ?? {},
    timeout: FEISHU_DRIVE_REQUEST_TIMEOUT_MS,
  })) as T;
}

function assertDriveApiSuccess<T extends { code: number; msg?: string }>(response: T): T {
  if (response.code !== 0) {
    throw new Error(response.msg ?? "Feishu Drive API request failed");
  }
  return response;
}

function normalizeCommentReply(reply: FeishuDriveCommentReply) {
  return {
    reply_id: reply.reply_id,
    user_id: reply.user_id,
    create_time: reply.create_time,
    update_time: reply.update_time,
    text: extractReplyText(reply),
  };
}

function normalizeCommentCard(comment: FeishuDriveCommentCard) {
  const replies = comment.reply_list?.replies ?? [];
  const rootReply = replies[0];
  return {
    comment_id: comment.comment_id,
    user_id: comment.user_id,
    create_time: comment.create_time,
    update_time: comment.update_time,
    is_solved: comment.is_solved,
    is_whole: comment.is_whole,
    quote: comment.quote,
    text: extractReplyText(rootReply),
    has_more_replies: comment.has_more,
    replies_page_token: comment.page_token,
    replies: replies.slice(1).map(normalizeCommentReply),
  };
}

function normalizeCommentPageSize(pageSize: number | undefined): string | undefined {
  if (typeof pageSize !== "number" || !Number.isFinite(pageSize)) {
    return undefined;
  }
  return String(Math.min(Math.max(Math.floor(pageSize), 1), 100));
}

function resolveAmbientCommentTarget(context: FeishuDriveToolContext | undefined) {
  const deliveryContext = context?.deliveryContext;
  if (deliveryContext?.channel && deliveryContext.channel !== "feishu") {
    return null;
  }
  return parseFeishuCommentTarget(deliveryContext?.to);
}

function applyAmbientCommentDefaults<
  T extends {
    file_token?: string;
    file_type?: CommentFileType;
    comment_id?: string;
  },
>(params: T, context: FeishuDriveToolContext | undefined): T {
  const ambient = resolveAmbientCommentTarget(context);
  if (!ambient) {
    return params;
  }
  return {
    ...params,
    file_token: params.file_token?.trim() || ambient.fileToken,
    file_type: params.file_type ?? ambient.fileType,
    comment_id: params.comment_id?.trim() || ambient.commentId,
  };
}

function applyAddCommentAmbientDefaults<
  T extends {
    file_token?: string;
    file_type?: "doc" | "docx";
  },
>(params: T, context: FeishuDriveToolContext | undefined): T {
  const ambient = resolveAmbientCommentTarget(context);
  if (!ambient || (ambient.fileType !== "doc" && ambient.fileType !== "docx")) {
    return params;
  }
  return {
    ...params,
    file_token: params.file_token?.trim() || ambient.fileToken,
    file_type: params.file_type ?? ambient.fileType,
  };
}

function applyAddCommentDefaults<
  T extends {
    file_token?: string;
    file_type?: "doc" | "docx";
  },
>(params: T): T & { file_type: "doc" | "docx" } {
  const fileType = params.file_type ?? "docx";
  if (!params.file_type) {
    console.info(
      `[feishu_drive] add_comment missing file_type; defaulting to docx ` +
        `file_token=${params.file_token ?? "unknown"}`,
    );
  }
  return {
    ...params,
    file_type: fileType,
  };
}

function applyCommentFileTypeDefault<
  T extends {
    file_token?: string;
    file_type?: CommentFileType;
  },
>(
  params: T,
  action: "list_comments" | "list_comment_replies" | "reply_comment",
): T & {
  file_type: CommentFileType;
} {
  const fileType = params.file_type ?? "docx";
  if (!params.file_type) {
    console.info(
      `[feishu_drive] ${action} missing file_type; defaulting to docx ` +
        `file_token=${params.file_token ?? "unknown"}`,
    );
  }
  return {
    ...params,
    file_type: fileType,
  };
}

function formatDriveApiError(error: unknown): string {
  return formatFeishuApiError(error, { includeConfigParams: true });
}

function extractDriveApiErrorMeta(error: unknown): {
  message: string;
  httpStatus?: number;
  feishuCode?: number | string;
  feishuMsg?: string;
  feishuLogId?: string;
} {
  if (!isRecord(error)) {
    return { message: typeof error === "string" ? error : JSON.stringify(error) };
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response?.data : undefined;
  return {
    message:
      typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error),
    httpStatus: typeof response?.status === "number" ? response.status : undefined,
    feishuCode:
      typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
    feishuMsg: readString(responseData?.msg),
    feishuLogId: readString(responseData?.log_id),
  };
}

function isReplyNotAllowedError(error: unknown): boolean {
  if (!(error instanceof FeishuReplyCommentError)) {
    return false;
  }
  return error.feishuCode === 1069302;
}

async function getRootFolderToken(client: Lark.Client): Promise<string> {
  // Use generic HTTP client to call the root folder meta API
  // as it's not directly exposed in the SDK
  const internalClient = getDriveInternalClient(client);
  const domain = internalClient.domain ?? "https://open.feishu.cn";
  const res = (await internalClient.httpInstance.get(
    `${domain}/open-apis/drive/explorer/v2/root_folder/meta`,
  )) as FeishuExplorerRootFolderMetaResponse;
  if (res.code !== 0) {
    throw new Error(res.msg ?? "Failed to get root folder");
  }
  const token = res.data?.token;
  if (!token) {
    throw new Error("Root folder token not found");
  }
  return token;
}

async function listFolder(client: Lark.Client, params: Record<string, unknown> = {}) {
  const folderToken =
    typeof params.folder_token === "string" ? params.folder_token.trim() : undefined;
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : undefined;
  const pageSize = readPositiveIntegerParam(params, "page_size", {
    max: 200,
    message: "page_size must be a positive integer between 1 and 200",
  });
  const pageToken = typeof params.page_token === "string" ? params.page_token.trim() : undefined;

  // Bot credentials have no browsable root. A continuation cursor is only valid with the
  // same concrete folder token that produced it, so do not forward pagination for root.
  const listParams = validFolderToken
    ? {
        folder_token: validFolderToken,
        ...(pageSize ? { page_size: pageSize } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      }
    : {};
  const res = await client.drive.file.list({
    params: listParams,
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    files:
      res.data?.files?.map((f) => ({
        token: f.token,
        name: f.name,
        type: f.type,
        url: f.url,
        created_time: f.created_time,
        modified_time: f.modified_time,
        owner_id: f.owner_id,
      })) ?? [],
    next_page_token: res.data?.next_page_token,
  };
}

async function getRootFileInfo(client: Lark.Client, fileToken: string) {
  const res = await client.drive.file.list({ params: {} });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const file = res.data?.files?.find((candidate) => candidate.token === fileToken);
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return {
    token: file.token,
    name: file.name,
    type: file.type,
    url: file.url,
    created_time: file.created_time,
    modified_time: file.modified_time,
    owner_id: file.owner_id,
  };
}

async function getFileInfo(
  client: Lark.Client,
  fileToken: string,
  type: Extract<FeishuDriveParams, { action: "info" }>["type"],
) {
  if (type === "shortcut") {
    // The metadata API does not accept shortcut as a document type. Keep the existing
    // root-list behavior so the advertised shortcut info contract does not regress.
    return getRootFileInfo(client, fileToken);
  }

  let res: Awaited<ReturnType<Lark.Client["drive"]["meta"]["batchQuery"]>>;
  try {
    res = await client.drive.meta.batchQuery({
      data: {
        request_docs: [{ doc_token: fileToken, doc_type: type }],
        with_url: true,
      },
    });
  } catch (error) {
    if (extractDriveApiErrorMeta(error).feishuCode === 99991672) {
      // Existing read-only apps may not have the newer metadata scope. Preserve their
      // root-file lookup while allowing scoped apps to resolve files in any shared folder.
      return getRootFileInfo(client, fileToken);
    }
    throw error;
  }
  if (res.code === 99991672) {
    return getRootFileInfo(client, fileToken);
  }
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const file = res.data?.metas?.find(
    (meta) => meta.doc_token === fileToken || meta.request_doc_info?.doc_token === fileToken,
  );
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return {
    token: file.doc_token,
    name: file.title,
    type: file.doc_type,
    url: file.url,
    created_time: file.create_time,
    modified_time: file.latest_modify_time,
    owner_id: file.owner_id,
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken?: string) {
  // Feishu supports using folder_token="0" as the root folder.
  // We *try* to resolve the real root token (explorer API), but fall back to "0"
  // because some tenants/apps return 400 for that explorer endpoint.
  let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
  if (effectiveToken === "0") {
    try {
      effectiveToken = await getRootFolderToken(client);
    } catch {
      // ignore and keep "0"
    }
  }

  const res = await client.drive.file.createFolder({
    data: {
      name,
      folder_token: effectiveToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    token: res.data?.token,
    url: res.data?.url,
  };
}

async function moveFile(client: Lark.Client, fileToken: string, type: string, folderToken: string) {
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides",
      folder_token: folderToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function deleteFile(client: Lark.Client, fileToken: string, type: string) {
  const res = await client.drive.file.delete({
    path: { file_token: fileToken },
    params: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides"
        | "shortcut",
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function listComments(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    page_size?: number;
    page_token?: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListCommentsResponse>({
      client,
      method: "GET",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments` +
        encodeQuery({
          file_type: params.file_type,
          page_size: normalizeCommentPageSize(params.page_size),
          page_token: params.page_token,
          user_id_type: "open_id",
        }),
    }),
  );
  return {
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    comments: (response.data?.items ?? []).map(normalizeCommentCard),
  };
}

async function listCommentReplies(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    page_size?: number;
    page_token?: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListRepliesResponse>({
      client,
      method: "GET",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(
          params.comment_id,
        )}/replies` +
        encodeQuery({
          file_type: params.file_type,
          page_size: normalizeCommentPageSize(params.page_size),
          page_token: params.page_token,
          user_id_type: "open_id",
        }),
    }),
  );
  return {
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    replies: (response.data?.items ?? []).map(normalizeCommentReply),
  };
}

async function addComment(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: "doc" | "docx";
    content: string;
    block_id?: string;
  },
): Promise<{ success: true } & Record<string, unknown>> {
  if (params.block_id?.trim() && params.file_type !== "docx") {
    throw new Error("block_id is only supported for docx comments");
  }
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
      client,
      method: "POST",
      url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/new_comments`,
      data: {
        file_type: params.file_type,
        reply_elements: buildReplyElements(params.content),
        ...(params.block_id?.trim() ? { anchor: { block_id: params.block_id.trim() } } : {}),
      },
    }),
  );
  return {
    success: true,
    ...response.data,
  };
}

// Fetch comment metadata via batch_query because the single-comment endpoint
// does not support partial comments.
async function queryCommentById(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListCommentsResponse>({
      client,
      method: "POST",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/batch_query` +
        encodeQuery({
          file_type: params.file_type,
          user_id_type: "open_id",
        }),
      data: {
        comment_ids: [params.comment_id],
      },
    }),
  );
  return response.data?.items?.find((comment) => comment.comment_id?.trim() === params.comment_id);
}

async function replyComment(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    content: string;
  },
): Promise<{ success: true; reply_id?: string } & Record<string, unknown>> {
  const url = `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(
    params.comment_id,
  )}/replies`;
  const query = { file_type: params.file_type };
  try {
    const response = await requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
      client,
      method: "POST",
      url,
      query,
      data: {
        content: {
          elements: [
            {
              type: "text_run",
              text_run: {
                text: params.content,
              },
            },
          ],
        },
      },
    });
    if (response.code === 0) {
      return {
        success: true,
        ...response.data,
      };
    }
    console.warn(
      `[feishu_drive] replyComment failed ` +
        `comment=${params.comment_id} file_type=${params.file_type} ` +
        `code=${response.code ?? "unknown"} ` +
        `msg=${response.msg ?? "unknown"} log_id=${response.log_id ?? "unknown"}`,
    );
    throw new FeishuReplyCommentError({
      message: response.msg ?? "Feishu Drive reply comment failed",
      feishuCode: response.code,
      feishuMsg: response.msg,
      feishuLogId: response.log_id,
    });
  } catch (error) {
    if (error instanceof FeishuReplyCommentError) {
      throw error;
    }
    const meta = extractDriveApiErrorMeta(error);
    console.warn(
      `[feishu_drive] replyComment threw ` +
        `comment=${params.comment_id} file_type=${params.file_type} ` +
        `error=${formatDriveApiError(error)}`,
    );
    throw new FeishuReplyCommentError({
      message: meta.message,
      httpStatus: meta.httpStatus,
      feishuCode: meta.feishuCode,
      feishuMsg: meta.feishuMsg,
      feishuLogId: meta.feishuLogId,
    });
  }
}

export async function deliverCommentThreadText(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    content: string;
    is_whole_comment?: boolean;
  },
): Promise<
  | ({ success: true; reply_id?: string } & Record<string, unknown> & {
        delivery_mode: "reply_comment";
      })
  | ({ success: true; comment_id?: string } & Record<string, unknown> & {
        delivery_mode: "add_comment";
      })
> {
  let isWholeComment = params.is_whole_comment;
  if (isWholeComment === undefined) {
    try {
      const comment = await queryCommentById(client, params);
      isWholeComment = comment?.is_whole === true;
    } catch (error) {
      console.warn(
        `[feishu_drive] comment metadata preflight failed ` +
          `comment=${params.comment_id} file_type=${params.file_type} ` +
          `error=${formatErrorMessage(error)}`,
      );
      isWholeComment = false;
    }
  }
  if (isWholeComment) {
    if (params.file_type !== "doc" && params.file_type !== "docx") {
      throw new Error(
        `Whole-document comment follow-ups are only supported for doc/docx (got ${params.file_type})`,
      );
    }
    const wholeCommentFileType: "doc" | "docx" = params.file_type;
    console.info(
      `[feishu_drive] whole-comment compatibility path ` +
        `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment`,
    );
    return {
      delivery_mode: "add_comment",
      ...(await addComment(client, {
        file_token: params.file_token,
        file_type: wholeCommentFileType,
        content: params.content,
      })),
    };
  }
  try {
    return {
      delivery_mode: "reply_comment",
      ...(await replyComment(client, params)),
    };
  } catch (error) {
    if (error instanceof FeishuReplyCommentError && isReplyNotAllowedError(error)) {
      if (params.file_type !== "doc" && params.file_type !== "docx") {
        throw error;
      }
      const fallbackFileType: "doc" | "docx" = params.file_type;
      console.info(
        `[feishu_drive] reply-not-allowed compatibility path ` +
          `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment ` +
          `log_id=${error.feishuLogId ?? "unknown"}`,
      );
      return {
        delivery_mode: "add_comment",
        ...(await addComment(client, {
          file_token: params.file_token,
          file_type: fallbackFileType,
          content: params.content,
        })),
      };
    }
    throw error;
  }
}

// ============ Tool Registration ============

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.drive) {
    return;
  }

  type FeishuDriveExecuteParams = FeishuDriveParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_drive",
        label: "Feishu Drive",
        description:
          "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete, list_comments, list_comment_replies, add_comment, reply_comment",
        parameters: FeishuDriveSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDriveExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
              requiredTool: { family: "drive", label: "Drive" },
            });
            switch (p.action) {
              case "list":
                return jsonResult(
                  await listFolder(client, {
                    folder_token: p.folder_token,
                    page_size: p.page_size,
                    page_token: p.page_token,
                  }),
                );
              case "info":
                return jsonResult(await getFileInfo(client, p.file_token, p.type));
              case "create_folder":
                return jsonResult(await createFolder(client, p.name, p.folder_token));
              case "move":
                return jsonResult(await moveFile(client, p.file_token, p.type, p.folder_token));
              case "delete":
                return jsonResult(await deleteFile(client, p.file_token, p.type));
              case "list_comments": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "list_comments",
                );
                return jsonResult(await listComments(client, resolved));
              }
              case "list_comment_replies": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "list_comment_replies",
                );
                return jsonResult(await listCommentReplies(client, resolved));
              }
              case "add_comment": {
                const resolved = applyAddCommentDefaults(applyAddCommentAmbientDefaults(p, ctx));
                try {
                  return jsonResult(await addComment(client, resolved));
                } finally {
                  void cleanupAmbientCommentTypingReaction({
                    client: getDriveInternalClient(client),
                    deliveryContext: ctx.deliveryContext,
                  });
                }
              }
              case "reply_comment": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "reply_comment",
                );
                try {
                  return jsonResult(await deliverCommentThreadText(client, resolved));
                } finally {
                  void cleanupAmbientCommentTypingReaction({
                    client: getDriveInternalClient(client),
                    deliveryContext: ctx.deliveryContext,
                  });
                }
              }
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_drive" },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
