import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
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

let sendReactionSignal: typeof import("./send-reactions.js").sendReactionSignal;
let removeReactionSignal: typeof import("./send-reactions.js").removeReactionSignal;

describe("sendReactionSignal", () => {
  beforeAll(async () => {
    ({ sendReactionSignal, removeReactionSignal } = await import("./send-reactions.js"));
  });

  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 123 });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
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
    await removeReactionSignal("+15551230000", 456, "❌");

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });
});
