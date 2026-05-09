import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";

type RoomStateHandler = (
  roomId: string,
  eventType: string,
  stateKey: string,
) => Promise<Record<string, unknown>>;

type RoomInfoClientStub = MatrixClient & {
  getRoomStateEvent: ReturnType<typeof vi.fn>;
};

function createRoomStateClient(handler: RoomStateHandler): RoomInfoClientStub {
  return {
    getRoomStateEvent: vi.fn(handler),
  } as unknown as RoomInfoClientStub;
}

function createClientStub() {
  return createRoomStateClient(async (roomId, eventType, stateKey) => {
    if (eventType === "m.room.name") {
      return { name: `Room ${roomId}` };
    }
    if (eventType === "m.room.canonical_alias") {
      return {
        alias: `#alias-${roomId}:example.org`,
        alt_aliases: [`#alt-${roomId}:example.org`],
      };
    }
    if (eventType === "m.room.member") {
      return { displayname: `Display ${roomId}:${stateKey}` };
    }
    return {};
  });
}

function createMissingMetadataError() {
  const err = new Error("M_NOT_FOUND");
  Object.assign(err, {
    statusCode: 404,
    body: { errcode: "M_NOT_FOUND" },
  });
  return err;
}

function getRoomStateCallCount(client: RoomInfoClientStub, eventType: string) {
  let count = 0;
  for (const [, type] of client.getRoomStateEvent.mock.calls) {
    if (type === eventType) {
      count++;
    }
  }
  return count;
}

describe("createMatrixRoomInfoResolver", () => {
  it("caches room names and member display names, and loads aliases only on demand", async () => {
    const client = createClientStub();
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(resolver.getRoomInfo("!room:example.org")).resolves.toEqual({
      name: "Room !room:example.org",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: false,
    });
    await resolver.getRoomInfo("!room:example.org");
    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toEqual({
      name: "Room !room:example.org",
      canonicalAlias: "#alias-!room:example.org:example.org",
      altAliases: ["#alt-!room:example.org:example.org"],
      nameResolved: true,
      aliasesResolved: true,
    });
    await resolver.getRoomInfo("!room:example.org", { includeAliases: true });
    await resolver.getMemberDisplayName("!room:example.org", "@alice:example.org");
    await resolver.getMemberDisplayName("!room:example.org", "@alice:example.org");

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(3);
  });

  it("caches fallback user IDs when member display names are missing", async () => {
    const client = createRoomStateClient(async () => ({}));
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(
      resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
    ).resolves.toBe("@alice:example.org");
    await expect(
      resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
    ).resolves.toBe("@alice:example.org");

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);
  });

  it("marks unresolved room metadata when room info lookups fail", async () => {
    const client = createRoomStateClient(async (_roomId, eventType) => {
      if (eventType === "m.room.member") {
        return {};
      }
      throw new Error("room info unavailable");
    });
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toEqual({
      altAliases: [],
      aliasesResolved: false,
      nameResolved: false,
    });
  });

  it("treats missing room metadata as resolved-empty state", async () => {
    const client = createRoomStateClient(async (_roomId, eventType) => {
      if (eventType === "m.room.name" || eventType === "m.room.canonical_alias") {
        throw createMissingMetadataError();
      }
      return {};
    });
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toEqual({
      altAliases: [],
      aliasesResolved: true,
      nameResolved: true,
    });
  });

  it("retries room metadata after a transient lookup failure", async () => {
    const client = createRoomStateClient(async (_roomId, eventType) => {
      if (eventType === "m.room.name") {
        if (getRoomStateCallCount(client, eventType) === 1) {
          throw new Error("name lookup unavailable");
        }
        return { name: "Recovered Room" };
      }
      if (eventType === "m.room.canonical_alias") {
        if (getRoomStateCallCount(client, eventType) === 1) {
          throw new Error("alias lookup unavailable");
        }
        return {
          alias: "#recovered:example.org",
          alt_aliases: ["#alt-recovered:example.org"],
        };
      }
      return {};
    });
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toEqual({
      altAliases: [],
      aliasesResolved: false,
      nameResolved: false,
    });
    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toEqual({
      name: "Recovered Room",
      canonicalAlias: "#recovered:example.org",
      altAliases: ["#alt-recovered:example.org"],
      nameResolved: true,
      aliasesResolved: true,
    });
  });

  it("caches fallback user IDs when member display-name lookups fail", async () => {
    const client = createRoomStateClient(async () => {
      throw new Error("member lookup failed");
    });
    const resolver = createMatrixRoomInfoResolver(client);

    await expect(
      resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
    ).resolves.toBe("@alice:example.org");
    await expect(
      resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
    ).resolves.toBe("@alice:example.org");

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);
  });

  it("bounds cached room and member entries", async () => {
    const client = createClientStub();
    const resolver = createMatrixRoomInfoResolver(client);

    for (let i = 0; i <= 1024; i += 1) {
      await resolver.getRoomInfo(`!room-${i}:example.org`);
    }
    await resolver.getRoomInfo("!room-0:example.org");

    for (let i = 0; i <= 4096; i += 1) {
      await resolver.getMemberDisplayName("!room:example.org", `@user-${i}:example.org`);
    }
    await resolver.getMemberDisplayName("!room:example.org", "@user-0:example.org");

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(5124);
  });
});
