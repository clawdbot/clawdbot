import { describe, expect, it, vi } from "vitest";
import { reefOutboundAdapter } from "./outbound.js";
import { setActiveReef } from "./runtime.js";

describe("reefOutboundAdapter", () => {
  it("delegates delivery to the Gateway that owns the active encrypted flow", () => {
    expect(reefOutboundAdapter.deliveryMode).toBe("gateway");
  });

  it("normalizes the SDK target and delegates only message content/context to the guarded flow", async () => {
    const send = vi.fn(async () => "01JZ0000000000000000000200");
    setActiveReef({ flow: { send }, friends: {}, reviews: {} } as never);

    await expect(
      reefOutboundAdapter.sendText!({
        cfg: {},
        accountId: "default",
        to: "reef:Alice",
        text: "hello",
        threadId: 42,
        replyToId: "01JZ0000000000000000000199",
      } as never),
    ).resolves.toEqual({
      channel: "reef",
      messageId: "01JZ0000000000000000000200",
      chatId: "alice",
      toJid: "reef:alice",
    });
    expect(send).toHaveBeenCalledWith("alice", "hello", {
      thread: "42",
      replyTo: "01JZ0000000000000000000199",
    });
  });
});
