import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { getMatrixMemberInfo, getMatrixRoomInfo } from "./room.js";

function createRoomClient() {
  const getRoomStateEvent = vi.fn(async (_roomId: string, eventType: string) => {
    switch (eventType) {
      case "m.room.name":
        return { name: "Ops Room" };
      case "m.room.topic":
        return { topic: "Incidents" };
      case "m.room.canonical_alias":
        return { alias: "#ops:example.org" };
      default:
        throw new Error(`unexpected state event ${eventType}`);
    }
  });
  const getJoinedRoomMembers = vi.fn(async () => [
    { user_id: "@alice:example.org" },
    { user_id: "@bot:example.org" },
  ]);
  const getUserProfile = vi.fn(async () => ({
    displayname: "Alice",
    avatar_url: "mxc://example.org/alice",
  }));

  return {
    client: {
      getRoomStateEvent,
      getJoinedRoomMembers,
      getUserProfile,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    getRoomStateEvent,
    getJoinedRoomMembers,
    getUserProfile,
  };
}

describe("matrix room actions", () => {
  it("returns room details from the resolved Matrix room id", async () => {
    const { client, getJoinedRoomMembers, getRoomStateEvent } = createRoomClient();

    const result = await getMatrixRoomInfo("room:!ops:example.org", { client });

    expect(getRoomStateEvent).toHaveBeenCalledWith("!ops:example.org", "m.room.name", "");
    expect(getJoinedRoomMembers).toHaveBeenCalledWith("!ops:example.org");
    expect(result).toEqual({
      roomId: "!ops:example.org",
      name: "Ops Room",
      topic: "Incidents",
      canonicalAlias: "#ops:example.org",
      altAliases: [],
      memberCount: 2,
    });
  });

  it("resolves optional room ids when looking up member info", async () => {
    const { client, getUserProfile } = createRoomClient();

    const result = await getMatrixMemberInfo("@alice:example.org", {
      client,
      roomId: "room:!ops:example.org",
    });

    expect(getUserProfile).toHaveBeenCalledWith("@alice:example.org");
    expect(result).toEqual({
      userId: "@alice:example.org",
      profile: {
        displayName: "Alice",
        avatarUrl: "mxc://example.org/alice",
      },
      membership: null,
      powerLevel: null,
      displayName: "Alice",
      roomId: "!ops:example.org",
    });
  });
});
