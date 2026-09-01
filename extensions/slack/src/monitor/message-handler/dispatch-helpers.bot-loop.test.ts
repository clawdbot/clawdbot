import { describe, expect, it } from "vitest";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

function prepared(message: { channel: string; thread_ts?: string }): PreparedSlackMessage {
  return {
    message: { type: "message", bot_id: "B_PEER", ...message },
    ctx: { botId: "B_SELF", botUserId: "U_SELF", cfg: {} },
    route: { accountId: "default" },
    account: { config: {} },
    channelConfig: null,
  } as unknown as PreparedSlackMessage;
}

describe("resolveSlackBotLoopProtection", () => {
  it("uses the Slack thread as the conversation identity", () => {
    expect(
      resolveSlackBotLoopProtection(prepared({ channel: "C123", thread_ts: "1700000000.001" }))
        ?.conversationId,
    ).toBe("1700000000.001");
  });

  it("uses the channel for top-level messages", () => {
    expect(resolveSlackBotLoopProtection(prepared({ channel: "C123" }))?.conversationId).toBe(
      "C123",
    );
  });
});
