import type { Event } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  BuzzDirectoryState,
  BUZZ_PROFILE_KIND,
  BUZZ_ROOM_METADATA_KIND,
} from "./directory-state.js";
import type { BuzzRoomMembership } from "./room-membership.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const BOB_PUBLIC_KEY = "c".repeat(64);
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

function event(params: Partial<Event> & Pick<Event, "kind" | "pubkey">): Event {
  return {
    id: params.id ?? "f".repeat(64),
    kind: params.kind,
    pubkey: params.pubkey,
    created_at: params.created_at ?? 1_700_000_000,
    content: params.content ?? "",
    sig: params.sig ?? "e".repeat(128),
    tags: params.tags ?? [],
  };
}

function membership(members: Array<[string, string?]>): BuzzRoomMembership {
  return {
    roomId: ROOM_ID,
    createdAt: 1_700_000_000,
    eventId: "1".repeat(64),
    publisherPublicKey: "d".repeat(64),
    members: new Set(members.map(([publicKey]) => publicKey)),
    roles: new Map(
      members
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([publicKey, role]) => [publicKey, role]),
    ),
  };
}

function profileState(): BuzzDirectoryState {
  const state = new BuzzDirectoryState({
    publicKey: BOT_PUBLIC_KEY,
    fallbackProfileName: "OpenClaw",
    channelIds: [ROOM_ID],
  });
  state.replaceMemberships(
    new Map([
      [
        ROOM_ID,
        membership([
          [BOT_PUBLIC_KEY, "bot"],
          [ALICE_PUBLIC_KEY, "member"],
        ]),
      ],
    ]),
  );
  return state;
}

