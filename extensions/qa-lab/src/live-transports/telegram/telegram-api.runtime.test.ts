import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramQaConfig,
  isRecoverableTelegramQaPollError,
  normalizeTelegramObservedMessage,
  parseTelegramQaCredentialPayload,
  resolveTelegramQaRuntimeEnv,
  waitForTelegramChannelRunning,
} from "./telegram-api.runtime.js";

describe("Telegram QA API boundary", () => {
  it("parses env and leased credential payloads", () => {
    expect(
      resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "placeholder",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "placeholder",
      }),
    ).toEqual({
      groupId: "-100123",
      driverToken: "placeholder",
      sutToken: "placeholder",
    });
    expect(
      parseTelegramQaCredentialPayload({
        groupId: "-100456",
        driverToken: "placeholder",
        sutToken: "placeholder",
      }),
    ).toEqual({
      groupId: "-100456",
      driverToken: "placeholder",
      sutToken: "placeholder",
    });
    expect(() =>
      parseTelegramQaCredentialPayload({
        groupId: "group-name",
        driverToken: "placeholder",
        sutToken: "placeholder",
      }),
    ).toThrow("numeric Telegram chat id");
  });

  it("normalizes rich edited messages and native reply metadata", () => {
    expect(
      normalizeTelegramObservedMessage({
        update_id: 9,
        edited_message: {
          message_id: 42,
          date: 123,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "sut_bot" },
          rich_message: {
            blocks: [{ text: "final " }, { text: [{ text: "reply" }] }],
          },
          reply_to_message: { message_id: 41 },
        },
      }),
    ).toMatchObject({
      updateId: 9,
      messageId: 42,
      chatId: -100123,
      senderId: 2,
      senderIsBot: true,
      text: "final \nreply",
      replyToMessageId: 41,
      timestamp: 123_000,
    });
  });

  it("builds the isolated Telegram gateway config", () => {
    const config = buildTelegramQaConfig(
      { plugins: { allow: ["qa-lab"] } },
      {
        groupId: "-100123",
        sutToken: "placeholder",
        driverBotId: 1,
        sutAccountId: "sut",
      },
    );

    expect(config.plugins?.allow).toEqual(["qa-lab", "telegram"]);
    expect(config.channels?.telegram).toMatchObject({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          botToken: "placeholder",
          dmPolicy: "disabled",
          replyToMode: "first",
          groups: {
            "-100123": {
              groupPolicy: "allowlist",
              allowFrom: ["1"],
              requireMention: true,
            },
          },
        },
      },
    });
  });

  it("waits for the selected Telegram account to become connected", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: false }],
        },
      })
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: true }],
        },
      });

    await waitForTelegramChannelRunning({ call }, "sut", { timeoutMs: 100, pollMs: 1 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("classifies transient polling failures", () => {
    expect(isRecoverableTelegramQaPollError(new Error("socket hang up"))).toBe(true);
    expect(isRecoverableTelegramQaPollError(new Error("Telegram unauthorized"))).toBe(false);
  });
});
