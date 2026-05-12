import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "../send/types.js";
import { createDirectRoomTracker } from "./direct.js";

type MockStateEvents = Record<string, Record<string, unknown>>;

function createMockClient(params: {
  isDm?: boolean;
  members?: string[];
  stateEvents?: MockStateEvents;
  dmCacheAvailable?: boolean;
  directAccountData?: Record<string, string[]>;
  setAccountDataError?: Error;
}) {
  let members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  const stateEvents = params.stateEvents ?? {};
  let directAccountData = params.directAccountData ?? {};
  const dmRoomIds = new Set<string>();
  if (params.isDm === true) {
    dmRoomIds.add("!room:example.org");
  }
  return {
    dms: {
      update: vi.fn().mockResolvedValue(params.dmCacheAvailable !== false),
      isDm: vi.fn().mockImplementation((roomId: string) => dmRoomIds.has(roomId)),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getAccountData: vi
      .fn()
      .mockImplementation(async (eventType: string) =>
        eventType === EventType.Direct ? directAccountData : undefined,
      ),
    getJoinedRoomMembers: vi.fn().mockImplementation(async () => members),
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (roomId: string, eventType: string, stateKey = "") => {
        const key = `${roomId}|${eventType}|${stateKey}`;
        const state = stateEvents[key];
        if (state === undefined) {
          throw new Error(`State event not found: ${key}`);
        }
        return state;
      }),
    setAccountData: vi.fn().mockImplementation(async (eventType: string, content: unknown) => {
      if (params.setAccountDataError) {
        throw params.setAccountDataError;
      }
      if (eventType !== EventType.Direct) {
        return;
      }
      directAccountData = (content as Record<string, string[]>) ?? {};
      dmRoomIds.clear();
      for (const value of Object.values(directAccountData)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const roomId of value) {
          if (typeof roomId === "string" && roomId.trim()) {
            dmRoomIds.add(roomId);
          }
        }
      }
    }),
    __setMembers(next: string[]) {
      members = next;
    },
  } as unknown as MatrixClient & {
    dms: {
      update: ReturnType<typeof vi.fn>;
      isDm: ReturnType<typeof vi.fn>;
    };
    getAccountData: ReturnType<typeof vi.fn>;
    getJoinedRoomMembers: ReturnType<typeof vi.fn>;
    getRoomStateEvent: ReturnType<typeof vi.fn>;
    setAccountData: ReturnType<typeof vi.fn>;
    __setMembers: (members: string[]) => void;
  };
}

describe("createDirectRoomTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats m.direct rooms as DMs", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not trust stale m.direct classifications for shared rooms", async () => {
    const client = createMockClient({
      isDm: true,
      members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not classify 2-member rooms as DMs when the dm cache refresh succeeds", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("promotes strict unmapped rooms when the per-room fallback gate allows it", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client, {
      canPromoteUnmappedStrictRoom: () => true,
    });

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@alice:example.org": ["!room:example.org"],
    });
  });

  it("does not promote strict unmapped rooms when the per-room fallback gate vetoes it", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client, {
      canPromoteUnmappedStrictRoom: () => false,
    });

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("falls back to strict 2-member membership before m.direct account data is available", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("keeps using the strict 2-member fallback until the dm cache seeds successfully", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.dms.update).toHaveBeenCalledTimes(1);
  });

  it("does not classify rooms with extra members as DMs when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@alice:example.org", "@bot:example.org", "@observer:example.org"],
      dmCacheAvailable: false,
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.getRoomStateEvent).not.toHaveBeenCalled();
  });

  it("does not treat sender is_direct member state as a DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("treats self is_direct member state as a DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("treats self is_direct false member state as a non-DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: false,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("treats strict rooms from recent invites as DMs after the dm cache has seeded", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@alice:example.org": ["!room:example.org"],
    });
  });

  it("keeps recent invite candidates across room invalidation", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");
    tracker.invalidateRoom("!room:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("still rejects recent invite candidates when self member state is_direct is false", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
      },
    });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("does not promote recent invite candidates when local vetoes mark the room as non-DM", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
    });
    const tracker = createDirectRoomTracker(client, {
      canPromoteRecentInvite: () => false,
    });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("still treats recent invite candidates as DMs when m.direct repair fails", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      setAccountDataError: new Error("account data unavailable"),
    });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("keeps locally promoted direct rooms stable after repair failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      setAccountDataError: new Error("account data unavailable"),
    });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    tracker.invalidateRoom("!room:example.org");

    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("drops locally promoted direct rooms when room metadata later vetoes promotion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    let keepLocalPromotion = true;
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      setAccountDataError: new Error("account data unavailable"),
    });
    const tracker = createDirectRoomTracker(client, {
      canPromoteRecentInvite: () => true,
      shouldKeepLocallyPromotedDirectRoom: () => keepLocalPromotion,
    });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    keepLocalPromotion = false;
    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("does not classify 2-member rooms whose sender is not a joined member when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@mallory:example.org", "@bot:example.org"],
      dmCacheAvailable: false,
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("does not re-enable the strict 2-member fallback after the dm cache has seeded", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    client.dms.update.mockResolvedValue(false);
    tracker.invalidateRoom("!room:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("re-checks room membership after invalidation when fallback membership changes", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    client.__setMembers(["@alice:example.org", "@bot:example.org", "@mallory:example.org"]);
    tracker.invalidateRoom("!room:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("bounds joined-room membership cache size", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    for (let i = 0; i <= 1024; i += 1) {
      await tracker.isDirectMessage({
        roomId: `!room-${i}:example.org`,
        senderId: "@alice:example.org",
      });
    }

    await tracker.isDirectMessage({
      roomId: "!room-0:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1026);
  });

  it("refreshes dm and membership caches after the ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });
    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.dms.update).toHaveBeenCalledTimes(1);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.dms.update).toHaveBeenCalledTimes(2);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(2);
  });

  it("caches member-state direct flag lookups until the ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });
    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(2);
  });
});
