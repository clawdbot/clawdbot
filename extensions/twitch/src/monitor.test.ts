import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_TWITCH_TEST_ACCOUNT } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({ sendMessage: mocks.sendMessage }),
}));

import { testing } from "./monitor.js";

describe("deliverTwitchReply", () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue({ ok: true, messageId: "message-id" });
  });

  it("routes fallback replies through the UTF-16-safe transport sender", async () => {
    const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };

    const result = await testing.deliverTwitchReply({
      payload: { text: "**Hello** Twitch" },
      channel: "testchannel",
      account,
      accountId: "default",
      config: {},
      tableMode: "off",
      runtime: {},
    });

    expect(result).toEqual({ visibleReplySent: true });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      account,
      "testchannel",
      "Hello Twitch",
      {},
      "default",
    );
  });
});
