import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { handleQaInbound, isHttpMediaUrl } from "./inbound.js";

const dispatchInboundReplyWithBaseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", () => ({
  dispatchInboundReplyWithBase: dispatchInboundReplyWithBaseMock,
}));

beforeEach(() => {
  dispatchInboundReplyWithBaseMock.mockReset();
});

describe("isHttpMediaUrl", () => {
  it("accepts only http and https urls", () => {
    expect(isHttpMediaUrl("https://example.com/image.png")).toBe(true);
    expect(isHttpMediaUrl("http://example.com/image.png")).toBe(true);
    expect(isHttpMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpMediaUrl("/etc/passwd")).toBe(false);
    expect(isHttpMediaUrl("data:text/plain;base64,SGVsbG8=")).toBe(false);
  });
});

describe("handleQaInbound", () => {
  it("marks group messages that match configured mention patterns", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.mentions.buildMentionRegexes).mockReturnValue([/\b@?openclaw\b/i]);
    setQaChannelRuntime(runtime);

    await handleQaInbound({
      channelId: "qa-channel",
      channelLabel: "QA Channel",
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:43123",
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        pollTimeoutMs: 250,
        config: {},
      },
      config: {},
      message: {
        id: "msg-1",
        accountId: "default",
        direction: "inbound",
        conversation: {
          kind: "channel",
          id: "qa-room",
          title: "QA Room",
        },
        senderId: "alice",
        senderName: "Alice",
        text: "@openclaw ping",
        timestamp: 1_777_000_000_000,
        reactions: [],
      },
    });

    expect(dispatchInboundReplyWithBaseMock).toHaveBeenCalledTimes(1);
    expect(dispatchInboundReplyWithBaseMock.mock.calls[0]?.[0].ctxPayload.WasMentioned).toBe(true);
  });
});
