import { describe, expect, it } from "vitest";
import { resolveTelegramAutoThreadId } from "./action-threading.js";

describe("resolveTelegramAutoThreadId", () => {
  it("keeps current DM topic threadId even when replyToId-like flow is active", () => {
    expect(
      resolveTelegramAutoThreadId({
        to: "telegram:1234",
        toolContext: {
          currentChannelId: "telegram:1234",
          currentThreadTs: "533274",
        },
      }),
    ).toBe("533274");
  });

  it("does not override an explicit target topic", () => {
    expect(
      resolveTelegramAutoThreadId({
        to: "telegram:-1001:topic:99",
        toolContext: {
          currentChannelId: "telegram:-1001:topic:77",
          currentThreadTs: "77",
        },
      }),
    ).toBeUndefined();
  });
});
