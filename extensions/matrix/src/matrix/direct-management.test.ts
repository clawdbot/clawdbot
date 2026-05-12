import { describe, expect, it, vi } from "vitest";
import {
  inspectMatrixDirectRooms,
  persistMatrixDirectRoomMapping,
  promoteMatrixDirectRoomCandidate,
  repairMatrixDirectRooms,
} from "./direct-management.js";
import type { MatrixClient } from "./sdk.js";
import { EventType } from "./send/types.js";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getAccountData: vi.fn(async () => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    getJoinedRoomMembers: vi.fn(async () => [] as string[]),
    getRoomStateEvent: vi.fn(async () => ({})),
    setAccountData: vi.fn(async () => undefined),
    createDirectRoom: vi.fn(async () => "!created:example.org"),
    ...overrides,
  } as unknown as MatrixClient;
}

function expectDirectMappingWrite(
  setAccountData: ReturnType<typeof vi.fn>,
  remoteUserId: string,
  roomIds: string[],
) {
  expect(setAccountData).toHaveBeenCalledTimes(1);
  const [eventType, content] = setAccountData.mock.calls.at(0) ?? [];
  expect(eventType).toBe(EventType.Direct);
  expect((content as Record<string, string[]> | undefined)?.[remoteUserId]).toEqual(roomIds);
}

describe("inspectMatrixDirectRooms", () => {
  it("prefers strict mapped rooms over discovered rooms", async () => {
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!dm:example.org", "!shared:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!dm:example.org", "!shared:example.org"]),
      getJoinedRoomMembers: vi.fn(async (roomId: string) =>
        roomId === "!dm:example.org"
          ? ["@bot:example.org", "@alice:example.org"]
          : ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
      ),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!dm:example.org");
    expect(result.mappedRooms.map(({ roomId, strict }) => ({ roomId, strict }))).toEqual([
      { roomId: "!dm:example.org", strict: true },
      { roomId: "!shared:example.org", strict: false },
    ]);
  });

  it("still surfaces joined strict rooms when an older mapped room is strict", async () => {
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!older:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!older:example.org", "!fresh:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!older:example.org");
    expect(result.discoveredStrictRoomIds).toEqual(["!fresh:example.org"]);
  });

  it("falls back to discovered strict joined rooms when m.direct is stale", async () => {
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!stale:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!stale:example.org", "!fresh:example.org"]),
      getJoinedRoomMembers: vi.fn(async (roomId: string) =>
        roomId === "!fresh:example.org"
          ? ["@bot:example.org", "@alice:example.org"]
          : ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
      ),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!fresh:example.org");
    expect(result.discoveredStrictRoomIds).toEqual(["!fresh:example.org"]);
  });

  it("prefers discovered rooms marked direct in local member state over plain strict rooms", async () => {
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!fallback:example.org", "!explicit:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      getRoomStateEvent: vi.fn(async (roomId: string, _eventType: string, userId: string) =>
        roomId === "!explicit:example.org" && userId === "@bot:example.org"
          ? { is_direct: true }
          : {},
      ),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!explicit:example.org");
    expect(result.discoveredStrictRoomIds).toEqual([
      "!fallback:example.org",
      "!explicit:example.org",
    ]);
  });

  it("ignores remote member-state direct flags when ranking discovered rooms", async () => {
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!fallback:example.org", "!remote-marked:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      getRoomStateEvent: vi.fn(async (roomId: string, _eventType: string, userId: string) =>
        roomId === "!remote-marked:example.org" && userId === "@alice:example.org"
          ? { is_direct: true }
          : {},
      ),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!fallback:example.org");
  });

  it("does not treat discovered rooms with local is_direct false as active DMs", async () => {
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!blocked:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      getRoomStateEvent: vi.fn(async (_roomId: string, _eventType: string, userId: string) => ({
        is_direct: userId === "@bot:example.org" ? false : undefined,
      })),
    });

    const result = await inspectMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBeNull();
    expect(result.discoveredStrictRoomIds).toStrictEqual([]);
  });
});

