// Telegram tests cover threading tool context plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

describe("telegramPlugin reply threading", () => {
  it.each([
    {
      name: "uses an account override",
      telegram: {
        botToken: "token-default",
        accounts: { sut: { botToken: "token-sut", replyToMode: "first" as const } },
      },
      expected: "first",
    },
    {
      name: "inherits the top-level mode",
      telegram: {
        botToken: "token-default",
        replyToMode: "all" as const,
        accounts: { sut: { botToken: "token-sut" } },
      },
      expected: "all",
    },
    {
      name: "allows an account to disable replies",
      telegram: {
        botToken: "token-default",
        replyToMode: "all" as const,
        accounts: { sut: { botToken: "token-sut", replyToMode: "off" as const } },
      },
      expected: "off",
    },
  ])("$name", ({ telegram, expected }) => {
    const resolveReplyToMode = telegramPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("Telegram reply mode resolver is unavailable");
    }

    const cfg = { channels: { telegram } } as OpenClawConfig;
    expect(resolveReplyToMode({ cfg, accountId: "sut" })).toBe(expected);
  });
});

describe("buildTelegramThreadingToolContext", () => {
  it("keeps topic thread state in plugin-owned tool context", () => {
    const hasRepliedRef = { value: false };
    expect(
      buildTelegramThreadingToolContext({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        context: {
          To: "telegram:-1001:topic:77",
          MessageThreadId: 77,
          CurrentMessageId: "msg-1",
        },
        hasRepliedRef,
      }),
    ).toEqual({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
      hasRepliedRef,
    });
  });

  it("parses topic thread state from target grammar when MessageThreadId is absent", () => {
    expect(
      buildTelegramThreadingToolContext({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        context: {
          To: "telegram:-1001:topic:77",
          CurrentMessageId: "msg-1",
        },
      }),
    ).toEqual({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
      hasRepliedRef: undefined,
    });
  });
});
