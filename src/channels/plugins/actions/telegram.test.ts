import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../../config/config.js";
import { telegramMessageActions } from "./telegram.js";

const handleTelegramAction = vi.fn(async () => ({ ok: true }));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
}));

describe("telegramMessageActions", () => {
  it("allows media-only sends and passes asVoice", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as ClawdbotConfig;

    await telegramMessageActions.handleAction({
      action: "send",
      params: {
        to: "123",
        media: "https://example.com/voice.ogg",
        asVoice: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "123",
        content: "",
        mediaUrl: "https://example.com/voice.ogg",
        asVoice: true,
      }),
      cfg,
    );
  });
});