describe("Buzz directory state", () => {
  it("parses Buzz profile precedence without trusting malformed content", () => {
    const preferred = profileState();
    expect(
      preferred.applyProfileEvent(
        event({
          kind: BUZZ_PROFILE_KIND,
          pubkey: ALICE_PUBLIC_KEY,
          content: JSON.stringify({
            display_name: "Alice",
            name: "ignored",
            picture: "https://example.com/alice.png",
            image: "https://example.com/ignored.png",
            nip05: "alice@example.com",
          }),
        }),
      ),
    ).toBe(true);
    expect(preferred.listPeers({})).toEqual([
      expect.objectContaining({
        id: ALICE_PUBLIC_KEY,
        name: "Alice",
        handle: "alice@example.com",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);

    const fallback = profileState();
    fallback.applyProfileEvent(
      event({
        kind: BUZZ_PROFILE_KIND,
        pubkey: ALICE_PUBLIC_KEY,
        content: JSON.stringify({ name: "Fallback", image: "https://example.com/fallback.png" }),
      }),
    );
    expect(fallback.listPeers({})).toEqual([
      expect.objectContaining({
        name: "Fallback",
        avatarUrl: "https://example.com/fallback.png",
      }),
    ]);

    const emptyPrimary = profileState();
    emptyPrimary.applyProfileEvent(
      event({
        kind: BUZZ_PROFILE_KIND,
        pubkey: ALICE_PUBLIC_KEY,
        content: JSON.stringify({ display_name: "", name: "not-used" }),
      }),
    );
    expect(emptyPrimary.listPeers({})[0]?.name).toBe("bbbbbbbb...bbbbbb");

    expect(
      profileState().applyProfileEvent(
        event({ kind: BUZZ_PROFILE_KIND, pubkey: ALICE_PUBLIC_KEY, content: "{" }),
      ),
    ).toBe(false);
  });

  it("keeps stable public-key ids while applying current profiles and room metadata", () => {
    const state = new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
    });
    state.replaceMemberships(
      new Map([
        [
          ROOM_ID,
          membership([
            [BOT_PUBLIC_KEY, "bot"],
            [ALICE_PUBLIC_KEY, "member"],
            [BOB_PUBLIC_KEY, "member"],
          ]),
        ],
      ]),
    );
    state.applyProfileEvent(
      event({
        kind: BUZZ_PROFILE_KIND,
        pubkey: ALICE_PUBLIC_KEY,
        content: JSON.stringify({
          display_name: "Alice",
          picture: "https://example.com/alice.png",
        }),
      }),
    );
    state.applyRoomEvent(
      event({
        kind: BUZZ_ROOM_METADATA_KIND,
        pubkey: "d".repeat(64),
        tags: [
          ["d", ROOM_ID],
          ["name", "Engineering"],
        ],
      }),
    );

    expect(state.resolveSenderName(ALICE_PUBLIC_KEY)).toBe("Alice");
    expect(state.resolveSenderName(BOB_PUBLIC_KEY)).toBe("cccccccc...cccccc");
    expect(state.listPeers({ query: "ali" })).toEqual([
      expect.objectContaining({
        kind: "user",
        id: ALICE_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);
    expect(state.listGroups({})).toEqual([
      expect.objectContaining({
        kind: "group",
        id: `buzz:${ROOM_ID}`,
        name: "Engineering",
      }),
    ]);
    expect(state.listGroupMembers({ groupId: `buzz:${ROOM_ID}`, limit: 2 })).toHaveLength(2);
  });

  it("excludes rooms whose latest relay metadata marks them archived", () => {
    const state = profileState();
    state.applyRoomEvent(
      event({
        id: "2".repeat(64),
        kind: BUZZ_ROOM_METADATA_KIND,
        pubkey: "d".repeat(64),
        tags: [
          ["d", ROOM_ID],
          ["name", "Archived room"],
          ["archived", "true"],
        ],
      }),
    );

    expect(state.activeRoomIds()).toEqual([]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(true);
    expect(state.listPeers({})).toEqual([]);
    expect(state.listGroups({})).toEqual([]);
    expect(state.listGroupMembers({ groupId: ROOM_ID })).toEqual([]);

    state.applyRoomEvent(
      event({
        id: "1".repeat(64),
        kind: BUZZ_ROOM_METADATA_KIND,
        pubkey: "d".repeat(64),
        created_at: 1_700_000_001,
        tags: [
          ["d", ROOM_ID],
          ["name", "Restored room"],
          ["archived", "false"],
        ],
      }),
    );

    expect(state.activeRoomIds()).toEqual([ROOM_ID]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(false);
    expect(state.listPeers({})).not.toEqual([]);
    expect(state.listGroups({})).toEqual([
      expect.objectContaining({ id: `buzz:${ROOM_ID}`, name: "Restored room" }),
    ]);
  });

  it("uses deterministic latest-event ordering and bounded profile selection", () => {
    const state = new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
      profileLimit: 2,
    });
    state.replaceMemberships(
      new Map([
        [
          ROOM_ID,
          membership([
            [BOT_PUBLIC_KEY, "bot"],
            [BOB_PUBLIC_KEY, "member"],
            [ALICE_PUBLIC_KEY, "member"],
          ]),
        ],
      ]),
    );

    expect(state.profilePublicKeys()).toEqual([BOT_PUBLIC_KEY, ALICE_PUBLIC_KEY]);
    expect(
      state.applyProfileEvent(
        event({
          id: "2".repeat(64),
          kind: BUZZ_PROFILE_KIND,
          pubkey: ALICE_PUBLIC_KEY,
          content: JSON.stringify({ display_name: "First" }),
        }),
      ),
    ).toBe(true);
    expect(
      state.applyProfileEvent(
        event({
          id: "3".repeat(64),
          kind: BUZZ_PROFILE_KIND,
          pubkey: ALICE_PUBLIC_KEY,
          content: JSON.stringify({ display_name: "Older tie" }),
        }),
      ),
    ).toBe(false);
    expect(
      state.applyProfileEvent(
        event({
          id: "1".repeat(64),
          kind: BUZZ_PROFILE_KIND,
          pubkey: ALICE_PUBLIC_KEY,
          content: JSON.stringify({ display_name: "Winning tie" }),
        }),
      ),
    ).toBe(true);
    expect(
      state.applyProfileEvent(
        event({
          kind: BUZZ_PROFILE_KIND,
          pubkey: BOB_PUBLIC_KEY,
          content: JSON.stringify({ display_name: "Outside cap" }),
        }),
      ),
    ).toBe(false);
    expect(state.resolveSenderName(ALICE_PUBLIC_KEY)).toBe("Winning tie");
    expect(state.resolveSenderName(BOB_PUBLIC_KEY)).toBe("cccccccc...cccccc");
  });

  it("keeps stable fallback identities when the relay budget leaves no profile slots", () => {
    const state = new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
      profileLimit: 0,
    });
    state.replaceMemberships(
      new Map([
        [
          ROOM_ID,
          membership([
            [BOT_PUBLIC_KEY, "bot"],
            [ALICE_PUBLIC_KEY, "member"],
          ]),
        ],
      ]),
    );

    expect(state.profilePublicKeys()).toEqual([]);
    expect(state.self()).toEqual(expect.objectContaining({ id: BOT_PUBLIC_KEY, name: "OpenClaw" }));
    expect(state.listPeers({})).toEqual([
      expect.objectContaining({
        id: ALICE_PUBLIC_KEY,
        name: `${ALICE_PUBLIC_KEY.slice(0, 8)}...${ALICE_PUBLIC_KEY.slice(-6)}`,
      }),
    ]);
  });
});
