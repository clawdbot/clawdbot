// Telegram presentation rendering tests for the outbound adapter.
import { adaptMessagePresentationForChannel } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();
const reactMessageTelegramMock = vi.fn();
const sendPollTelegramMock = vi.fn();
const sendLocationTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  reactMessageTelegram: (...args: unknown[]) => reactMessageTelegramMock(...args),
  sendPollTelegram: (...args: unknown[]) => sendPollTelegramMock(...args),
  sendLocationTelegram: (...args: unknown[]) => sendLocationTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function callOptionsAt(
  mock: MockWithCalls,
  index: number,
  expectedTo: string,
  expectedText: string,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  expect(call?.[0]).toBe(expectedTo);
  expect(call?.[1]).toBe(expectedText);
  const options = call?.[2];
  expect(options).toBeTruthy();
  return options as Record<string, unknown>;
}

describe("telegramOutbound presentation", () => {
  beforeEach(() => {
    sendMessageTelegramMock.mockReset();
  });

  it.each([false, true])(
    "keeps native controls deliverable (authored fallback=%s)",
    async (hasAuthoredFallback) => {
      sendMessageTelegramMock.mockResolvedValueOnce({
        messageId: "tg-presentation-buttons",
        chatId: "12345",
      });

      const result = await telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        payload: {
          ...(hasAuthoredFallback
            ? { text: "Retry the operation.", presentationTextMode: "fallback" as const }
            : {}),
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
          },
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      });

      const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Choose an option.");
      expect(options.buttons).toEqual([[{ text: "Retry", callback_data: "cmd:retry" }]]);
      expect(result).toEqual({
        channel: "telegram",
        messageId: "tg-presentation-buttons",
        target: { kind: "chat", id: "12345" },
      });
    },
  );

  it("renders presentation tables as native islands for payload sends on rich accounts", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-rich-table", chatId: "12345" });
    await telegramOutbound.sendPayload!({
      cfg: { channels: { telegram: { richMessages: true } } } as never,
      to: "12345",
      text: "",
      payload: {
        text: "plain fallback",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "table" as const,
              caption: "Pipeline",
              headers: ["Account", "Stage"],
              rows: [["Acme", "Won"]],
            },
          ],
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const sentText = String(sendMessageTelegramMock.mock.calls[0]?.[1]);
    expect(sentText).toContain("<table><caption>Pipeline</caption>");
    expect(sentText).not.toContain("plain fallback");
  });

  it("keeps authored fallback text for payload sends on plain accounts", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-plain-table", chatId: "12345" });
    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "plain fallback",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "table" as const,
              caption: "Pipeline",
              headers: ["Account"],
              rows: [["Acme"]],
            },
          ],
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(String(sendMessageTelegramMock.mock.calls[0]?.[1])).toBe("plain fallback");
  });

  it("keeps table islands off legacy HTML-mode presentation renders", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "plain fallback", presentationTextMode: "fallback" },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Pipeline",
            headers: ["Account"],
            rows: [["Acme"]],
          },
        ],
      },
      ctx: {
        cfg: { channels: { telegram: { richMessages: true } } },
        formatting: { parseMode: "HTML" },
        to: "12345",
      } as never,
    });

    expect(rendered?.text).toBe("plain fallback");
    expect(rendered?.text).not.toContain("<table");
  });

  it("preserves fallback labels after core capability adaptation", async () => {
    const label = "Open the workspace with the complete deployment instructions for production";
    const sourcePresentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Continue", action: { type: "command" as const, command: "/continue" } },
            { label, action: { type: "web-app" as const, url: "https://example.com/app" } },
          ],
        },
      ],
    };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { presentationTextMode: "fallback" },
      presentation: adaptMessagePresentationForChannel({
        presentation: sourcePresentation,
        capabilities: telegramOutbound.presentationCapabilities,
      }),
      sourcePresentation,
      ctx: { cfg: {}, to: "-10012345" } as never,
    });

    expect(rendered?.text).toContain(label);
    expect(rendered?.text).toContain("https://example.com/app");
    expect(rendered?.channelData?.telegram).toEqual({
      buttons: [[{ text: "Continue", callback_data: "tgcmd:/continue" }]],
    });
  });

  it("renders presentation web app buttons for payload sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-web-app", chatId: "12345" });
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Launch",
              action: {
                type: "web-app" as const,
                url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
              },
            },
          ],
        },
      ],
    };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Open app:" },
      presentation,
      ctx: { cfg: {}, to: "12345" } as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram presentation");
    }

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: rendered,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Open app:");
    expect(options.buttons).toEqual([
      [
        {
          text: "Launch",
          web_app: {
            url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
          },
        },
      ],
    ]);
  });

  it("preserves explicit Telegram buttons when rendering presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Use native buttons:",
        channelData: {
          telegram: {
            buttons: [[{ text: "Native", callback_data: "native" }]],
          },
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });

    expect((rendered?.channelData?.telegram as { buttons?: unknown })?.buttons).toEqual([
      [{ text: "Native", callback_data: "native" }],
    ]);
    expect(rendered?.text).toBe("Use native buttons:\n\n- Generic");
  });

  it("preserves legacy interactive buttons when rendering mixed presentation payloads", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-mixed-buttons",
      chatId: "12345",
    });
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Choose:",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram presentation");
    }

    expect((rendered.channelData?.telegram as { buttons?: unknown } | undefined)?.buttons).toEqual([
      [{ text: "Legacy", callback_data: "legacy" }],
    ]);

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: rendered,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Choose:\n\n- Generic");
    expect(options.buttons).toEqual([[{ text: "Legacy", callback_data: "legacy" }]]);
  });

  it("lets allow-always approval callbacks reach Telegram's callback rewrite", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-approval",
      chatId: "12345",
    });
    const approvalId = "plugin:123e4567-e89b-12d3-a456-426614174000";
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Always",
                value: `/approve ${approvalId} allow-always`,
              },
            ],
          },
        ],
      },
      capabilities: telegramOutbound.presentationCapabilities,
    });

    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Approve?" },
      presentation,
      ctx: { cfg: {} } as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram approval presentation");
    }

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: rendered,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Approve?");
    expect(options.buttons).toEqual([
      [{ text: "Allow Always", callback_data: `/approve ${approvalId} always` }],
    ]);
  });

  it("leaves long presentation text for Telegram chunking", () => {
    const text = "👍".repeat(5000);
    const presentation = adaptMessagePresentationForChannel({
      presentation: { blocks: [{ type: "text", text }] },
      capabilities: telegramOutbound.presentationCapabilities,
    });

    expect(presentation.blocks).toEqual([{ type: "text", text }]);
  });
});
