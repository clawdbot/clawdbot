// Root-owned integration covers the CLI dependency boundary into a public channel plugin.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../extensions/telegram/api.js";
import { setTelegramRuntime } from "../extensions/telegram/runtime-setter-api.js";
import { createDefaultDeps, createOutboundSendDeps } from "../src/cli/deps.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";

const sendMessageTelegram = vi.fn(
  async (_to: string, _text: string, _options?: Record<string, unknown>) => ({
    messageId: "telegram-message",
    chatId: "12345",
  }),
);

function installTelegramRuntime(): void {
  const runtime = createPluginRuntimeMock();
  setTelegramRuntime({
    ...runtime,
    channel: {
      ...runtime.channel,
      telegram: { sendMessageTelegram },
    },
  });
}

function resetTelegramRuntime(): void {
  const runtime = createPluginRuntimeMock();
  setTelegramRuntime({ ...runtime, channel: { ...runtime.channel } });
}

describe("Telegram presentation with default CLI dependencies", () => {
  beforeEach(() => {
    sendMessageTelegram.mockClear();
    installTelegramRuntime();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    resetTelegramRuntime();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("delivers a portable login command as an inline button", async () => {
    const sendPayload = telegramPlugin.message?.send?.payload;
    if (!sendPayload) {
      throw new Error("expected Telegram payload delivery");
    }

    await sendPayload({
      cfg: {},
      to: "12345",
      text: "Automation failed",
      payload: {
        text: "Automation failed",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Log in to Codex",
                  action: { type: "command", command: "/login codex" },
                },
              ],
            },
          ],
        },
      },
      deps: createOutboundSendDeps(createDefaultDeps()),
    });

    expect(sendMessageTelegram).toHaveBeenCalledOnce();
    expect(sendMessageTelegram.mock.calls[0]?.[2]).toMatchObject({
      buttons: [
        [{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }],
      ],
    });
  });
});
