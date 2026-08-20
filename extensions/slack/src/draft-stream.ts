// Slack plugin module implements draft stream behavior.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { createFinalizableDraftStreamControlsForState } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { trackSlackDraftMessage } from "./draft-message-boundaries.js";
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
  forceNewMessage: () => void;
  dropDetachedMessages: () => Promise<void>;
  finalizeMessage: (messageId: string, editFinal: () => Promise<void>) => Promise<boolean>;
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
  conversationChannelId?: string;
  eventScope?: SlackEventScope;
  identity?: SlackSendIdentity;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  metadata?: MessageMetadata;
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
  let untrackConversationBoundary: (() => void) | undefined;
  let lastVisibleUpdate: { text: string; blocks?: (Block | KnownBlock)[] } | undefined;
  let lastSentKey = "";
  const detachedMessages: Array<{ channelId: string; messageId: string }> = [];
  const finalizedMessageIds = new Set<string>();
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
        lastVisibleUpdate = { text: trimmed, ...(blocks ? { blocks } : {}) };
        return;
      }
      const threadTs = params.resolveThreadTs?.();
      const pendingBoundary = params.conversationChannelId
        ? trackSlackDraftMessage({
            accountId: params.accountId,
            teamId: params.eventScope?.teamId,
            channelId: params.conversationChannelId,
            threadTs,
            onInterveningMessage: forceNewMessage,
          })
        : undefined;
      untrackConversationBoundary = pendingBoundary?.stop;
      const sent = await send(params.target, trimmed, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        threadTs,
        identity: params.identity,
        eventScope: params.eventScope,
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(blocks ? { blocks } : {}),
      });
      streamChannelId = sent.channelId || streamChannelId;
      streamMessageId = sent.messageId || streamMessageId;
      if (!streamChannelId || !streamMessageId) {
        stopTrackingConversationBoundary();
        streamState.stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      lastVisibleUpdate = { text: trimmed, ...(blocks ? { blocks } : {}) };
      if (pendingBoundary && params.conversationChannelId === streamChannelId) {
        pendingBoundary.setMessageTs(streamMessageId);
      } else {
        stopTrackingConversationBoundary();
        const tracker = trackSlackDraftMessage({
          accountId: params.accountId,
          teamId: params.eventScope?.teamId,
          channelId: streamChannelId,
          threadTs,
          messageTs: streamMessageId,
          onInterveningMessage: forceNewMessage,
        });
        untrackConversationBoundary = tracker.stop;
      }
    } catch (err) {
      stopTrackingConversationBoundary();
      streamState.stopped = true;
      params.warn?.(`slack stream preview failed: ${formatSlackError(err)}`);
    }
  };
  const { loop, update, discardPending, seal } =
    createFinalizableDraftStreamControlsForState<SlackDraftStreamUpdate>({
      throttleMs,
      state: streamState,
      sendOrEditStreamMessage,
      emptyValue: "",
      isEmpty: (value) => !normalizeUpdate(value).text.trim(),
    });

  const stopTrackingConversationBoundary = () => {
    untrackConversationBoundary?.();
    untrackConversationBoundary = undefined;
  };

  const removeMessage = async (channelId: string, messageId: string) => {
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

  const clear = async () => {
    stopTrackingConversationBoundary();
    await discardPending();
    const channelId = streamChannelId;
    const messageId = streamMessageId;
    streamChannelId = undefined;
    streamMessageId = undefined;
    lastVisibleUpdate = undefined;
    lastSentKey = "";
    if (!channelId || !messageId) {
      return;
    }
    await removeMessage(channelId, messageId);
  };

  const forceNewMessage = () => {
    stopTrackingConversationBoundary();
    streamState.stopped = false;
    streamState.final = false;
    if (streamChannelId && streamMessageId && !finalizedMessageIds.has(streamMessageId)) {
      // A card abandoned below a newer human message is unreachable through
      // finalize/clear and would otherwise linger in its Working state.
      detachedMessages.push({ channelId: streamChannelId, messageId: streamMessageId });
    }
    streamMessageId = undefined;
    streamChannelId = undefined;
    lastVisibleUpdate = undefined;
    lastSentKey = "";
    loop.resetPending();
  };

  const dropDetachedMessages = async () => {
    // The boundary notifier can append synchronously while removal awaits.
    // Re-read the live queue so this drain also owns those later detachments.
    let message: { channelId: string; messageId: string } | undefined;
    while ((message = detachedMessages.shift()) !== undefined) {
      const { channelId, messageId } = message;
      await removeMessage(channelId, messageId);
    }
  };

  const discardPendingAndStopTracking = async () => {
    stopTrackingConversationBoundary();
    await discardPending();
  };

  const finalizeMessage = async (
    messageId: string,
    editFinal: () => Promise<void>,
  ): Promise<boolean> => {
    const channelId = streamChannelId;
    const previousUpdate = lastVisibleUpdate;
    if (!channelId || streamMessageId !== messageId || !previousUpdate) {
      return false;
    }

    await editFinal();
    if (streamChannelId === channelId && streamMessageId === messageId) {
      finalizedMessageIds.add(messageId);
      stopTrackingConversationBoundary();
      return true;
    }

    // A human spoke while the final edit was in flight. Preserve the earlier
    // progress they responded to and let the final answer land below them.
    try {
      await edit(channelId, messageId, previousUpdate.text, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        ...(params.eventScope ? { client: params.eventScope.client } : {}),
        ...(previousUpdate.blocks ? { blocks: previousUpdate.blocks } : {}),
      });
    } catch (err) {
      params.warn?.(`slack stream preview restore failed: ${formatSlackError(err)}`);
    }
    return false;
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    clear,
    discardPending: discardPendingAndStopTracking,
    seal,
    forceNewMessage,
    dropDetachedMessages,
    finalizeMessage,
    messageId: () => streamMessageId,
    channelId: () => streamChannelId,
  };
}
