import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const loadSendReactions = async () => await import("./send-reactions.js");

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

describe("sendReactionSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 123 });
    vi.resetModules();
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    const { sendReactionSignal } = await loadSendReactions();
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥");

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledWith("sendReaction", expect.any(Object), expect.any(Object));
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    const { sendReactionSignal } = await loadSendReactions();
    await sendReactionSignal("", 123, "✅", {
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    const { removeReactionSignal } = await loadSendReactions();
    await removeReactionSignal("+15551230000", 456, "❌");

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });
});
