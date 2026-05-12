import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "./types.js";

const { resolveMatrixRoomId, normalizeThreadId } = await import("./targets.js");

const BOT_USER_ID = "@bot:example.org";

const makeMappedDirectClient = (params: {
  userId: string;
  roomId: string;
  botId?: string;
  extra?: Record<string, unknown>;
}) =>
  ({
    getAccountData: vi.fn().mockResolvedValue({
      [params.userId]: [params.roomId],
    }),
    getUserId: vi.fn().mockResolvedValue(params.botId ?? BOT_USER_ID),
    getJoinedRooms: vi.fn(),
    getJoinedRoomMembers: vi.fn().mockResolvedValue([params.botId ?? BOT_USER_ID, params.userId]),
    setAccountData: vi.fn(),
    ...params.extra,
  }) as unknown as MatrixClient;

const makeFallbackDirectClient = (params: {
  userId: string;
  roomIds: string[];
  botId?: string;
  members?: string[];
  extra?: Record<string, unknown>;
}) =>
  ({
    getAccountData: vi.fn().mockRejectedValue(new Error("nope")),
    getUserId: vi.fn().mockResolvedValue(params.botId ?? BOT_USER_ID),
    getJoinedRooms: vi.fn().mockResolvedValue(params.roomIds),
    getJoinedRoomMembers: vi
      .fn()
      .mockResolvedValue(params.members ?? [params.botId ?? BOT_USER_ID, params.userId]),
    setAccountData: vi.fn().mockResolvedValue(undefined),
    ...params.extra,
  }) as unknown as MatrixClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveMatrixRoomId", () => {
  it("uses m.direct when available", async () => {
    const userId = "@user:example.org";
    const client = makeMappedDirectClient({ userId, roomId: "!room:example.org" });

    const roomId = await resolveMatrixRoomId(client, userId);

    expect(roomId).toBe("!room:example.org");
    expect(client.getJoinedRooms).toHaveBeenCalledTimes(1);
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("falls back to joined rooms and persists m.direct", async () => {
    const userId = "@fallback:example.org";
    const roomId = "!room:example.org";
    const client = makeFallbackDirectClient({ userId, roomIds: [roomId] });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, { [userId]: [roomId] });
  });

  it("prefers joined rooms marked direct in local member state over plain strict rooms", async () => {
    const userId = "@fallback:example.org";
    const client = makeFallbackDirectClient({
      userId,
      roomIds: ["!fallback:example.org", "!explicit:example.org"],
      extra: {
        getRoomStateEvent: vi
          .fn()
          .mockImplementation(async (roomId: string, _eventType: string, stateKey: string) =>
            roomId === "!explicit:example.org" && stateKey === BOT_USER_ID
              ? { is_direct: true }
              : {},
          ),
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe("!explicit:example.org");
    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      [userId]: ["!explicit:example.org"],
    });
  });

  it("ignores remote member-state direct flags when resolving a direct room", async () => {
    const userId = "@fallback:example.org";
    const client = makeFallbackDirectClient({
      userId,
      roomIds: ["!fallback:example.org", "!remote-marked:example.org"],
      extra: {
        getRoomStateEvent: vi
          .fn()
          .mockImplementation(async (roomId: string, _eventType: string, stateKey: string) =>
            roomId === "!remote-marked:example.org" && stateKey === userId
              ? { is_direct: true }
              : {},
          ),
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe("!fallback:example.org");
    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      [userId]: ["!fallback:example.org"],
    });
  });

  it("continues when a room member lookup fails", async () => {
    const userId = "@continue:example.org";
    const roomId = "!good:example.org";
    const setAccountData = vi.fn().mockResolvedValue(undefined);
    const getJoinedRoomMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(["@bot:example.org", userId]);
    const client = {
      getAccountData: vi.fn().mockRejectedValue(new Error("nope")),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi.fn().mockResolvedValue(["!bad:example.org", roomId]),
      getJoinedRoomMembers,
      setAccountData,
    } as unknown as MatrixClient;

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(setAccountData).toHaveBeenCalled();
  });

  it("does not fall back to larger shared rooms for direct-user sends", async () => {
    const userId = "@group:example.org";
    const roomId = "!group:example.org";
    const client = makeFallbackDirectClient({
      userId,
      roomIds: [roomId],
      members: [BOT_USER_ID, userId, "@extra:example.org"],
    });

    await expect(resolveMatrixRoomId(client, userId)).rejects.toThrow(
      `No direct room found for ${userId} (m.direct missing)`,
    );
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("accepts nested Matrix user target prefixes", async () => {
    const userId = "@prefixed:example.org";
    const roomId = "!prefixed-room:example.org";
    const client = makeMappedDirectClient({
      userId,
      roomId,
      extra: {
        resolveRoom: vi.fn(),
      },
    });

    const resolved = await resolveMatrixRoomId(client, `matrix:user:${userId}`);

    expect(resolved).toBe(roomId);
    expect(client.resolveRoom).not.toHaveBeenCalled();
  });

  it("scopes direct-room cache per Matrix client", async () => {
    const userId = "@shared:example.org";
    const clientA = {
      getAccountData: vi.fn().mockResolvedValue({
        [userId]: ["!room-a:example.org"],
      }),
      getUserId: vi.fn().mockResolvedValue("@bot-a:example.org"),
      getJoinedRooms: vi.fn(),
      getJoinedRoomMembers: vi.fn().mockResolvedValue(["@bot-a:example.org", userId]),
      setAccountData: vi.fn(),
      resolveRoom: vi.fn(),
    } as unknown as MatrixClient;
    const clientB = {
      getAccountData: vi.fn().mockResolvedValue({
        [userId]: ["!room-b:example.org"],
      }),
      getUserId: vi.fn().mockResolvedValue("@bot-b:example.org"),
      getJoinedRooms: vi.fn(),
      getJoinedRoomMembers: vi.fn().mockResolvedValue(["@bot-b:example.org", userId]),
      setAccountData: vi.fn(),
      resolveRoom: vi.fn(),
    } as unknown as MatrixClient;

    await expect(resolveMatrixRoomId(clientA, userId)).resolves.toBe("!room-a:example.org");
    await expect(resolveMatrixRoomId(clientB, userId)).resolves.toBe("!room-b:example.org");

    expect(clientA.getAccountData).toHaveBeenCalledTimes(1);
    expect(clientB.getAccountData).toHaveBeenCalledTimes(1);
  });

  it("ignores m.direct entries that point at shared rooms", async () => {
    const userId = "@shared:example.org";
    const client = {
      getAccountData: vi.fn().mockResolvedValue({
        [userId]: ["!shared-room:example.org", "!dm-room:example.org"],
      }),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi.fn(),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValueOnce(["@bot:example.org", userId, "@extra:example.org"])
        .mockResolvedValueOnce(["@bot:example.org", userId]),
      setAccountData: vi.fn(),
      resolveRoom: vi.fn(),
    } as unknown as MatrixClient;

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room:example.org");
  });

  it("revalidates cached direct rooms before reuse when membership changes", async () => {
    const userId = "@shared:example.org";
    const directRooms = ["!dm-room-1:example.org"];
    const membersByRoom = new Map<string, string[]>([
      ["!dm-room-1:example.org", ["@bot:example.org", userId]],
      ["!dm-room-2:example.org", ["@bot:example.org", userId]],
    ]);
    const client = {
      getAccountData: vi.fn().mockImplementation(async () => ({
        [userId]: [...directRooms],
      })),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi
        .fn()
        .mockResolvedValue(["!dm-room-1:example.org", "!dm-room-2:example.org"]),
      getJoinedRoomMembers: vi
        .fn()
        .mockImplementation(async (roomId: string) => membersByRoom.get(roomId) ?? []),
      setAccountData: vi.fn(),
      resolveRoom: vi.fn(),
    } as unknown as MatrixClient;

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room-1:example.org");

    directRooms.splice(0, directRooms.length, "!dm-room-1:example.org", "!dm-room-2:example.org");
    membersByRoom.set("!dm-room-1:example.org", [
      "@bot:example.org",
      userId,
      "@mallory:example.org",
    ]);

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room-2:example.org");
  });
});

describe("normalizeThreadId", () => {
  it("returns null for empty thread ids", () => {
    expect(normalizeThreadId("   ")).toBeNull();
    expect(normalizeThreadId("$thread")).toBe("$thread");
  });
});