describe("repairMatrixDirectRooms", () => {
  it("repoints m.direct to an existing strict joined room", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!stale:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!stale:example.org", "!fresh:example.org"]),
      getJoinedRoomMembers: vi.fn(async (roomId: string) =>
        roomId === "!fresh:example.org"
          ? ["@bot:example.org", "@alice:example.org"]
          : ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
      ),
      setAccountData,
    });

    const result = await repairMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
      encrypted: true,
    });

    expect(result.activeRoomId).toBe("!fresh:example.org");
    expect(result.createdRoomId).toBeNull();
    expectDirectMappingWrite(setAccountData, "@alice:example.org", [
      "!fresh:example.org",
      "!stale:example.org",
    ]);
  });

  it("creates a fresh direct room when no healthy DM exists", async () => {
    const createDirectRoom = vi.fn(async () => "!created:example.org");
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!shared:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => [
        "@bot:example.org",
        "@alice:example.org",
        "@mallory:example.org",
      ]),
      createDirectRoom,
      setAccountData,
    });

    const result = await repairMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
      encrypted: true,
    });

    expect(createDirectRoom).toHaveBeenCalledWith("@alice:example.org", { encrypted: true });
    expect(result.createdRoomId).toBe("!created:example.org");
    expectDirectMappingWrite(setAccountData, "@alice:example.org", ["!created:example.org"]);
  });

  it("persists discovered strict rooms alongside an older strict mapped room", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!older:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!older:example.org", "!fresh:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      setAccountData,
    });

    const result = await repairMatrixDirectRooms({
      client,
      remoteUserId: "@alice:example.org",
    });

    expect(result.activeRoomId).toBe("!older:example.org");
    expect(result.discoveredStrictRoomIds).toEqual(["!fresh:example.org"]);
    expect(result.changed).toBe(true);
    expect(result.directContentAfter["@alice:example.org"]).toEqual([
      "!older:example.org",
      "!fresh:example.org",
    ]);
    expectDirectMappingWrite(setAccountData, "@alice:example.org", [
      "!older:example.org",
      "!fresh:example.org",
    ]);
  });

  it("rejects unqualified Matrix user ids", async () => {
    const client = createClient();

    await expect(
      repairMatrixDirectRooms({
        client,
        remoteUserId: "alice",
      }),
    ).rejects.toThrow('Matrix user IDs must be fully qualified (got "alice")');
  });
});

describe("promoteMatrixDirectRoomCandidate", () => {
  it("classifies a strict room as direct and repairs m.direct", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      setAccountData,
    });

    const result = await promoteMatrixDirectRoomCandidate({
      client,
      remoteUserId: "@alice:example.org",
      roomId: "!fresh:example.org",
    });

    expect(result).toEqual({
      classifyAsDirect: true,
      repaired: true,
      roomId: "!fresh:example.org",
      reason: "promoted",
    });
    expectDirectMappingWrite(setAccountData, "@alice:example.org", ["!fresh:example.org"]);
  });

  it("does not classify rooms with local is_direct false as direct", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      getRoomStateEvent: vi.fn(async (_roomId: string, _eventType: string, stateKey: string) =>
        stateKey === "@bot:example.org" ? { is_direct: false } : {},
      ),
      setAccountData,
    });

    const result = await promoteMatrixDirectRoomCandidate({
      client,
      remoteUserId: "@alice:example.org",
      roomId: "!blocked:example.org",
    });

    expect(result).toEqual({
      classifyAsDirect: false,
      repaired: false,
      reason: "local-explicit-false",
    });
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("returns already-mapped without rewriting account data", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!mapped:example.org", "!older:example.org"],
      })),
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      setAccountData,
    });

    const result = await promoteMatrixDirectRoomCandidate({
      client,
      remoteUserId: "@alice:example.org",
      roomId: "!mapped:example.org",
    });

    expect(result).toEqual({
      classifyAsDirect: true,
      repaired: false,
      roomId: "!mapped:example.org",
      reason: "already-mapped",
    });
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("still classifies the room as direct when repair fails", async () => {
    const client = createClient({
      getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
      setAccountData: vi.fn(async () => {
        throw new Error("account data unavailable");
      }),
    });

    const result = await promoteMatrixDirectRoomCandidate({
      client,
      remoteUserId: "@alice:example.org",
      roomId: "!fresh:example.org",
    });

    expect(result).toEqual({
      classifyAsDirect: true,
      repaired: false,
      roomId: "!fresh:example.org",
      reason: "repair-failed",
    });
  });

  it("serializes concurrent m.direct writes so distinct mappings are not lost", async () => {
    let directContent: Record<string, string[]> = {};
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      releaseFirstWrite = () => {
        resolve();
      };
    });
    if (!releaseFirstWrite) {
      throw new Error("Expected first m.direct write release callback to be initialized");
    }
    let writeCount = 0;
    const setAccountData = vi.fn(async (_eventType: string, content: Record<string, string[]>) => {
      writeCount += 1;
      if (writeCount === 1) {
        await firstWriteStarted;
      }
      directContent = { ...content };
    });
    const client = createClient({
      getAccountData: vi.fn(async () => ({ ...directContent })),
      setAccountData,
    });

    const firstWrite = persistMatrixDirectRoomMapping({
      client,
      remoteUserId: "@alice:example.org",
      roomId: "!alice:example.org",
    });
    await vi.waitFor(() => {
      expect(setAccountData).toHaveBeenCalledTimes(1);
    });

    const secondWrite = persistMatrixDirectRoomMapping({
      client,
      remoteUserId: "@bob:example.org",
      roomId: "!bob:example.org",
    });

    releaseFirstWrite();
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([true, true]);

    expect(directContent).toEqual({
      "@alice:example.org": ["!alice:example.org"],
      "@bob:example.org": ["!bob:example.org"],
    });
  });
});
