import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupChannels } from "./onboard-channels.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn(async () => {
      throw new Error("ENOENT");
    }),
  },
}));

vi.mock("../channel-web.js", () => ({
  loginWeb: vi.fn(async () => {}),
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary: vi.fn(async () => false),
}));

describe("setupChannels", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", plugin: discordPlugin, source: "test" },
        { pluginId: "slack", plugin: slackPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
        { pluginId: "signal", plugin: signalPlugin, source: "test" },
        { pluginId: "imessage", plugin: imessagePlugin, source: "test" },
      ]),
    );
  });
  it("QuickStart uses single-select (no multiselect) and doesn't prompt for Telegram token when WhatsApp is chosen", async () => {
    const select = vi.fn(async () => "whatsapp");
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message.includes("Enter Telegram bot token")) {
        throw new Error("unexpected Telegram token prompt");
      }
      if (message.includes("Your personal WhatsApp number")) {
        return "+15555550123";
      }
      throw new Error(`unexpected text prompt: ${message}`);
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: text as unknown as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels({} as MoltbotConfig, runtime, prompter, {
      skipConfirm: true,
      quickstartDefaults: true,
      forceAllowFromChannels: ["whatsapp"],
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("prompts for configured channel action and skips configuration when told to skip", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") return "telegram";
      if (message.includes("already configured")) return "skip";
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: text as unknown as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels(
      {
        channels: {
          telegram: {
            botToken: "token",
          },
        },
      } as MoltbotConfig,
      runtime,
      prompter,
      {
        skipConfirm: true,
        quickstartDefaults: true,
      },
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("already configured") }),
    );
    expect(multiselect).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("adds disabled hint to channel selection when a channel is disabled", async () => {
    let selectionCount = 0;
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        selectionCount += 1;
        const opts = options as Array<{ value: string; hint?: string }>;
        const telegram = opts.find((opt) => opt.value === "telegram");
        expect(telegram?.hint).toContain("disabled");
        return selectionCount === 1 ? "telegram" : "__done__";
      }
      if (message.includes("already configured")) return "skip";
      return "__done__";
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels(
      {
        channels: {
          telegram: {
            botToken: "token",
            enabled: false,
          },
        },
      } as MoltbotConfig,
      runtime,
      prompter,
      {
        skipConfirm: true,
      },
    );

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(multiselect).not.toHaveBeenCalled();
  });
});
