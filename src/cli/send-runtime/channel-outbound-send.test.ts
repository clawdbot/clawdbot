import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadChannelOutboundAdapter: vi.fn(),
}));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: mocks.loadChannelOutboundAdapter,
}));

describe("createChannelOutboundRuntimeSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
    expect(mockFn).toHaveBeenCalledTimes(1);
    const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (params === undefined) {
      throw new Error("expected outbound send call params");
    }
    return params;
  }

  it("routes media sends through sendMedia and preserves media access", async () => {
    const sendMedia = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText: vi.fn(),
      sendMedia,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/photo.png",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      gifPlayback: true,
    });

    const params = expectSingleCallParams(sendMedia);
    expect(params.cfg).toEqual({});
    expect(params.to).toBe("+15551234567");
    expect(params.text).toBe("caption");
    expect(params.mediaUrl).toBe("file:///tmp/photo.png");
    expect(params.mediaAccess).toEqual({
      localRoots: ["/tmp/workspace"],
      readFile: mediaReadFile,
    });
    expect(params.mediaLocalRoots).toEqual(["/tmp/fallback-root"]);
    expect(params.mediaReadFile).toBe(mediaReadFile);
    expect(params.accountId).toBe("default");
    expect(params.gifPlayback).toBe(true);
  });

  it("falls back to sendText for text-only sends", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-2" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
      sendMedia: vi.fn(),
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "hello", {
      cfg: {},
      accountId: "default",
    });

    const params = expectSingleCallParams(sendText);
    expect(params.cfg).toEqual({});
    expect(params.to).toBe("+15551234567");
    expect(params.text).toBe("hello");
    expect(params.accountId).toBe("default");
  });

  it("routes block sends through payload delivery", async () => {
    const sendPayload = vi.fn(async () => ({ channel: "slack", messageId: "slack-blocks" }));
    const sendText = vi.fn();
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendPayload,
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });
    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "OK" }, value: "ok" }],
      },
    ];

    await runtimeSend.sendMessage("C123", "fallback", {
      cfg: {},
      accountId: "default",
      blocks,
    });

    const params = expectSingleCallParams(sendPayload);
    expect(params.accountId).toBe("default");
    expect(params.cfg).toEqual({});
    expect(params.payload).toEqual({
      channelData: {
        slack: { blocks },
      },
      text: "fallback",
    });
    expect(params.text).toBe("fallback");
    expect(params.to).toBe("C123");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "matrix", messageId: "$reply" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "matrix" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("room:!ops:example.org", "hello thread", {
      cfg: {},
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    });

    const params = expectSingleCallParams(sendText);
    expect(params.accountId).toBe("sut");
    expect(params.replyToId).toBe("$parent");
    expect(params.threadId).toBe("$thread-root");
    expect(params.to).toBe("room:!ops:example.org");
  });

  it("forwards Slack threadTs alias to threadId", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      threadTs: "1712345678.123456",
    });

    const params = expectSingleCallParams(sendText);
    expect(params.cfg).toEqual({});
    expect(params.to).toBe("C123");
    expect(params.text).toBe("hello");
    expect(params.threadId).toBe("1712345678.123456");
  });

  it("prefers canonical thread fields over Slack aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-2" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      messageThreadId: "200.000",
      threadId: "150.000",
      threadTs: "100.000",
      replyToMessageId: "400.000",
      replyToId: "300.000",
    });

    const params = expectSingleCallParams(sendText);
    expect(params.cfg).toEqual({});
    expect(params.threadId).toBe("200.000");
    expect(params.replyToId).toBe("400.000");
  });

  it("falls back to sendText when media is present but sendMedia is unavailable", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-3" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const mediaReadFile = vi.fn(async () => Buffer.from("pdf"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/test.pdf",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      forceDocument: true,
    });

    const params = expectSingleCallParams(sendText);
    expect(params.cfg).toEqual({});
    expect(params.to).toBe("+15551234567");
    expect(params.text).toBe("caption");
    expect(params.mediaUrl).toBe("file:///tmp/test.pdf");
    expect(params.mediaAccess).toEqual({
      localRoots: ["/tmp/workspace"],
      readFile: mediaReadFile,
    });
    expect(params.mediaLocalRoots).toEqual(["/tmp/fallback-root"]);
    expect(params.mediaReadFile).toBe(mediaReadFile);
    expect(params.accountId).toBe("default");
    expect(params.forceDocument).toBe(true);
  });
});
