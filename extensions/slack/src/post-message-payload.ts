// Slack plugin module builds shared chat.postMessage payloads.
import type { MessageMetadata } from "@slack/types";
import type { Block, ChatPostMessageArguments, KnownBlock } from "@slack/web-api";

export type SlackUnfurlOptions = {
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
};

type SlackPostThreadPayload =
  | {
      thread_ts: string;
      reply_broadcast: true;
    }
  | {
      thread_ts: string;
      reply_broadcast?: never;
    }
  | {
      thread_ts?: never;
      reply_broadcast?: never;
    };

export type SlackBasePostMessagePayload = SlackPostThreadPayload & {
  channel: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

// Every payload built here carries accessible text even though Slack's upstream
// argument type is a union where some members do not expose `text` or `blocks`.
export type SlackPostMessagePayload = ChatPostMessageArguments & SlackBasePostMessagePayload;

function buildSlackUnfurlPayload(options?: SlackUnfurlOptions) {
  return {
    // Default unfurl_links to false so bot messages don't expand inline
    // link previews (Slack message links, URLs, etc.) unless the operator
    // explicitly opts in via `channels.slack.unfurlLinks: true`.
    unfurl_links: options?.unfurlLinks ?? false,
    ...(typeof options?.unfurlMedia === "boolean" ? { unfurl_media: options.unfurlMedia } : {}),
  };
}

export function buildSlackPostMessagePayload(params: {
  channelId: string;
  text: string;
  threadTs?: string;
  replyBroadcast?: boolean;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  unfurl?: SlackUnfurlOptions;
}): SlackBasePostMessagePayload {
  const threadPayload =
    params.replyBroadcast && params.threadTs
      ? { thread_ts: params.threadTs, reply_broadcast: true as const }
      : params.threadTs
        ? { thread_ts: params.threadTs }
        : {};
  const unfurlPayload = buildSlackUnfurlPayload(params.unfurl);
  if (params.blocks?.length) {
    return {
      channel: params.channelId,
      text: params.text,
      blocks: params.blocks,
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...threadPayload,
      ...unfurlPayload,
    };
  }
  return {
    channel: params.channelId,
    text: params.text,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...threadPayload,
    ...unfurlPayload,
  };
}
