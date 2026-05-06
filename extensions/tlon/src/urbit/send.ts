import { scot, da } from "@urbit/aura";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";
import { markdownToStory, createImageBlock, isImageUrl, type Story } from "./story.js";

export type TlonPokeApi = {
  poke: (params: { app: string; mark: string; json: unknown }) => Promise<unknown>;
};

type SendTextParams = {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  text: string;
};

type SendStoryParams = {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  story: Story;
  kind?: MessageReceiptPartKind;
};

function createTlonSendReceipt(params: {
  messageId: string;
  conversationId: string;
  kind: MessageReceiptPartKind;
}) {
  return createMessageReceiptFromOutboundResults({
    results: [
      {
        channel: "tlon",
        messageId: params.messageId,
        conversationId: params.conversationId,
      },
    ],
    threadId: params.conversationId,
    kind: params.kind,
  });
}

export async function sendDm({ api, fromShip, toShip, text }: SendTextParams) {
  const story: Story = markdownToStory(text);
  return sendDmWithStory({ api, fromShip, toShip, story, kind: "text" });
}

export async function sendDmWithStory({
  api,
  fromShip,
  toShip,
  story,
  kind = "unknown",
}: SendStoryParams) {
  const sentAt = Date.now();
  const idUd = scot("ud", da.fromUnix(sentAt));
  const id = `${fromShip}/${idUd}`;

  const delta = {
    add: {
      memo: {
        content: story,
        author: fromShip,
        sent: sentAt,
      },
      kind: null,
      time: null,
    },
  };

  const action = {
    ship: toShip,
    diff: { id, delta },
  };

  await api.poke({
    app: "chat",
    mark: "chat-dm-action",
    json: action,
  });

  return {
    channel: "tlon",
    messageId: id,
    receipt: createTlonSendReceipt({ messageId: id, conversationId: toShip, kind }),
  };
}

type SendGroupParams = {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  text: string;
  replyToId?: string | null;
};

type SendGroupStoryParams = {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  story: Story;
  replyToId?: string | null;
  kind?: MessageReceiptPartKind;
};

export async function sendGroupMessage({
  api,
  fromShip,
  hostShip,
  channelName,
  text,
  replyToId,
}: SendGroupParams) {
  const story: Story = markdownToStory(text);
  return sendGroupMessageWithStory({
    api,
    fromShip,
    hostShip,
    channelName,
    story,
    replyToId,
    kind: "text",
  });
}

export async function sendGroupMessageWithStory({
  api,
  fromShip,
  hostShip,
  channelName,
  story,
  replyToId,
  kind = "unknown",
}: SendGroupStoryParams) {
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      // scot('ud', n) formats a number as @ud with dots
      formattedReplyId = scot("ud", BigInt(replyToId));
    } catch {
      // Fall back to raw ID if formatting fails
    }
  }

  const action = {
    channel: {
      nest: `chat/${hostShip}/${channelName}`,
      action: formattedReplyId
        ? {
            // Thread reply - needs post wrapper around reply action
            // ReplyActionAdd takes Memo: {content, author, sent} - no kind/blob/meta
            post: {
              reply: {
                id: formattedReplyId,
                action: {
                  add: {
                    content: story,
                    author: fromShip,
                    sent: sentAt,
                  },
                },
              },
            },
          }
        : {
            // Regular post
            post: {
              add: {
                content: story,
                author: fromShip,
                sent: sentAt,
                kind: "/chat",
                blob: null,
                meta: null,
              },
            },
          },
    },
  };

  await api.poke({
    app: "channels",
    mark: "channel-action-1",
    json: action,
  });

  const messageId = `${fromShip}/${sentAt}`;
  return {
    channel: "tlon",
    messageId,
    receipt: createTlonSendReceipt({
      messageId,
      conversationId: `${hostShip}/${channelName}`,
      kind,
    }),
  };
}

/**
 * Build a story with text and optional media (image)
 */
export function buildMediaStory(text: string | undefined, mediaUrl: string | undefined): Story {
  const story: Story = [];
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";

  // Add text content if present
  if (cleanText) {
    story.push(...markdownToStory(cleanText));
  }

  // Add image block if URL looks like an image
  if (cleanUrl && isImageUrl(cleanUrl)) {
    story.push(createImageBlock(cleanUrl, ""));
  } else if (cleanUrl) {
    // For non-image URLs, add as a link
    story.push({ inline: [{ link: { href: cleanUrl, content: cleanUrl } }] });
  }

  return story.length > 0 ? story : [{ inline: [""] }];
}
