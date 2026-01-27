import { scot, da } from "@urbit/aura";
import { markdownToStory, type Story } from "./story.js";

export type TlonPokeApi = {
  poke: (params: { app: string; mark: string; json: unknown }) => Promise<unknown>;
};

type SendTextParams = {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  text: string;
};

export async function sendDm({ api, fromShip, toShip, text }: SendTextParams) {
  const story: Story = markdownToStory(text);
  const sentAt = Date.now();
  const idUd = scot('ud', da.fromUnix(sentAt));
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

  return { channel: "tlon", messageId: id };
}

type SendGroupParams = {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  text: string;
  replyToId?: string | null;
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
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      // scot('ud', n) formats a number as @ud with dots
      formattedReplyId = scot('ud', BigInt(replyToId));
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

  return { channel: "tlon", messageId: `${fromShip}/${sentAt}` };
}

export function buildMediaText(text: string | undefined, mediaUrl: string | undefined): string {
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";
  if (cleanText && cleanUrl) return `${cleanText}\n${cleanUrl}`;
  if (cleanUrl) return cleanUrl;
  return cleanText;
}
