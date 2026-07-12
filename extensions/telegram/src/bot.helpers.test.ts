// Telegram tests cover bot.helpers plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveTelegramGroupAllowFromContext, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to partial when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("partial");
    expect(resolveTelegramStreamMode({})).toBe("partial");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("resolves nested streaming.mode values", () => {
    expect(resolveTelegramStreamMode({ streaming: { mode: "off" } })).toBe("off");
    expect(resolveTelegramStreamMode({ streaming: { mode: "partial" } })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: { mode: "block" } })).toBe("block");
  });

  it("preserves unified progress mode on Telegram", () => {
    expect(resolveTelegramStreamMode({ streaming: "progress" })).toBe("progress");
  });
});

describe("resolveTelegramGroupAllowFromContext", () => {
  it("expands Telegram access groups before normalizing allowFrom entries", async () => {
    const cfg: OpenClawConfig = {
      accessGroups: {
        maintainers: {
          type: "message.senders",
          members: {
            telegram: ["12345"],
          },
        },
      },
    };

    const context = await resolveTelegramGroupAllowFromContext({
      cfg,
      chatId: -100123,
      accountId: "default",
      senderId: "12345",
      isGroup: true,
      groupAllowFrom: ["accessGroup:maintainers"],
      readChannelAllowFromStore: async () => [],
      resolveTelegramGroupConfig: () => ({}),
    });

    expect(context.effectiveGroupAllow.entries).toEqual(["12345"]);
    expect(context.effectiveGroupAllow.invalidEntries).toStrictEqual([]);
  });
});

describe("resolveTelegramDraftStreamingChunking", () => {
  it("uses smaller defaults than block streaming", () => {
    const chunking = resolveTelegramDraftStreamingChunking(undefined, "default");
    expect(chunking).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });
});
