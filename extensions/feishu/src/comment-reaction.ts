import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { encodeQuery, formatFeishuApiError } from "./comment-shared.js";
import { parseFeishuCommentTarget, type CommentFileType } from "./comment-target.js";

const COMMENT_TYPING_REACTION_TYPE = "Typing";
const COMMENT_REACTION_TIMEOUT_MS = 30_000;
const commentTypingReactionState = new Map<
  string,
  {
    active: boolean;
    cleaned: boolean;
    cleanupPromise?: Promise<boolean>;
  }
>();

type FeishuCommentReactionClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "POST";
    url: string;
    data: unknown;
    timeout: number;
  }): Promise<unknown>;
};

function buildCommentTypingReactionKey(params: {
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
}): string {
  return `${params.fileType}:${params.fileToken}:${params.replyId}`;
}

function ensureCommentTypingReactionState(key: string) {
  const existing = commentTypingReactionState.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    active: false,
    cleaned: false,
    cleanupPromise: undefined,
  };
  commentTypingReactionState.set(key, created);
  return created;
}

async function requestCommentTypingReactionWithClient(params: {
  client: FeishuCommentReactionClient;
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
  action: "add" | "delete";
  runtime?: RuntimeEnv;
  logPrefix?: string;
}): Promise<boolean> {
  try {
    const response = (await params.client.request({
      method: "POST",
      url:
        `/open-apis/drive/v2/files/${encodeURIComponent(params.fileToken)}/comments/reaction` +
        encodeQuery({
          file_type: params.fileType,
        }),
      data: {
        action: params.action,
        reply_id: params.replyId,
        reaction_type: COMMENT_TYPING_REACTION_TYPE,
      },
      timeout: COMMENT_REACTION_TIMEOUT_MS,
    })) as {
      code?: number;
      msg?: string;
      log_id?: string;
      error?: { log_id?: string };
    };
    if (response.code === 0) {
      return true;
    }
    params.runtime?.log?.(
      `${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} failed ` +
        `reply=${params.replyId} file=${params.fileType}:${params.fileToken} ` +
        `code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"} ` +
        `log_id=${response.log_id ?? response.error?.log_id ?? "unknown"}`,
    );
  } catch (error) {
    params.runtime?.log?.(
      `${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} threw ` +
        `reply=${params.replyId} file=${params.fileType}:${params.fileToken} ` +
        `error=${formatCommentReactionFailure(error)}`,
    );
  }
  return false;
}

function formatCommentReactionFailure(error: unknown): string {
  return formatFeishuApiError(error, { includeNestedErrorLogId: true });
}

async function requestCommentTypingReaction(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: CommentFileType;
  replyId: string;
  action: "add" | "delete";
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<boolean> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured || !(account.config.typingIndicator ?? true)) {
    return false;
  }
  const client = createFeishuClient(account) as FeishuCommentReactionClient;
  return requestCommentTypingReactionWithClient({
    client,
    fileToken: params.fileToken,
    fileType: params.fileType,
    replyId: params.replyId,
    action: params.action,
    runtime: params.runtime,
    logPrefix: `feishu[${account.accountId}]`,
  });
}

async function cleanupCommentTypingReactionByKey(params: {
  key: string;
  performDelete: () => Promise<boolean>;
}): Promise<boolean> {
  const state = ensureCommentTypingReactionState(params.key);
  if (state.cleaned) {
    return false;
  }
  if (state.cleanupPromise) {
    return await state.cleanupPromise;
  }
  const cleanupPromise = (async (): Promise<boolean> => {
    if (!state.active) {
      state.cleaned = true;
      return false;
    }
    const deleted = await params.performDelete();
    if (deleted) {
      state.cleaned = true;
      state.active = false;
    }
    return deleted;
  })();
  state.cleanupPromise = cleanupPromise;
  try {
    return await cleanupPromise;
  } finally {
    state.cleanupPromise = undefined;
    if (state.cleaned) {
      state.active = false;
      commentTypingReactionState.delete(params.key);
    }
  }
}

export async function cleanupAmbientCommentTypingReaction(params: {
  client: FeishuCommentReactionClient;
  deliveryContext?: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
  runtime?: RuntimeEnv;
}): Promise<boolean> {
  const deliveryContext = params.deliveryContext;
  if (
    deliveryContext?.channel &&
    deliveryContext.channel !== "feishu" &&
    deliveryContext.channel !== "feishu-comment"
  ) {
    return false;
  }
  const target = parseFeishuCommentTarget(deliveryContext?.to);
  const replyId =
    typeof deliveryContext?.threadId === "string" || typeof deliveryContext?.threadId === "number"
      ? String(deliveryContext.threadId).trim()
      : "";
  if (!target || !replyId) {
    return false;
  }
  const key = buildCommentTypingReactionKey({
    fileToken: target.fileToken,
    fileType: target.fileType,
    replyId,
  });
  return cleanupCommentTypingReactionByKey({
    key,
    performDelete: () =>
      requestCommentTypingReactionWithClient({
        client: params.client,
        fileToken: target.fileToken,
        fileType: target.fileType,
        replyId,
        action: "delete",
        runtime: params.runtime,
        logPrefix: "[feishu]",
      }),
  });
}

export function createCommentTypingReactionLifecycle(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: CommentFileType;
  replyId?: string;
  accountId?: string;
  runtime?: RuntimeEnv;
}) {
  const key = params.replyId?.trim()
    ? buildCommentTypingReactionKey({
        fileToken: params.fileToken,
        fileType: params.fileType,
        replyId: params.replyId.trim(),
      })
    : undefined;
  const state = key ? ensureCommentTypingReactionState(key) : undefined;

  return {
    start: async (): Promise<void> => {
      const replyId = params.replyId?.trim();
      if (!state || state.cleaned || state.active || !replyId) {
        return;
      }
      state.active = await requestCommentTypingReaction({
        cfg: params.cfg,
        fileToken: params.fileToken,
        fileType: params.fileType,
        replyId,
        action: "add",
        accountId: params.accountId,
        runtime: params.runtime,
      });
    },
    cleanup: async (): Promise<void> => {
      const replyId = params.replyId?.trim();
      if (!key || !replyId) {
        return;
      }
      await cleanupCommentTypingReactionByKey({
        key,
        performDelete: () =>
          requestCommentTypingReaction({
            cfg: params.cfg,
            fileToken: params.fileToken,
            fileType: params.fileType,
            replyId,
            action: "delete",
            accountId: params.accountId,
            runtime: params.runtime,
          }),
      });
    },
  };
}
