import type { Block, KnownBlock } from "@slack/web-api";
import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { sendMessageSlack } from "./send.js";

const DEFAULT_THROTTLE_MS = 1000;

type SlackDraftStream = {
  update: (update: SlackDraftStreamUpdate) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => void;
  forceNewMessage: () => void;
  messageId: () => string | undefined;
  channelId: () => string | undefined;
};

export type SlackDraftStreamUpdate =
  | string
  | {
      text: string;
      blocks?: (Block | KnownBlock)[];
    };

export function createSlackDraftStream(params: {
  target: string;
  cfg: OpenClawConfig;
  token: string;
  accountId?: string;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  onMessageSent?: () => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  send?: typeof sendMessageSlack;
  edit?: typeof editSlackMessage;
  remove?: typeof deleteSlackMessage;
}): SlackDraftStream {
  const maxChars = Math.min(params.maxChars ?? SLACK_TEXT_LIMIT, SLACK_TEXT_LIMIT);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSlack;
  const edit = params.edit ?? editSlackMessage;
  const remove = params.remove ?? deleteSlackMessage;

  let streamMessageId: string | undefined;
  let streamChannelId: string | undefined;
  let lastSentKey = "";
  let pendingUpdate: SlackDraftStreamUpdate | undefined;
  let stopped = false;

  const normalizeUpdate = (update: SlackDraftStreamUpdate) =>
    typeof update === "string" ? { text: update } : update;

  const sendOrEditStreamMessage = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    const update = normalizeUpdate(pendingUpdate ?? text);
    const blocks = update.text === text ? update.blocks : undefined;
    const sentKey = `${trimmed}\n${blocks ? JSON.stringify(blocks) : ""}`;
    if (sentKey === lastSentKey) {
      return;
    }
    lastSentKey = sentKey;
    try {
      if (streamChannelId && streamMessageId) {
        await edit(streamChannelId, streamMessageId, trimmed, {
          cfg: params.cfg,
          token: params.token,
          accountId: params.accountId,
          ...(blocks ? { blocks } : {}),
        });
        return;
      }
      const sent = await send(params.target, trimmed, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        threadTs: params.resolveThreadTs?.(),
        ...(blocks ? { blocks } : {}),
      });
      streamChannelId = sent.channelId || streamChannelId;
      streamMessageId = sent.messageId || streamMessageId;
      if (!streamChannelId || !streamMessageId) {
        stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      params.onMessageSent?.();
    } catch (err) {
      stopped = true;
      params.warn?.(`slack stream preview failed: ${formatErrorMessage(err)}`);
    }
  };
  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const stop = () => {
    stopped = true;
    loop.stop();
  };

  const discardPending = async () => {
    stop();
    await loop.waitForInFlight();
  };

  const clear = async () => {
    await discardPending();
    const channelId = streamChannelId;
    const messageId = streamMessageId;
    streamChannelId = undefined;
    streamMessageId = undefined;
    lastSentKey = "";
    pendingUpdate = undefined;
    if (!channelId || !messageId) {
      return;
    }
    try {
      await remove(channelId, messageId, {
        token: params.token,
        accountId: params.accountId,
      });
    } catch (err) {
      params.warn?.(`slack stream preview cleanup failed: ${formatErrorMessage(err)}`);
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    streamChannelId = undefined;
    lastSentKey = "";
    pendingUpdate = undefined;
    loop.resetPending();
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: (update: SlackDraftStreamUpdate) => {
      const normalized = normalizeUpdate(update);
      pendingUpdate = update;
      loop.update(normalized.text);
    },
    flush: loop.flush,
    clear,
    discardPending,
    seal: discardPending,
    stop,
    forceNewMessage,
    messageId: () => streamMessageId,
    channelId: () => streamChannelId,
  };
}
