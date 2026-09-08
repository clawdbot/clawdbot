import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { sendMessageTwitchInternal } from "./send.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";
import { TwitchClientManager } from "./twitch-client.js";

describe("sendMessageTwitchInternal", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "test123" };
  const cfg = makeTwitchTestConfig(account);
  const clientManager = new TwitchClientManager(logger);
  let sendMessageSpy: MockInstance<TwitchClientManager["sendMessage"]>;
  const params = {
    channel: "testchannel",
    text: "Hello Twitch!",
    cfg,
    account,
    accountId: "default",
    clientManager,
  };
  installTwitchTestHooks();
  beforeEach(() => {
    sendMessageSpy = vi
      .spyOn(clientManager, "sendMessage")
      .mockResolvedValue({ ok: true, messageId: "twitch-msg-123" });
  });

  it("returns a receipt for the delivered message", async () => {
    const result = await sendMessageTwitchInternal(params);

    expect(result.messageId).toBe("twitch-msg-123");
    expect(typeof result.receipt.sentAt).toBe("number");
    expect({ ...result.receipt, sentAt: 0 }).toEqual({
      primaryPlatformMessageId: "twitch-msg-123",
      platformMessageIds: ["twitch-msg-123"],
      parts: [
        {
          platformMessageId: "twitch-msg-123",
          kind: "text",
          index: 0,
          raw: {
            channel: "twitch",
            conversationId: "testchannel",
            messageId: "twitch-msg-123",
          },
        },
      ],
      raw: [
        {
          channel: "twitch",
          conversationId: "testchannel",
          messageId: "twitch-msg-123",
        },
      ],
      sentAt: 0,
    });
    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      "Hello Twitch!",
      cfg,
      "default",
    );
  });

  it.each([
    ["**Bold** text", "Bold text"],
    ["[link](https://example.com)", "link (https://example.com)"],
    ["`---`", "---"],
  ])("strips Markdown once from %s", async (text, expected) => {
    await sendMessageTwitchInternal({ ...params, text });

    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      expected,
      cfg,
      "default",
    );
  });

  it.each([true, false])(
    "keeps empty Markdown unsent with a manager present: %s",
    async (hasManager) => {
      const result = await sendMessageTwitchInternal({
        ...params,
        text: "---",
        clientManager: hasManager ? clientManager : undefined,
      });

      expect(result).toMatchObject({ outcome: "not_sent", messageId: "" });
      expect(result.receipt.platformMessageIds).toStrictEqual([]);
      expect(result.receipt.parts).toStrictEqual([]);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects a visible send when the caller has no manager", async () => {
    await expect(
      sendMessageTwitchInternal({ ...params, clientManager: undefined }),
    ).rejects.toThrow(
      "Client manager not found for account: default. Please start the Twitch gateway first.",
    );
  });

  it("uses the caller's prepared account when config no longer contains it", async () => {
    await sendMessageTwitchInternal({ ...params, cfg: {} });

    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      "Hello Twitch!",
      {},
      "default",
    );
  });

  it("exposes the manager's formatted failure without a cause or another log", async () => {
    sendMessageSpy.mockResolvedValue({ ok: false, error: "Connection lost" });
    const failure = sendMessageTwitchInternal(params);

    await expect(failure).rejects.toThrow("Connection lost");
    await expect(failure).rejects.not.toHaveProperty("cause");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
