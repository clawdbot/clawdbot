// Test Device Pair Telegram tests cover the dev Telegram pairing smoke helper.
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  parseDevicePairTelegramArgs,
  runDevicePairTelegram,
} from "../../scripts/dev/test-device-pair-telegram.ts";

const scriptUrl = pathToFileURL("scripts/dev/test-device-pair-telegram.ts").href;

describe("scripts/dev/test-device-pair-telegram.ts", () => {
  it("loads without resolving the Telegram runtime sidecar", async () => {
    await expect(import(`${scriptUrl}?case=load-${Date.now()}`)).resolves.toBeDefined();
  });

  it("parses help without requiring Telegram config", () => {
    expect(parseDevicePairTelegramArgs(["--help"])).toEqual({
      accountId: undefined,
      chatId: undefined,
      help: true,
    });
  });

  it("rejects option tokens as device-pair Telegram values", () => {
    for (const flag of ["--chat", "-c", "--account", "-a"]) {
      expect(() => parseDevicePairTelegramArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
    expect(() => parseDevicePairTelegramArgs(["--chat", "--help"])).toThrow(
      "--chat requires a value",
    );
  });

  it("allows negative Telegram chat ids", () => {
    expect(parseDevicePairTelegramArgs(["--chat", "-100123"])).toMatchObject({
      chatId: "-100123",
      help: false,
    });
  });

  it("rejects unknown args before loading OpenClaw plugins", async () => {
    const cfg = { channels: { telegram: { enabled: true } } };
    const loadOpenClawPlugins = vi.fn();
    const executePluginCommand = vi.fn();
    const sendMessageTelegram = vi.fn();

    await expect(
      runDevicePairTelegram(["--chat", "chat-123", "--wat"], {
        executePluginCommand,
        getRuntimeConfig: () => cfg,
        loadOpenClawPlugins,
        matchPluginCommand: () => ({ args: "from-match", command: { name: "pair" } as never }),
        sendMessageTelegram,
      }),
    ).rejects.toThrow("Unknown argument: --wat");
    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(executePluginCommand).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("sends the generated /pair reply through the injected Telegram runtime", async () => {
    const cfg = { channels: { telegram: { enabled: true } } };
    const loadOpenClawPlugins = vi.fn();
    const executePluginCommand = vi.fn(async () => ({ text: "pair this device" }));
    const sendMessageTelegram = vi.fn(async () => ({
      chatId: "chat-123",
      messageId: "message-456",
    }));

    const result = await runDevicePairTelegram(["--chat", "chat-123", "--account", "main"], {
      executePluginCommand,
      getRuntimeConfig: () => cfg,
      loadOpenClawPlugins,
      matchPluginCommand: () => ({ args: "from-match", command: { name: "pair" } as never }),
      sendMessageTelegram,
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith({ config: cfg });
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        args: "from-match",
        channel: "telegram",
        commandBody: "/pair",
        from: "telegram:chat-123",
        senderId: "chat-123",
        to: "telegram:chat-123",
      }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith("chat-123", "pair this device", {
      accountId: "main",
      cfg,
    });
    expect(result).toEqual({
      accountId: "main",
      chatId: "chat-123",
      messageId: "message-456",
      sent: true,
    });
  });
});
