// Telegram tests cover threading tool context plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

const tryReadSecretFileSyncMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("reply mode must not read Telegram credentials");
  }),
);

vi.mock("openclaw/plugin-sdk/secret-file-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-file-runtime")>()),
  tryReadSecretFileSync: tryReadSecretFileSyncMock,
}));

function requireTelegramToolContextTargetMatcher() {
  const matchesToolContextTarget = telegramPlugin.threading?.matchesToolContextTarget;
  if (!matchesToolContextTarget) {
    throw new Error("Telegram tool context target matcher is unavailable");
  }
  return matchesToolContextTarget;
}

describe("telegramPlugin reply threading", () => {
  it.each([
    {
      name: "uses an account override",
      telegram: {
        accounts: {
          sut: {
            tokenFile: "/tmp/openclaw-telegram-reply-mode-must-not-read",
            replyToMode: "first" as const,
          },
        },
      },
      expected: "first",
    },
    {
      name: "inherits the top-level mode",
      telegram: {
        replyToMode: "all" as const,
        accounts: {
          sut: {
            botToken: { source: "file", provider: "telegram_token", id: "value" },
          },
        },
      },
      expected: "all",
    },
    {
      name: "allows an account to disable replies",
      telegram: {
        replyToMode: "all" as const,
        accounts: { sut: { replyToMode: "off" as const } },
      },
      expected: "off",
    },
  ])("$name", ({ telegram, expected }) => {
    tryReadSecretFileSyncMock.mockClear();
    const resolveReplyToMode = telegramPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("Telegram reply mode resolver is unavailable");
    }

    const cfg = { channels: { telegram } } as unknown as OpenClawConfig;
    expect(resolveReplyToMode({ cfg, accountId: "sut" })).toBe(expected);
    expect(tryReadSecretFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    { target: "-100123", currentChannelId: "telegram:-100123", expected: true },
    { target: "telegram:-100123", currentChannelId: "-100123", expected: true },
    {
      target: "-100123:topic:77",
      currentChannelId: "telegram:-100123:77",
      expected: true,
    },
    {
      target: "-100123:direct-topic:77",
      currentChannelId: "telegram:-100123:direct-topic:77",
      expected: true,
    },
    {
      target: "-100123:topic:77",
      currentChannelId: "telegram:-100123:direct-topic:77",
      expected: false,
    },
    {
      target: "-100123:topic:77",
      currentChannelId: "telegram:-100123:topic:78",
      expected: false,
    },
    { target: "-100456", currentChannelId: "telegram:-100123", expected: false },
  ])(
    "matches canonical target $target against current channel $currentChannelId",
    ({ target, currentChannelId, expected }) => {
      expect(
        requireTelegramToolContextTargetMatcher()({
          target,
          toolContext: { currentChannelId },
        }),
      ).toBe(expected);
    },
  );
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
