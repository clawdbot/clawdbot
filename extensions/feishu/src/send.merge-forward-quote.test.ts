// Quoted merged-forward messages must expand their ordered children, matching
// the direct receive path, instead of surfacing the container placeholder.
import { describe, expect, it, vi, beforeEach } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import { getMessageFeishu } from "./send.js";

function mockGetResponse(items: unknown[]) {
  createFeishuClientMock.mockReturnValue({
    im: {
      message: {
        get: vi.fn(async () => ({ code: 0, data: { items } })),
      },
    },
  });
}

function containerItem() {
  return {
    message_id: "om_container",
    msg_type: "merge_forward",
    body: { content: '{"content":"Merged and Forwarded Message"}' },
    sender: { id: "ou_sender", id_type: "open_id", sender_type: "user" },
    create_time: "1000",
  };
}

function childItem(text: string, createTime: string) {
  return {
    message_id: `om_${text}`,
    msg_type: "text",
    body: { content: JSON.stringify({ text }) },
    sender: { id: "ou_child", id_type: "open_id", sender_type: "user" },
    upper_message_id: "om_container",
    create_time: createTime,
  };
}

const baseConfig = {
  channels: {
    feishu: {
      enabled: true,
      accounts: {
        default: { appId: "cli_app", appSecret: "secret_app" },
      },
    },
  },
} as unknown as Parameters<typeof getMessageFeishu>[0]["cfg"];

describe("getMessageFeishu quoted merged-forward expansion", () => {
  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("expands quoted merged-forward children in send order", async () => {
    mockGetResponse([containerItem(), childItem("first", "1002"), childItem("second", "1001")]);

    const info = await getMessageFeishu({ cfg: baseConfig, messageId: "om_container" });

    expect(info?.content).toBe(
      ["[Merged and Forwarded Messages]", "- second", "- first"].join("\n"),
    );
    expect(info?.contentType).toBe("merge_forward");
    expect(info?.senderId).toBe("ou_sender");
  });

  it("expands when the container is not the first response item", async () => {
    mockGetResponse([childItem("first", "1002"), containerItem(), childItem("second", "1001")]);

    const info = await getMessageFeishu({ cfg: baseConfig, messageId: "om_container" });

    expect(info?.content).toBe(
      ["[Merged and Forwarded Messages]", "- second", "- first"].join("\n"),
    );
    expect(info?.messageId).toBe("om_container");
  });

  it("bounds the expanded quoted body to a context-safe size", async () => {
    const longText = "x".repeat(600);
    mockGetResponse([
      containerItem(),
      ...Array.from({ length: 20 }, (_, i) => childItem(longText, String(1000 + i))),
    ]);

    const info = await getMessageFeishu({ cfg: baseConfig, messageId: "om_container" });

    expect(info?.content.length).toBeLessThanOrEqual(4_000);
    expect(info!.content.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps single-item placeholder behavior for plain quoted messages", async () => {
    mockGetResponse([childItem("plain text", "1001")]);

    const info = await getMessageFeishu({ cfg: baseConfig, messageId: "om_plain" });

    expect(info?.content).toBe("plain text");
    expect(info?.contentType).toBe("text");
  });
});
