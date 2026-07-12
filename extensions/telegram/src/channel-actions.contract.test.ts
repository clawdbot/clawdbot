// Telegram tests cover channel actions.contract plugin behavior.
import { installChannelActionsContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "../api.js";

describe("telegram actions contract", () => {
  installChannelActionsContractSuite({
    plugin: telegramPlugin,
    cases: [
      {
        name: "exposes configured Telegram actions and capabilities",
        cfg: {
          channels: {
            telegram: {
              botToken: "123:telegram-test-token",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "poll", "react", "delete", "edit", "topic-create", "topic-edit"],
        expectedCapabilities: ["delivery-pin", "presentation"],
      },
    ],
  });

  it.each([
    { richMessages: undefined, expected: false },
    { richMessages: false, expected: false },
    { richMessages: true, expected: true },
  ])("advertises Telegram rich text only when enabled", ({ richMessages, expected }) => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:telegram-test-token",
            richMessages,
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).toContain("inlineButtons");
    expect(capabilities?.includes("richText")).toBe(expected);
  });

  it("advertises inline buttons when legacy Telegram capabilities are empty", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:telegram-test-token",
            capabilities: [],
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).toContain("inlineButtons");
  });

  it("advertises rich send parameters without adding Telegram-only actions", () => {
    const discovery = telegramPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: { telegram: { botToken: "test-token-placeholder" } },
      } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    const properties = Object.assign({}, ...contributions.map((entry) => entry.properties));

    expect(discovery?.actions).not.toContain("sendVideoNote");
    expect(discovery?.actions).not.toContain("sendLocation");
    expect(properties).toHaveProperty("asVideoNote");
    expect(properties).toHaveProperty("location");
  });

  it("does not advertise inline buttons for non-empty legacy Telegram capabilities without inlineButtons", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:telegram-test-token",
            capabilities: ["vision"],
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).not.toContain("inlineButtons");
  });

  it("uses the selected Telegram account's rich text setting", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:telegram-test-token",
            richMessages: true,
            accounts: {
              ops: {
                richMessages: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "ops",
    });

    expect(capabilities).not.toContain("richText");
  });

  it("does not resolve Telegram credentials while checking prompt capabilities", () => {
    expect(() =>
      telegramPlugin.agentPrompt?.messageToolCapabilities?.({
        cfg: {
          channels: {
            telegram: {
              tokenFile: "/definitely/missing/telegram-token",
              richMessages: true,
            },
          },
        } as OpenClawConfig,
      }),
    ).not.toThrow();
  });

  it("uses the configured default Telegram account for prompt capabilities", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            defaultAccount: "ops",
            accounts: {
              default: {
                botToken: "123:default-token",
                richMessages: false,
              },
              ops: {
                botToken: "123:ops-token",
                richMessages: true,
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).toContain("richText");
  });

  it("exposes Telegram thread create CLI remapping through the exported plugin", () => {
    const request = telegramPlugin.actions?.resolveCliActionRequest?.({
      action: "thread-create",
      args: {
        channel: "telegram",
        target: "-1003894873578",
        threadName: "Build Updates",
        message: "hello",
      },
    });

    expect(request).toEqual({
      action: "topic-create",
      args: {
        channel: "telegram",
        target: "-1003894873578",
        name: "Build Updates",
        message: "hello",
      },
    });
  });

  it("preserves quote text when presentations use durable core delivery", async () => {
    const presentation = {
      blocks: [{ type: "text" as const, text: "Quoted chart" }],
    };
    const prepareSendPayload = telegramPlugin.actions?.prepareSendPayload;

    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quoteText: "  original message  " },
        },
        to: "123456",
        payload: {
          text: "Chart",
          presentation,
          channelData: { telegram: { parseMode: "MarkdownV2" } },
        },
      }),
    ).toEqual({
      text: "Chart",
      presentation,
      channelData: {
        telegram: {
          parseMode: "MarkdownV2",
          quoteText: "original message",
        },
      },
    });
    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quoteText: "original message" },
        },
        to: "123456",
        payload: { text: "legacy send" },
      }),
    ).toBeNull();
    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quote_text: "  snake case quote  " },
        },
        to: "123456",
        payload: { text: "Chart", presentation },
      }),
    ).toEqual({
      text: "Chart",
      presentation,
      channelData: { telegram: { quoteText: "snake case quote" } },
    });
  });

  it("routes video-note and location hints through durable core delivery", async () => {
    const prepareSendPayload = telegramPlugin.actions?.prepareSendPayload;
    const location = { latitude: 48.858844, longitude: 2.294351 };

    await expect(
      prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { asVideoNote: true },
        },
        to: "123456",
        payload: { mediaUrl: "file:///tmp/note.mp4", videoAsNote: true },
      }),
    ).resolves.toEqual({ mediaUrl: "file:///tmp/note.mp4", videoAsNote: true });
    await expect(
      prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { location },
        },
        to: "123456",
        payload: { location },
      }),
    ).resolves.toEqual({ location });
  });
});
