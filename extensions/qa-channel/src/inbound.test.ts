// Qa Channel tests cover inbound plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { deleteQaBusMessage, editQaBusMessage, sendQaBusMessage } from "./bus-client.js";
import { handleQaInbound, isHttpMediaUrl } from "./inbound.js";

vi.mock("./bus-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bus-client.js")>();
  return {
    ...actual,
    deleteQaBusMessage: vi.fn(async () => ({ message: {} })),
    editQaBusMessage: vi.fn(async () => ({ message: {} })),
    sendQaBusMessage: vi.fn(async () => ({ message: { id: "preview-1" } })),
  };
});

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

function firstRunAssembledParams(runtime: ReturnType<typeof createPluginRuntimeMock>) {
  const call = vi.mocked(runtime.channel.inbound.dispatchReply).mock.calls[0];
  if (!call) {
    throw new Error("expected assembled turn call");
  }
  return call[0];
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes partial replies as one edited preview before final delivery", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        message: {
          conversation: { id: "qa-room", kind: "group" },
          threadId: "42",
        },
      }),
    );

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    await assembled.replyOptions?.onPartialReply?.({ text: "preview expanded" });
    await assembled.delivery.deliver({ text: "final answer" }, { kind: "final" });

    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "msg-1",
        text: "preview",
        threadId: "42",
        to: "thread:qa-room/42",
      }),
    );
    expect(editQaBusMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messageId: "preview-1", text: "preview expanded" }),
    );
    expect(editQaBusMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: "preview-1", text: "final answer" }),
    );
  });

  it("treats deliveries without dispatcher metadata as final replies", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(createQaInboundParams());

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    const missingDeliveryInfo = undefined as unknown as Parameters<
      typeof assembled.delivery.deliver
    >[1];
    await assembled.delivery.deliver({ text: "final answer" }, missingDeliveryInfo);

    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "preview-1", text: "final answer" }),
    );
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("keeps block deliveries separate and retains tool calls discovered after a preview", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(createQaInboundParams());

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    await assembled.replyOptions?.onToolStart?.({
      phase: "start",
      name: "search",
      args: { query: "qa" },
    });
    await assembled.delivery.deliver({ text: "tool result" }, { kind: "block" });
    await assembled.delivery.deliver({ text: "final answer" }, { kind: "final" });

    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledTimes(3);
    expect(sendQaBusMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "tool result",
        toolCalls: [{ name: "search", arguments: { query: "[redacted]" } }],
      }),
    );
    expect(sendQaBusMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        text: "final answer",
        toolCalls: [{ name: "search", arguments: { query: "[redacted]" } }],
      }),
    );
  });

  it("deletes an active preview when reply dispatch fails", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(createQaInboundParams());

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "unfinished preview" });
    assembled.delivery.onError?.(new Error("model failed"), { kind: "final" });

    await vi.waitFor(() => {
      expect(deleteQaBusMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "preview-1" }),
      );
    });
  });

  it("deletes a preview after a queued edit fails", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);
    vi.mocked(editQaBusMessage).mockRejectedValueOnce(new Error("edit failed"));

    await handleQaInbound(createQaInboundParams());

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "first preview" });
    await expect(
      assembled.replyOptions?.onPartialReply?.({ text: "broken preview" }),
    ).rejects.toThrow("edit failed");
    assembled.delivery.onError?.(new Error("dispatch failed"), { kind: "final" });

    await vi.waitFor(() => {
      expect(deleteQaBusMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "preview-1" }),
      );
    });
  });

  it("escapes control characters in dispatch error logs", async () => {
    const runtime = createPluginRuntimeMock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c1Control = String.fromCharCode(0x9b);
    const lineSeparator = String.fromCodePoint(0x2028);
    const paragraphSeparator = String.fromCodePoint(0x2029);
    vi.mocked(deleteQaBusMessage).mockRejectedValueOnce(
      new Error(`cleanup\nforged\u001b[31m${c1Control}32m${lineSeparator}next`),
    );
    setQaChannelRuntime(runtime);

    try {
      await handleQaInbound(createQaInboundParams());

      const assembled = firstRunAssembledParams(runtime);
      await assembled.replyOptions?.onPartialReply?.({ text: "unfinished preview" });
      assembled.delivery.onError?.(new Error(`dispatch\r\nforged${paragraphSeparator}next`), {
        kind: "final",
      });

      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledTimes(2);
      });
      assembled.delivery.onError?.(undefined, { kind: "final" });
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledTimes(3);
      });
      const output = warn.mock.calls.flat().join(" ");
      expect(output).not.toContain("\r");
      expect(output).not.toContain("\n");
      expect(output).not.toContain(String.fromCharCode(0x1b));
      expect(output).not.toContain(c1Control);
      expect(output).not.toContain(lineSeparator);
      expect(output).not.toContain(paragraphSeparator);
      expect(output).toContain("dispatch\\u000d\\u000aforged\\u2029next");
      expect(output).toContain("cleanup\\u000aforged\\u001b[31m\\u009b32m\\u2028next");
      expect(output).toContain("reply dispatch failed: undefined");
    } finally {
      warn.mockRestore();
    }
  });

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

    expect(runtime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const assembled = firstRunAssembledParams(runtime);
    expect(assembled.replyPipeline).toEqual({});
    expect(assembled.ctxPayload.WasMentioned).toBe(true);
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

    expect(runtime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
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

    expect(runtime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const ctxPayload = firstRunAssembledParams(runtime).ctxPayload;
    expect(ctxPayload?.CommandAuthorized).toBe(true);
    expect(ctxPayload?.SenderId).toBe("alice");
  });

  it("routes native commands through a separate slash session to the conversation session", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        message: {
          text: "/stop",
          nativeCommand: { name: "stop" },
        },
      }),
    );

    const assembled = firstRunAssembledParams(runtime);
    expect(assembled.ctxPayload).toMatchObject({
      CommandAuthorized: true,
      CommandSource: "native",
      CommandTargetSessionKey: assembled.routeSessionKey,
      CommandTurn: {
        body: "/stop",
        source: "native",
      },
    });
    expect(assembled.ctxPayload.SessionKey).toContain("qa-channel:slash:alice");
    expect(assembled.ctxPayload.SessionKey).not.toBe(assembled.routeSessionKey);
  });

  it("skips malformed inline attachment base64 without dropping the message", async () => {
    const runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);

    await handleQaInbound(
      createQaInboundParams({
        message: {
          attachments: [
            {
              id: "attachment-1",
              kind: "image",
              mimeType: "image/png",
              contentBase64: "AAA@@@",
            },
          ],
        },
      }),
    );

    expect(runtime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const ctxPayload = firstRunAssembledParams(runtime).ctxPayload;
    expect(ctxPayload.MediaPath).toBeUndefined();
    expect(ctxPayload.MediaPaths).toBeUndefined();
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

    expect(runtime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(runtime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
  });
});
