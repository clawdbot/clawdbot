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
              botToken: "test-token-placeholder",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "poll", "react", "delete", "edit", "topic-create", "topic-edit"],
        expectedCapabilities: ["delivery-pin", "presentation"],
      },
    ],
  });

  it("exposes message resource aliases through the registered adapter", () => {
    for (const action of ["react", "edit", "delete"] as const) {
      expect(telegramPlugin.actions?.messageActionTargetAliases?.[action]).toEqual({
        aliases: ["messageId"],
        deliveryTargetAliases: [],
      });
    }
  });

  it.each([
    {
      richMessages: undefined as boolean | undefined,
      expectedMarkup: "markdown",
      expectedOn: false,
    },
    {
      richMessages: false as boolean | undefined,
      expectedMarkup: "markdown",
      expectedOn: false,
    },
    {
      richMessages: true as boolean | undefined,
      expectedMarkup: "markdown_telegram_rich",
      expectedOn: true,
    },
  ])(
    "returns inbound formatting hints for richMessages=$richMessages",
    ({ richMessages, expectedMarkup, expectedOn }) => {
      const hints = telegramPlugin.agentPrompt?.inboundFormattingHints?.({
        cfg: {
          channels: {
            telegram: {
              botToken: "test-token-placeholder",
              richMessages,
            },
          },
        } as OpenClawConfig,
      });

      expect(hints?.text_markup).toBe(expectedMarkup);
      if (expectedOn) {
        expect(hints?.rules.join(" ")).toContain("Telegram rich ON");
        expect(hints?.rules.join(" ")).toContain("Bot API 10.2 blocks");
        expect(hints?.rules.join(" ")).toContain("<details><summary>");
        expect(hints?.rules.join(" ")).toContain("Not MarkdownV2/parse_mode");
        expect(hints?.rules.join(" ")).toContain("Media https URLs only, block-level only");
      } else {
        expect(hints?.rules.join(" ")).toContain("Telegram rich OFF");
        expect(hints?.rules.join(" ")).toContain("richMessages");
        expect(hints?.rules.join(" ")).not.toContain("Telegram rich ON");
      }
    },
  );

  it("does not advertise a richText message-tool capability", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "test-token-placeholder",
            richMessages: true,
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).toContain("inlineButtons");
    expect(capabilities).not.toContain("richText");
  });

  it("advertises inline buttons when legacy Telegram capabilities are empty", () => {
    const capabilities = telegramPlugin.agentPrompt?.messageToolCapabilities?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "test-token-placeholder",
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
            botToken: "test-token-placeholder",
            capabilities: ["vision"],
          },
        },
      } as OpenClawConfig,
    });

    expect(capabilities).not.toContain("inlineButtons");
  });

  it("uses the selected Telegram account's richMessages for inbound formatting hints", () => {
    const hints = telegramPlugin.agentPrompt?.inboundFormattingHints?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "test-token-placeholder",
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

    expect(hints?.text_markup).toBe("markdown");
    expect(hints?.rules.join(" ")).toContain("Telegram rich OFF");
  });

  it("does not resolve Telegram credentials while checking inbound formatting hints", () => {
    expect(() =>
      telegramPlugin.agentPrompt?.inboundFormattingHints?.({
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

  it("uses the configured default Telegram account for inbound formatting hints", () => {
    const hints = telegramPlugin.agentPrompt?.inboundFormattingHints?.({
      cfg: {
        channels: {
          telegram: {
            defaultAccount: "ops",
            accounts: {
              default: {
                botToken: "test-token-placeholder",
                richMessages: false,
              },
              ops: {
                botToken: "test-token-placeholder",
                richMessages: true,
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(hints?.text_markup).toBe("markdown_telegram_rich");
    expect(hints?.rules.join(" ")).toContain("Telegram rich ON");
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
