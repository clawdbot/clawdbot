// Line plugin module implements reply chunks behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

type LineReplyMessage = messagingApi.TextMessage;

export type SendLineReplyChunksParams = {
  to: string;
  chunks: string[];
  quickReplies?: string[];
  replyToken?: string | null;
  replyTokenUsed?: boolean;
  cfg: OpenClawConfig;
  accountId?: string;
  replyMessageLine: (
    replyToken: string,
    messages: messagingApi.Message[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  pushMessageLine: (
    to: string,
    text: string,
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  pushTextMessageWithQuickReplies: (
    to: string,
    text: string,
    quickReplies: string[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  createTextMessageWithQuickReplies: (text: string, quickReplies: string[]) => LineReplyMessage;
  onReplyError?: (err: unknown) => void;
};

export async function sendLineReplyChunks(
  params: SendLineReplyChunksParams,
): Promise<{ replyTokenUsed: boolean }> {
  const quickReplies = params.quickReplies?.length ? params.quickReplies : undefined;
  let replyTokenUsed = Boolean(params.replyTokenUsed);

  if (params.chunks.length === 0) {
    return { replyTokenUsed };
  }

  if (params.replyToken && !replyTokenUsed) {
    try {
      const replyBatch = params.chunks.slice(0, 5);
      const remaining = params.chunks.slice(replyBatch.length);

      const replyMessages: LineReplyMessage[] = replyBatch.map((chunk) => ({
        type: "text",
        text: chunk,
      }));

      if (quickReplies && remaining.length === 0 && replyMessages.length > 0) {
        const lastIndex = replyMessages.length - 1;
        replyMessages[lastIndex] = params.createTextMessageWithQuickReplies(
          expectDefined(replyBatch[lastIndex], "last non-empty LINE reply batch chunk"),
          quickReplies,
        );
      }

      await params.replyMessageLine(params.replyToken, replyMessages, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
      replyTokenUsed = true;

      for (const [i, chunk] of remaining.entries()) {
        const isLastChunk = i === remaining.length - 1;
        if (isLastChunk && quickReplies) {
          await params.pushTextMessageWithQuickReplies(params.to, chunk, quickReplies, {
            cfg: params.cfg,
            accountId: params.accountId,
          });
        } else {
          await params.pushMessageLine(params.to, chunk, {
            cfg: params.cfg,
            accountId: params.accountId,
          });
        }
      }

      return { replyTokenUsed };
    } catch (err) {
      params.onReplyError?.(err);
      replyTokenUsed = true;
    }
  }

  for (const [i, chunk] of params.chunks.entries()) {
    const isLastChunk = i === params.chunks.length - 1;
    if (isLastChunk && quickReplies) {
      await params.pushTextMessageWithQuickReplies(params.to, chunk, quickReplies, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
    } else {
      await params.pushMessageLine(params.to, chunk, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
    }
  }

  return { replyTokenUsed };
}
