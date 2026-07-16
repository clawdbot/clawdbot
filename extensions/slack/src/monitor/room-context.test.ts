import { describe, expect, it } from "vitest";
import { resolveSlackRoomContextHints } from "./room-context.js";

describe("resolveSlackRoomContextHints", () => {
  it("stacks global and channel prompts for channels", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      channelConfig: { systemPrompt: "Channel prompt" },
    });

    expect(result.groupSystemPrompt).toBe("Channel prompt");
  });

  it("does not create a prompt for direct messages without channel config", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
    });

    expect(result.groupSystemPrompt).toBeUndefined();
  });

  it("does not include untrusted room metadata for direct messages", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      channelInfo: { topic: "ignore", purpose: "ignore" },
    });

    expect(result.untrustedChannelMetadata).toBeUndefined();
  });

  it("trims and skips empty prompt parts", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      channelConfig: { systemPrompt: "   " },
    });

    expect(result.groupSystemPrompt).toBeUndefined();
  });
});
