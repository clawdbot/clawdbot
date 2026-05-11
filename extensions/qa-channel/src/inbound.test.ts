import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { handleQaInbound, isHttpMediaUrl } from "./inbound.js";

type HandleQaInboundParams = Parameters<typeof handleQaInbound>[0];

function createQaInboundParams(
  overrides: {
    accountConfig?: HandleQaInboundParams["account"]["config"];
    message?: Partial<HandleQaInboundParams["message"]>;
  } = {},
): HandleQaInboundParams {
  return {
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
      config: {
        allowFrom: ["*"],
        ...overrides.accountConfig,
      },
    },
    config: {},
    message: {
      id: "msg-1",
      accountId: "default",
      direction: "inbound",
      conversation: {
        kind: "direct",
        id: "alice",
      },
      senderId: "alice",
      senderName: "Alice",
      text: "ping",
      timestamp: 1_777_000_000_000,
      reactions: [],
      ...overrides.message,
    },
  };
}

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

    await handleQaInbound(
      createQaInboundParams({
        message: {
          conversation: {
            kind: "channel",
            id: "qa-room",
            title: "QA Room",
          },
          senderId: "alice",
          senderName: "Alice",
          text: "@openclaw ping",
        },
      }),
    );

    expect(runtime.channel.turn.runAssembled).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.channel.turn.runAssembled).mock.calls[0]?.[0].replyPipeline).toEqual(
      {},
    );
    expect(
      vi.mocked(runtime.channel.turn.runAssembled).mock.calls[0]?.[0].ctxPayload.WasMentioned,
    ).toBe(true);
  });

  it("drops direct messages outside the configured sender allowlist", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          allowFrom: ["bob"],
        },
      }),
    );

    expect(runtime.channel.turn.runAssembled).not.toHaveBeenCalled();
  });

  it("allows direct messages from configured senders", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          allowFrom: ["alice"],
        },
      }),
    );

    expect(runtime.channel.turn.runAssembled).toHaveBeenCalledTimes(1);
    const ctxPayload = vi.mocked(runtime.channel.turn.runAssembled).mock.calls[0]?.[0].ctxPayload;
    expect(ctxPayload?.CommandAuthorized).toBe(true);
    expect(ctxPayload?.SenderId).toBe("alice");
  });

  it("uses allowFrom as the group sender fallback for allowlist policy", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          allowFrom: ["alice"],
          groupPolicy: "allowlist",
        },
        message: {
          conversation: {
            kind: "group",
            id: "qa-room",
            title: "QA Room",
          },
        },
      }),
    );

    expect(runtime.channel.turn.runAssembled).toHaveBeenCalledTimes(1);
  });

  it("skips configured group messages that miss mention activation", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.mentions.buildMentionRegexes).mockReturnValue([/\b@?openclaw\b/i]);
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          groups: {
            "qa-room": {
              requireMention: true,
            },
          },
        },
        message: {
          conversation: {
            kind: "group",
            id: "qa-room",
            title: "QA Room",
          },
          text: "plain group message",
        },
      }),
    );

    expect(runtime.channel.turn.runAssembled).not.toHaveBeenCalled();
  });
});
