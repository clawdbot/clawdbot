import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

const sendMediaTelegramUser = vi.fn<
  typeof import("./send.js").sendMediaTelegramUser
>();

vi.mock("./send.js", () => {
  return {
    looksLikeTelegramUserTargetId: () => true,
    normalizeTelegramUserMessagingTarget: (raw: string) => raw,
    sendMessageTelegramUser: vi.fn(async () => ({ messageId: "m1", chatId: "c1" })),
    sendPollTelegramUser: vi.fn(async () => ({ messageId: "m2", chatId: "c2" })),
    sendMediaTelegramUser,
  };
});

describe("telegram-user channel plugin", () => {
  beforeEach(() => {
    sendMediaTelegramUser.mockReset();
  });

  it("declares thread/reaction capabilities consistent with handler behavior", async () => {
    const mod = await import("./channel.js");
    expect(mod.telegramUserPlugin.capabilities?.reactions).toBe(true);
    expect(mod.telegramUserPlugin.capabilities?.threads).toBe(true);
    expect(mod.telegramUserPlugin.capabilities?.chatTypes).toContain("thread");
  });

  it("enforces mediaMaxMb in outbound sendMedia", async () => {
    sendMediaTelegramUser.mockResolvedValue({ messageId: "m3", chatId: "c3" });

    const cfg = {
      channels: {
        "telegram-user": {
          mediaMaxMb: 7,
        },
      },
    } satisfies Partial<ClawdbotConfig> as unknown as ClawdbotConfig;

    const mod = await import("./channel.js");
    await mod.telegramUserPlugin.outbound?.sendMedia?.({
      cfg,
      to: "telegram-user:123",
      text: "hello",
      mediaUrl: "file:///tmp/example.jpg",
      accountId: "default",
    });

    expect(sendMediaTelegramUser).toHaveBeenCalledTimes(1);
    const [, , opts] = sendMediaTelegramUser.mock.calls[0] ?? [];
    expect(opts?.maxBytes).toBe(7 * 1024 * 1024);
  });

  it("omits maxBytes when mediaMaxMb is not configured", async () => {
    sendMediaTelegramUser.mockResolvedValue({ messageId: "m4", chatId: "c4" });

    const cfg = {
      channels: {
        "telegram-user": {},
      },
    } satisfies Partial<ClawdbotConfig> as unknown as ClawdbotConfig;

    const mod = await import("./channel.js");
    await mod.telegramUserPlugin.outbound?.sendMedia?.({
      cfg,
      to: "telegram-user:123",
      text: "hello",
      mediaUrl: "file:///tmp/example.jpg",
      accountId: "default",
    });

    expect(sendMediaTelegramUser).toHaveBeenCalledTimes(1);
    const [, , opts] = sendMediaTelegramUser.mock.calls[0] ?? [];
    expect(opts).not.toHaveProperty("maxBytes");
  });
});
