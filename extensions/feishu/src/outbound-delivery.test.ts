// Feishu tests cover the shared outbound delivery path.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
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
    resetPluginRuntimeStateForTest();
  });

  it("routes oversized presentation media through one media send and chunked fallback text", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile,
    };
    await sendDurableMessageBatch({
      cfg: {},
      channel: "feishu",
      to: "chat_1",
      skipQueue: true,
      mediaAccess,
      payloads: [
        {
          mediaUrl: "pipeline.png",
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
      expect.objectContaining({
        mediaUrl: "pipeline.png",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: readFile,
        to: "chat_1",
      }),
    );
    const sentMedia = sendMediaFeishuMock.mock.calls[0]?.[0] as {
      mediaAccess?: { localRoots?: readonly string[]; readFile?: typeof readFile };
    };
    expect(sentMedia.mediaAccess?.localRoots).toBe(mediaAccess.localRoots);
    expect(sentMedia.mediaAccess?.readFile).toBe(readFile);
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
  });
});
