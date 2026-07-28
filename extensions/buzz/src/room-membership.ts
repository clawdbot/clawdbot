import type { Event } from "nostr-tools";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";

export const BUZZ_ROOM_MEMBERSHIP_KIND = 39002;
export const BUZZ_ROOM_SYSTEM_KIND = 40099;

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const MEMBERSHIP_CHANGE_TYPES = new Set(["member_joined", "member_left", "member_removed"]);

type BuzzRoomMembershipChange = {
  type: "member_joined" | "member_left" | "member_removed";
  targetPublicKey: string;
};

export type BuzzRoomMembership = {
  roomId: string;
  createdAt: number;
  eventId: string;
  publisherPublicKey: string;
  members: ReadonlySet<string>;
  roles: ReadonlyMap<string, string>;
};

export function parseBuzzRoomMembershipEvent(event: Event): BuzzRoomMembership | undefined {
  if (event.kind !== BUZZ_ROOM_MEMBERSHIP_KIND) {
    return undefined;
  }
  const roomId = event.tags
    .find((tag) => tag[0] === "d")?.[1]
    ?.trim()
    .toLowerCase();
  if (!roomId || !BUZZ_CHANNEL_ID_PATTERN.test(roomId)) {
    return undefined;
  }

  const members = new Set<string>();
  const roles = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] !== "p") {
      continue;
    }
    const publicKey = tag[1]?.trim().toLowerCase();
    if (!publicKey || !HEX_PUBLIC_KEY_PATTERN.test(publicKey)) {
      continue;
    }
    members.add(publicKey);
    const role = tag[3]?.trim().toLowerCase();
    if (role) {
      roles.set(publicKey, role);
    }
  }

  return {
    roomId,
    createdAt: event.created_at,
    eventId: event.id,
    publisherPublicKey: event.pubkey.toLowerCase(),
    members,
    roles,
  };
}

export function isNewerBuzzRoomMembership(
  candidate: BuzzRoomMembership,
  current: BuzzRoomMembership | undefined,
): boolean {
  return (
    !current ||
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)
  );
}

export function parseBuzzRoomMembershipChangeEvent(
  event: Event,
  membership: BuzzRoomMembership,
): BuzzRoomMembershipChange | undefined {
  if (
    event.kind !== BUZZ_ROOM_SYSTEM_KIND ||
    event.pubkey.toLowerCase() !== membership.publisherPublicKey ||
    !event.tags.some((tag) => tag[0] === "h" && tag[1]?.toLowerCase() === membership.roomId)
  ) {
    return undefined;
  }
  try {
    const content = JSON.parse(event.content) as {
      type?: unknown;
      target?: unknown;
      actor?: unknown;
    };
    if (typeof content.type !== "string" || !MEMBERSHIP_CHANGE_TYPES.has(content.type)) {
      return undefined;
    }
    const target =
      typeof content.target === "string"
        ? content.target.trim().toLowerCase()
        : content.type === "member_left" && typeof content.actor === "string"
          ? content.actor.trim().toLowerCase()
          : "";
    if (!HEX_PUBLIC_KEY_PATTERN.test(target)) {
      return undefined;
    }
    return {
      type: content.type as BuzzRoomMembershipChange["type"],
      targetPublicKey: target,
    };
  } catch {
    return undefined;
  }
}
