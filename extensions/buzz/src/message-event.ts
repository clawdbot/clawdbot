import type { Event } from "nostr-tools";

const MESSAGE_KIND = 9;

export interface BuzzInboundMessage {
  id: string;
  senderPubkey: string;
  text: string;
  channelId: string;
  createdAt: number;
  threadId?: string;
  replyToId?: string;
  mentionedPubkeys: string[];
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function markerTagValue(event: Event, marker: string): string | undefined {
  return event.tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
}

export function parseBuzzMessageEvent(event: Event): BuzzInboundMessage | null {
  if (event.kind !== MESSAGE_KIND || !event.content.trim()) {
    return null;
  }
  const channelId = tagValue(event, "h");
  if (!channelId) {
    return null;
  }
  const rootId = markerTagValue(event, "root");
  const replyToId = markerTagValue(event, "reply");
  return {
    id: event.id,
    senderPubkey: event.pubkey,
    text: event.content,
    channelId,
    createdAt: event.created_at,
    threadId: rootId ?? replyToId,
    replyToId,
    mentionedPubkeys: event.tags
      .filter((tag) => tag[0] === "p" && Boolean(tag[1]))
      .map((tag) => tag[1] as string),
  };
}

export function buildBuzzMessageTags(params: {
  channelId: string;
  threadId?: string;
  replyToId?: string;
}): string[][] {
  const tags: string[][] = [["h", params.channelId]];
  const parentId = params.replyToId ?? params.threadId;
  if (params.threadId && parentId !== params.threadId) {
    tags.push(["e", params.threadId, "", "root"]);
  }
  if (parentId) {
    tags.push(["e", parentId, "", "reply"]);
  }
  return tags;
}
