import type { Event } from "nostr-tools";
import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BuzzRoomMembership } from "./room-membership.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";

export const BUZZ_PROFILE_KIND = 0;
export const BUZZ_ROOM_METADATA_KIND = 39_000;
export const BUZZ_PROFILE_QUERY_CHUNK_SIZE = 200;
// Ten live profile subscriptions is the normal process-local ceiling. The bus
// lowers it near the relay subscription limit; omitted profiles keep stable IDs.
const DEFAULT_BUZZ_DIRECTORY_PROFILE_LIMIT = 2_000;

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_DIRECTORY_NAME_CHARS = 512;
const MAX_DIRECTORY_HANDLE_CHARS = 320;
const MAX_DIRECTORY_URL_CHARS = 4_096;

type BuzzDirectoryProfile = {
  publicKey: string;
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  createdAt: number;
  eventId: string;
};

type BuzzDirectoryRoom = {
  roomId: string;
  name?: string;
  archived: boolean;
  createdAt: number;
  eventId: string;
};

function normalizeBoundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateUtf16Safe(trimmed, maxChars);
}

function readPreferredString(params: {
  content: Record<string, unknown>;
  primary: string;
  fallback: string;
  maxChars: number;
}): string | undefined {
  if (Object.hasOwn(params.content, params.primary)) {
    return normalizeBoundedString(params.content[params.primary], params.maxChars);
  }
  return normalizeBoundedString(params.content[params.fallback], params.maxChars);
}

function isNewerEvent(
  candidate: { createdAt: number; eventId: string },
  current: { createdAt: number; eventId: string } | undefined,
): boolean {
  return (
    !current ||
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)
  );
}

function fallbackPublicKeyLabel(publicKey: string): string {
  return `${publicKey.slice(0, 8)}...${publicKey.slice(-6)}`;
}

function matchesDirectoryQuery(entry: ChannelDirectoryEntry, query: string): boolean {
  if (!query) {
    return true;
  }
  return [entry.id, entry.name, entry.handle].some((value) => value?.toLowerCase().includes(query));
}

function applyQueryAndLimit(
  entries: ChannelDirectoryEntry[],
  params: { query?: string | null; limit?: number | null },
): ChannelDirectoryEntry[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit =
    typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
  const result: ChannelDirectoryEntry[] = [];
  for (const entry of entries) {
    if (!matchesDirectoryQuery(entry, query)) {
      continue;
    }
    result.push(entry);
    if (limit !== undefined && result.length >= limit) {
      break;
    }
  }
  return result;
}

function parseBuzzDirectoryProfileEvent(event: Event): BuzzDirectoryProfile | undefined {
  const publicKey = event.pubkey.trim().toLowerCase();
  if (event.kind !== BUZZ_PROFILE_KIND || !HEX_PUBLIC_KEY_PATTERN.test(publicKey)) {
    return undefined;
  }
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    content = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return {
    publicKey,
    displayName: readPreferredString({
      content,
      primary: "display_name",
      fallback: "name",
      maxChars: MAX_DIRECTORY_NAME_CHARS,
    }),
    handle: normalizeBoundedString(content.nip05, MAX_DIRECTORY_HANDLE_CHARS),
    avatarUrl: readPreferredString({
      content,
      primary: "picture",
      fallback: "image",
      maxChars: MAX_DIRECTORY_URL_CHARS,
    }),
    createdAt: event.created_at,
    eventId: event.id,
  };
}

function parseBuzzDirectoryRoomEvent(event: Event): BuzzDirectoryRoom | undefined {
  if (event.kind !== BUZZ_ROOM_METADATA_KIND) {
    return undefined;
  }
  const roomId = event.tags
    .find((tag) => tag[0] === "d")?.[1]
    ?.trim()
    .toLowerCase();
  if (!roomId) {
    return undefined;
  }
  try {
    parseBuzzTarget(roomId);
  } catch {
    return undefined;
  }
  return {
    roomId,
    name: normalizeBoundedString(
      event.tags.find((tag) => tag[0] === "name")?.[1],
      MAX_DIRECTORY_NAME_CHARS,
    ),
    archived: event.tags.some((tag) => tag[0] === "archived" && tag[1] === "true"),
    createdAt: event.created_at,
    eventId: event.id,
  };
}

export class BuzzDirectoryState {
  readonly #publicKey: string;
  readonly #fallbackProfileName: string;
  readonly #configuredRoomIds: Set<string>;
  readonly #profileLimit: number;
  #memberships = new Map<string, BuzzRoomMembership>();
  #profilePublicKeys = new Set<string>();
  #profiles = new Map<string, BuzzDirectoryProfile>();
  #rooms = new Map<string, BuzzDirectoryRoom>();

  constructor(params: {
    publicKey: string;
    fallbackProfileName: string;
    channelIds: string[];
    profileLimit?: number;
  }) {
    this.#publicKey = params.publicKey.trim().toLowerCase();
    this.#fallbackProfileName = params.fallbackProfileName.trim() || "OpenClaw";
    this.#configuredRoomIds = new Set(params.channelIds.map(parseBuzzTarget));
    const requestedProfileLimit = params.profileLimit ?? DEFAULT_BUZZ_DIRECTORY_PROFILE_LIMIT;
    this.#profileLimit =
      Number.isFinite(requestedProfileLimit) && requestedProfileLimit >= 0
        ? Math.floor(requestedProfileLimit)
        : DEFAULT_BUZZ_DIRECTORY_PROFILE_LIMIT;
    if (this.#profileLimit > 0) {
      this.#profilePublicKeys.add(this.#publicKey);
    }
  }

