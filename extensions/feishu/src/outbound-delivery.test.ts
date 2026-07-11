// Feishu tests cover the shared outbound delivery path.
import {
  createOutboundTestPlugin,
  createTestRegistry,
  deliverOutboundPayloads,
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: () => false,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMarkdownCardFeishu: vi.fn(),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: vi.fn(),
}));

import { feishuOutbound } from "./outbound.js";

describe("Feishu outbound shared delivery", () => {
  beforeEach(() => {
    let textMessageIndex = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue({
      messageId: "media-1",
      chatId: "chat_1",
    });
    sendMessageFeishuMock.mockReset().mockImplementation(async () => ({
      messageId: `text-${String(++textMessageIndex)}`,
      chatId: "chat_1",
    }));
    sendCardFeishuMock.mockReset().mockResolvedValue({
      messageId: "card-1",
      chatId: "chat_1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          plugin: createOutboundTestPlugin({ id: "feishu", outbound: feishuOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    releasePinnedPluginChannelRegistry();
  });

  it("routes oversized presentation media through one media send and chunked fallback text", async () => {
    await deliverOutboundPayloads({
      cfg: {},
      channel: "feishu",
      to: "chat_1",
      skipQueue: true,
      payloads: [
        {
          mediaUrl: "https://example.com/pipeline.png",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Large pipeline",
                headers: ["Account", "Stage"],
                rows: Array.from({ length: 400 }, (_entry, index) => [
                  `account-${String(index)}-${"x".repeat(80)}`,
                  "Review",
                ]),
              },
            ],
          },
        },
      ],
    });

    const textChunks = sendMessageFeishuMock.mock.calls.map((call) => {
      const text = (call[0] as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    });
    const deliveredText = textChunks.join("\n");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/pipeline.png", to: "chat_1" }),
    );
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
  });
});
