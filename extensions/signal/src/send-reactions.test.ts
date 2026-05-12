import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
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

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

let sendReactionSignal: typeof import("./send-reactions.js").sendReactionSignal;
let removeReactionSignal: typeof import("./send-reactions.js").removeReactionSignal;

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {},
      },
    },
  },
};

function requireRpcParams(): Record<string, unknown> {
  const [call] = rpcMock.mock.calls;
  if (!call) {
    throw new Error("expected Signal RPC call");
  }
  const [, params] = call;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected Signal RPC params");
  }
  return params as Record<string, unknown>;
}

describe("sendReactionSignal", () => {
  beforeAll(async () => {
    ({ sendReactionSignal, removeReactionSignal } = await import("./send-reactions.js"));
  });

  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 123 });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendReaction",
      {
        emoji: "🔥",
        targetTimestamp: 123,
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        recipients: ["123e4567-e89b-12d3-a456-426614174000"],
        account: "+15550001111",
      },
      {
        baseUrl: "http://signal.local",
        timeoutMs: undefined,
        apiMode: undefined,
      },
    );
    const params = requireRpcParams();
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      cfg: SIGNAL_TEST_CFG,
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = requireRpcParams();
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌", { cfg: SIGNAL_TEST_CFG });

    const params = requireRpcParams();
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });
});