  replaceMemberships(memberships: ReadonlyMap<string, BuzzRoomMembership>): boolean {
    const nextMemberships = new Map<string, BuzzRoomMembership>();
    const memberPublicKeys = new Set<string>();
    for (const roomId of this.#configuredRoomIds) {
      const membership = memberships.get(roomId);
      if (!membership) {
        continue;
      }
      nextMemberships.set(roomId, membership);
      for (const publicKey of membership.members) {
        memberPublicKeys.add(publicKey);
      }
    }
    memberPublicKeys.delete(this.#publicKey);
    const nextProfilePublicKeys =
      this.#profileLimit === 0
        ? new Set<string>()
        : new Set<string>([
            this.#publicKey,
            ...[...memberPublicKeys].toSorted().slice(0, this.#profileLimit - 1),
          ]);
    const profileSelectionChanged =
      nextProfilePublicKeys.size !== this.#profilePublicKeys.size ||
      [...nextProfilePublicKeys].some((publicKey) => !this.#profilePublicKeys.has(publicKey));
    this.#memberships = nextMemberships;
    this.#profilePublicKeys = nextProfilePublicKeys;
    for (const publicKey of this.#profiles.keys()) {
      if (!nextProfilePublicKeys.has(publicKey)) {
        this.#profiles.delete(publicKey);
      }
    }
    return profileSelectionChanged;
  }

  profilePublicKeys(): string[] {
    return [...this.#profilePublicKeys];
  }

  activeRoomIds(): string[] {
    return [...this.#configuredRoomIds].filter((roomId) => !this.#rooms.get(roomId)?.archived);
  }

  isRoomArchived(roomId: string): boolean {
    return this.#rooms.get(parseBuzzTarget(roomId))?.archived === true;
  }

  applyProfileEvent(event: Event): boolean {
    const profile = parseBuzzDirectoryProfileEvent(event);
    if (
      !profile ||
      !this.#profilePublicKeys.has(profile.publicKey) ||
      !isNewerEvent(profile, this.#profiles.get(profile.publicKey))
    ) {
      return false;
    }
    this.#profiles.set(profile.publicKey, profile);
    return true;
  }

  applyRoomEvent(event: Event): boolean {
    const room = parseBuzzDirectoryRoomEvent(event);
    if (
      !room ||
      !this.#configuredRoomIds.has(room.roomId) ||
      !isNewerEvent(room, this.#rooms.get(room.roomId))
    ) {
      return false;
    }
    this.#rooms.set(room.roomId, room);
    return true;
  }

  resolveSenderName(publicKey: string): string {
    const normalized = publicKey.trim().toLowerCase();
    return this.#profiles.get(normalized)?.displayName ?? fallbackPublicKeyLabel(normalized);
  }

  resolveRoomName(roomId: string): string {
    const normalized = parseBuzzTarget(roomId);
    return this.#rooms.get(normalized)?.name ?? normalized;
  }

  self(): ChannelDirectoryEntry {
    return this.#buildUserEntry(this.#publicKey);
  }

  listPeers(params: { query?: string | null; limit?: number | null }): ChannelDirectoryEntry[] {
    const peers = new Set<string>();
    for (const roomId of this.activeRoomIds()) {
      const membership = this.#memberships.get(roomId);
      if (!membership) {
        continue;
      }
      for (const publicKey of membership.members) {
        if (publicKey !== this.#publicKey) {
          peers.add(publicKey);
        }
      }
    }
    const entries = [...peers]
      .map((publicKey) => this.#buildUserEntry(publicKey))
      .toSorted(compareDirectoryEntries);
    return applyQueryAndLimit(entries, params);
  }

  listGroups(params: { query?: string | null; limit?: number | null }): ChannelDirectoryEntry[] {
    const entries = this.activeRoomIds()
      .map((roomId) => this.#buildRoomEntry(roomId))
      .toSorted(compareDirectoryEntries);
    return applyQueryAndLimit(entries, params);
  }

  listGroupMembers(params: { groupId: string; limit?: number | null }): ChannelDirectoryEntry[] {
    let roomId: string;
    try {
      roomId = parseBuzzTarget(params.groupId);
    } catch {
      return [];
    }
    if (this.#rooms.get(roomId)?.archived) {
      return [];
    }
    const membership = this.#memberships.get(roomId);
    if (!membership) {
      return [];
    }
    const entries = [...membership.members]
      .map((publicKey) => {
        const entry = this.#buildUserEntry(publicKey);
        entry.raw = {
          publicKey,
          role: membership.roles.get(publicKey),
          roomId,
        };
        return entry;
      })
      .toSorted(compareDirectoryEntries);
    return applyQueryAndLimit(entries, { limit: params.limit });
  }

  #buildUserEntry(publicKey: string): ChannelDirectoryEntry {
    const profile = this.#profiles.get(publicKey);
    const name =
      profile?.displayName ??
      (publicKey === this.#publicKey
        ? this.#fallbackProfileName
        : fallbackPublicKeyLabel(publicKey));
    return {
      kind: "user",
      id: publicKey,
      name,
      handle: profile?.handle,
      avatarUrl: profile?.avatarUrl,
      raw: { publicKey },
    };
  }

  #buildRoomEntry(roomId: string): ChannelDirectoryEntry {
    const room = this.#rooms.get(roomId);
    return {
      kind: "group",
      id: buildBuzzTarget(roomId),
      name: room?.name ?? roomId,
      handle: room?.name ? `#${room.name}` : undefined,
      raw: { roomId },
    };
  }
}

function compareDirectoryEntries(a: ChannelDirectoryEntry, b: ChannelDirectoryEntry): number {
  const aLabel = a.name ?? a.handle ?? a.id;
  const bLabel = b.name ?? b.handle ?? b.id;
  return aLabel.localeCompare(bLabel) || a.id.localeCompare(b.id);
}
