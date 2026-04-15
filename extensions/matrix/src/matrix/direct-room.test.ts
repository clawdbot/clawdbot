import { describe, expect, it, vi } from "vitest";
import { inspectMatrixDirectRoomEvidence } from "./direct-room.js";
import type { MatrixClient } from "./sdk.js";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
    getRoomStateEvent: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as MatrixClient;
}

describe("inspectMatrixDirectRoomEvidence", () => {
  it("does not retry getUserId when callers explicitly pass a missing self user", async () => {
    const getUserId = vi.fn(async () => "@bot:example.org");
    const client = createClient({ getUserId });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
      selfUserId: null,
    });

    expect(getUserId).not.toHaveBeenCalled();
    expect(result.strict).toBe(false);
  });

  it("resolves selfUserId when callers leave it undefined", async () => {
    const getUserId = vi.fn(async () => "@bot:example.org");
    const client = createClient({ getUserId });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(getUserId).toHaveBeenCalledTimes(1);
    expect(result.strict).toBe(true);
  });

  it("records only the local member-state direct flag", async () => {
    const client = createClient({
      getRoomStateEvent: vi.fn(async (_roomId: string, _eventType: string, stateKey: string) =>
        stateKey === "@bot:example.org" ? { is_direct: false } : { is_direct: true },
      ),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(true);
    expect(result.memberStateFlag).toBe(false);
    expect(result.viaMemberState).toBe(false);
  });
});
