import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  clearTokenCache: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue("token"),
  sendC2CFileMessage: vi.fn(),
  sendC2CImageMessage: vi.fn(),
  sendC2CMessage: vi.fn(),
  sendC2CVideoMessage: vi.fn(),
  sendC2CVoiceMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendDmMessage: vi.fn(),
  sendGroupFileMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
  sendGroupVideoMessage: vi.fn(),
  sendGroupVoiceMessage: vi.fn(),
}));

vi.mock("./api.js", () => apiMocks);

import { handleStructuredPayload, type ReplyContext } from "./reply-dispatcher.js";

function buildCtx(): ReplyContext {
  return {
    target: {
      type: "c2c",
      senderId: "user-1",
      messageId: "msg-1",
    },
    account: {
      accountId: "default",
      appId: "app-id",
      clientSecret: "secret",
      config: {},
    } as ReplyContext["account"],
    cfg: {},
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("qqbot reply dispatcher", () => {
  it("allows inline data image URLs for structured image payloads", async () => {
    const ctx = buildCtx();
    const recordActivity = vi.fn();
    const dataUrl = "data:image/png;base64,Zm9v";

    const handled = await handleStructuredPayload(
      ctx,
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "image",
        source: "url",
        path: dataUrl,
      })}`,
      recordActivity,
    );

    expect(handled).toBe(true);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendC2CImageMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      dataUrl,
      "msg-1",
      undefined,
      undefined,
    );
  });
});
