import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "./comment-dispatcher-runtime-api.js";
import { createCommentTypingReactionLifecycle } from "./comment-reaction.js";
import type { CommentFileType } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { getFeishuRuntime } from "./runtime.js";

export type CreateFeishuCommentReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  accountId?: string;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  replyId?: string;
  isWholeComment?: boolean;
};

export function createFeishuCommentReplyDispatcher(
  params: CreateFeishuCommentReplyDispatcherParams,
) {
  const core = getFeishuRuntime();
  const prefixContext = createReplyPrefixContext({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
  });
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    "feishu",
    params.accountId,
    {
      fallbackLimit: 4000,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "feishu");
  const typingReaction = createCommentTypingReactionLifecycle({
    cfg: params.cfg,
    fileToken: params.fileToken,
    fileType: params.fileType,
    replyId: params.replyId,
    accountId: params.accountId,
    runtime: params.runtime,
  });

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
      onReplyStart: async () => {
        await typingReaction.start();
      },
      deliver: async (payload: ReplyPayload, info) => {
        if (info.kind !== "final") {
          return;
        }
        const reply = resolveSendableOutboundReplyParts(payload);
        if (!reply.hasText) {
          if (reply.hasMedia) {
            params.runtime.log?.(
              `feishu[${params.accountId ?? "default"}]: comment reply ignored media-only payload for comment=${params.commentId}`,
            );
          }
          return;
        }
        const chunks = core.channel.text.chunkTextWithMode(reply.text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await deliverCommentThreadText(client, {
            file_token: params.fileToken,
            file_type: params.fileType,
            comment_id: params.commentId,
            content: chunk,
            is_whole_comment: params.isWholeComment,
          });
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${params.accountId ?? "default"}]: comment dispatcher failed kind=${info.kind} comment=${params.commentId}: ${String(err)}`,
        );
      },
      onCleanup: () => {
        void typingReaction.cleanup();
      },
    });

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
    markRunComplete,
    startTypingReaction: typingReaction.start,
    cleanupTypingReaction: typingReaction.cleanup,
  };
}
