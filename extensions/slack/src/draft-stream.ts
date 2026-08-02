// Slack plugin module implements draft stream behavior.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { createFinalizableDraftStreamControlsForState } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { formatSlackError } from "./errors.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import type { SlackEventScope } from "./monitor/event-scope.js";
import type { SlackSendIdentity } from "./send.js";
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

type SlackDraftStreamUpdate =
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
  eventScope?: SlackEventScope;
  identity?: SlackSendIdentity;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  metadata?: MessageMetadata;
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
  const streamState = { stopped: false, final: false };

  const normalizeUpdate = (update: SlackDraftStreamUpdate) =>
    typeof update === "string" ? { text: update } : update;

  const sendOrEditStreamMessage = async (pending: SlackDraftStreamUpdate) => {
    if (streamState.stopped) {
      return;
    }
    const update = normalizeUpdate(pending);
    const trimmed = update.text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    const blocks = update.blocks;
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
          ...(params.eventScope ? { client: params.eventScope.client } : {}),
          ...(blocks ? { blocks } : {}),
        });
        return;
      }
      const sent = await send(params.target, trimmed, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        threadTs: params.resolveThreadTs?.(),
        identity: params.identity,
        ...(params.eventScope
          ? { client: params.eventScope.client, enterpriseEventScope: params.eventScope }
          : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(blocks ? { blocks } : {}),
      });
      streamChannelId = sent.channelId || streamChannelId;
      streamMessageId = sent.messageId || streamMessageId;
      if (!streamChannelId || !streamMessageId) {
        streamState.stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      params.onMessageSent?.();
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(`slack stream preview failed: ${formatSlackError(err)}`);
    }
  };
  const { loop, update, discardPending } =
    createFinalizableDraftStreamControlsForState<SlackDraftStreamUpdate>({
      throttleMs,
      state: streamState,
      sendOrEditStreamMessage,
      emptyValue: "",
      isEmpty: (value) => !normalizeUpdate(value).text.trim(),
    });

  const stop = () => {
    streamState.stopped = true;
    loop.stop();
  };

  const clear = async () => {
    await discardPending();
    const channelId = streamChannelId;
    const messageId = streamMessageId;
    streamChannelId = undefined;
    streamMessageId = undefined;
    lastSentKey = "";
    if (!channelId || !messageId) {
      return;
    }
    try {
      await remove(channelId, messageId, {
        token: params.token,
        accountId: params.accountId,
        ...(params.eventScope ? { client: params.eventScope.client } : {}),
      });
    } catch (err) {
      params.warn?.(`slack stream preview cleanup failed: ${formatSlackError(err)}`);
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    streamChannelId = undefined;
    lastSentKey = "";
    loop.resetPending();
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
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
