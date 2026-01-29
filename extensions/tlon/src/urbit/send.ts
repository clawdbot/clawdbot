import { scot, da } from "@urbit/aura";

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
  const story = [{ inline: [text] }];
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
  const story = [{ inline: [text] }];
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      formattedReplyId = formatUd(BigInt(replyToId));
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

// Accept a group invite by sending a group-join poke
export async function acceptGroupInvite(api: TlonPokeApi, groupId: string): Promise<void> {
  await api.poke({
    app: "groups",
    mark: "group-join",
    json: {
      flag: groupId,
      "join-all": true,
    },
  });
}

// Decline a group invite
export async function declineGroupInvite(api: TlonPokeApi, groupId: string): Promise<void> {
  await api.poke({
    app: "groups",
    mark: "invite-decline",
    json: groupId,
  });
}

// Accept a DM invite by sending a chat-dm-rsvp poke
export async function acceptDmInvite(api: TlonPokeApi, ship: string, accept: boolean = true): Promise<void> {
  // Ship MUST have the ~ prefix for this poke
  const shipName = ship.startsWith("~") ? ship : `~${ship}`;
  await api.poke({
    app: "chat",
    mark: "chat-dm-rsvp",
    json: {
      ship: shipName,
      ok: accept,
    },
  });
}
