// Matrix tests cover outbound plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkTextForOutbound, type OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: mocks.sendPollMatrix,
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { matrixOutbound } from "./outbound.js";

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCall(source: MockCallSource, label: string, callIndex = 0): Array<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function mockOptions(
  source: MockCallSource,
  label: string,
  callIndex = 0,
): Record<string, unknown> {
  const value = mockCall(source, label, callIndex)[2];
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} call ${callIndex} options`);
  }
  return value as Record<string, unknown>;
}

function createMatrixReceipt(
  parts: Array<{ messageId: string; kind: "text" | "media" | "voice"; replyToId?: string }>,
) {
  const firstPart = parts[0];
  return {
    primaryPlatformMessageId: firstPart?.messageId,
    platformMessageIds: parts.map(({ messageId }) => messageId),
    parts: parts.map(({ messageId, kind, replyToId }, index) => ({
      platformMessageId: messageId,
      kind,
      index,
      ...(replyToId ? { replyToId } : {}),
    })),
    ...(firstPart?.replyToId ? { replyToId: firstPart.replyToId } : {}),
    sentAt: 1,
  };
}

describe("matrixOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendPollMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "evt-1", roomId: "!room:example" });
    mocks.sendPollMatrix.mockResolvedValue({ eventId: "$poll", roomId: "!room:example" });
  });

  it("chunks outbound text without requiring Matrix runtime initialization", () => {
    const chunker = matrixOutbound.chunker;
    if (!chunker) {
      throw new Error("matrixOutbound.chunker missing");
    }

    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  it("makes progress for fractional BMP and astral limits", () => {
    const chunker = matrixOutbound.chunker;
    if (!chunker) {
      throw new Error("matrixOutbound.chunker missing");
    }

    expect(chunker("ABCD", 0.5)).toEqual(["A", "B", "C", "D"]);
    expect(chunker("😀😀", 1.5)).toEqual(["😀", "😀"]);
    expect(chunkTextForOutbound("ABCD", 0.5)).toEqual(["A", "B", "C", "D"]);
    expect(chunkTextForOutbound("😀😀", 1.5)).toEqual(["😀", "😀"]);
  });

  it("preserves Matrix compatibility behavior", () => {
    expect(chunkTextForOutbound("", 5)).toEqual([""]);
    expect(chunkTextForOutbound("", 0.5)).toEqual([""]);
    expect(chunkTextForOutbound("abcdef   ", 5)).toEqual(["abcde", "f   "]);
  });

  it("passes resolved cfg to sendMessageMatrix for text sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendText!({
      cfg,
      to: "room:!room:example",
      text: "hello",
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("hello");
    const options = mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(options.cfg).toBe(cfg);
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("$thread");
    expect(options.replyToId).toBe("$reply");
  });

  it.each(["sendText", "sendMedia"] as const)(
    "preserves the complete Matrix sender result through %s",
    async (method) => {
      const receipt = createMatrixReceipt([
        { messageId: "$first", kind: "media", replyToId: "$reply" },
        { messageId: "$last", kind: "text" },
      ]);
      mocks.sendMessageMatrix.mockResolvedValueOnce({
        messageId: "$last",
        roomId: "!room:example",
        primaryMessageId: "$first",
        receipt,
        content: "first\nlast",
      });
      const send = matrixOutbound[method];
      if (!send) {
        throw new Error(`matrixOutbound.${method} missing`);
      }

      const result = await send({
        cfg: {} as OpenClawConfig,
        to: "room:!room:example",
        text: "first\nlast",
        mediaUrl: "file:///tmp/photo.png",
        accountId: "default",
      });

      expect(result).toMatchObject({
        channel: "matrix",
        messageId: "$last",
        target: { kind: "room", id: "!room:example" },
        primaryMessageId: "$first",
        content: "first\nlast",
      });
      expect(result.receipt).toBe(receipt);
    },
  );

  it("passes resolved cfg to sendMessageMatrix for media sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;
    const mediaAccess = {
      localRoots: ["/tmp/openclaw"],
      workspaceDir: "/tmp/openclaw",
    };

    await matrixOutbound.sendMedia!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      mediaUrl: "chart.png",
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      accountId: "default",
      audioAsVoice: true,
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("caption");
    const options = mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(options.cfg).toBe(cfg);
    expect(options.mediaUrl).toBe("chart.png");
    expect(options.mediaAccess).toBe(mediaAccess);
    expect(options.mediaLocalRoots).toEqual(["/tmp/openclaw"]);
    expect(options.audioAsVoice).toBe(true);
  });

  it("passes resolved cfg through injected deps.matrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;
    const matrix = vi.fn(async () => ({
      messageId: "evt-injected",
      roomId: "!room:example",
    }));

    await matrixOutbound.sendText!({
      cfg,
      to: "room:!room:example",
      text: "hello via deps",
      deps: { matrix },
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    const call = mockCall(matrix, "deps.matrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("hello via deps");
    const options = mockOptions(matrix, "deps.matrix");
    expect(options.cfg).toBe(cfg);
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("$thread");
    expect(options.replyToId).toBe("$reply");
  });

  it("passes resolved cfg to sendPollMatrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPoll!({
      cfg,
      to: "room:!room:example",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
      accountId: "default",
      threadId: "$thread",
    });

    const call = mockCall(mocks.sendPollMatrix, "sendPollMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toEqual({
      question: "Snack?",
      options: ["Pizza", "Sushi"],
    });
    const options = mockOptions(mocks.sendPollMatrix, "sendPollMatrix");
    expect(options.cfg).toBe(cfg);
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("$thread");
  });

  it("renders MessagePresentation into Matrix custom content metadata", async () => {
    const presentation = {
      title: "Select thinking level",
      tone: "info" as const,
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Low", value: "/think low" },
            { label: "High", value: "/think high", style: "primary" as const },
          ],
        },
      ],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "fallback", presentation },
      presentation,
      ctx: {} as never,
    });

    const matrixData = rendered?.channelData?.matrix as {
      extraContent?: Record<string, unknown>;
    };
    expect(rendered?.text).toContain("fallback");
    expect(rendered?.text).toContain("Select thinking level");
    expect(matrixData.extraContent?.["com.openclaw.presentation"]).toEqual({
      ...presentation,
      version: 1,
      type: "message.presentation",
    });
  });

  it("renders divider-only MessagePresentation with a non-empty Matrix fallback body", async () => {
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "", presentation },
      presentation,
      ctx: {} as never,
    });

    expect(rendered?.text).toBe("---");
    expect(
      (rendered!.channelData!.matrix as { extraContent?: Record<string, unknown> }).extraContent?.[
        "com.openclaw.presentation"
      ],
    ).toEqual({
      ...presentation,
      version: 1,
      type: "message.presentation",
    });
  });

  it("keeps typed select commands actionable in Matrix fallback content", async () => {
    const presentation = {
      blocks: [
        {
          type: "select" as const,
          placeholder: "Environment",
          options: [
            {
              label: "Production",
              action: { type: "command" as const, command: "/deploy production" },
            },
            {
              label: "Opaque",
              action: { type: "callback" as const, value: "private-callback-token" },
            },
          ],
        },
      ],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "Choose", presentation },
      presentation,
      ctx: {} as never,
    });

    expect(rendered?.text).toBe(
      "Choose\n\nEnvironment:\n- Production: `/deploy production`\n- Opaque",
    );
    expect(rendered?.text).not.toContain("private-callback-token");
  });

  it("passes Matrix presentation metadata through sendPayload extraContent", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    const presentationContent = {
      version: 1,
      type: "message.presentation",
      title: "Select model",
      blocks: [
        {
          type: "select",
          placeholder: "Choose model",
          options: [{ label: "DeepSeek", value: "/model deepseek/deepseek-chat" }],
        },
      ],
    };

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "Select model",
      payload: {
        text: "Select model",
        channelData: {
          matrix: {
            extraContent: {
              "com.openclaw.presentation": presentationContent,
            },
          },
        },
      },
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("Select model");
    const options = mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(options.cfg).toBe(cfg);
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("$thread");
    expect(options.replyToId).toBe("$reply");
    expect(options.extraContent).toEqual({
      "com.openclaw.presentation": presentationContent,
    });
  });

  it("sends empty Matrix presentation payloads with a minimal fallback body", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    const presentationContent = {
      version: 1,
      type: "message.presentation",
      blocks: [{ type: "divider" }],
    };

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "",
      payload: {
        text: "",
        channelData: {
          matrix: {
            extraContent: {
              "com.openclaw.presentation": presentationContent,
            },
          },
        },
      },
      accountId: "default",
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("---");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix").extraContent).toEqual({
      "com.openclaw.presentation": presentationContent,
    });
  });

  it("only forwards presentation metadata from Matrix extraContent", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    const presentationContent = {
      version: 1,
      type: "message.presentation",
      title: "Select model",
      blocks: [{ type: "divider" }],
    };

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "Select model",
      payload: {
        text: "Select model",
        channelData: {
          matrix: {
            extraContent: {
              body: "spoofed",
              msgtype: "m.notice",
              "m.relates_to": { "m.in_reply_to": { event_id: "$spoof" } },
              "com.openclaw.presentation": presentationContent,
            },
          },
        },
      },
      accountId: "default",
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("Select model");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix").extraContent).toEqual({
      "com.openclaw.presentation": presentationContent,
    });
  });

  it("sends all media URLs via sendPayload", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
      },
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    const firstCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 0);
    expect(firstCall[0]).toBe("room:!room:example");
    expect(firstCall[1]).toBe("caption");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 0).mediaUrl).toBe(
      "file:///tmp/a.png",
    );
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 0).threadId).toBe("$thread");
    const secondCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 1);
    expect(secondCall[0]).toBe("room:!room:example");
    expect(secondCall[1]).toBe("");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 1).mediaUrl).toBe(
      "file:///tmp/b.png",
    );
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 1).threadId).toBe("$thread");
  });

  it("preserves durable dispatch ownership across sendPayload media fanout", async () => {
    const onPlatformSendDispatch = vi.fn();

    await matrixOutbound.sendPayload!({
      cfg: {} as OpenClawConfig,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["", "file:///tmp/a.png", "   ", "file:///tmp/b.png"],
      },
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch,
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    expect(mockOptions(mocks.sendMessageMatrix, "first media", 0)).toMatchObject({
      mediaUrl: "file:///tmp/a.png",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
      deliveryPartCount: 2,
      onPlatformSendDispatch,
    });
    expect(mockOptions(mocks.sendMessageMatrix, "second media", 1)).toMatchObject({
      mediaUrl: "file:///tmp/b.png",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 1,
      deliveryPartCount: 2,
      onPlatformSendDispatch,
    });
  });

  it("combines media payload receipts without inventing replies on later events", async () => {
    const firstReceipt = createMatrixReceipt([
      { messageId: "$image", kind: "media", replyToId: "$reply" },
      { messageId: "$caption-overflow", kind: "text" },
    ]);
    const secondReceipt = createMatrixReceipt([{ messageId: "$second-image", kind: "media" }]);
    mocks.sendMessageMatrix
      .mockResolvedValueOnce({
        messageId: "$caption-overflow",
        roomId: "!room:example",
        primaryMessageId: "$image",
        receipt: firstReceipt,
        content: "caption\noverflow",
      })
      .mockResolvedValueOnce({
        messageId: "$second-image",
        roomId: "!room:example",
        primaryMessageId: "$second-image",
        receipt: secondReceipt,
        content: "second image",
      });

    const result = await matrixOutbound.sendPayload!({
      cfg: {} as OpenClawConfig,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
      },
      accountId: "default",
      replyToId: "$reply",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 0).replyToId).toBe("$reply");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 1).replyToId).toBeUndefined();
    expect(result).toMatchObject({
      channel: "matrix",
      messageId: "$second-image",
      primaryMessageId: "$image",
      content: "caption\noverflow\nsecond image",
    });
    expect(result.receipt?.primaryPlatformMessageId).toBe("$image");
    expect(result.receipt?.platformMessageIds).toEqual([
      "$image",
      "$caption-overflow",
      "$second-image",
    ]);
    expect(result.receipt?.parts).toMatchObject([
      { platformMessageId: "$image", kind: "media", index: 0, replyToId: "$reply" },
      { platformMessageId: "$caption-overflow", kind: "text", index: 1 },
      { platformMessageId: "$second-image", kind: "media", index: 2 },
    ]);
    expect(result.receipt?.parts[1]).not.toHaveProperty("replyToId");
    expect(result.receipt?.parts[2]).not.toHaveProperty("replyToId");
  });

  it("sends mediaUrls with extraContent only on first item", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
        channelData: {
          matrix: {
            extraContent: {
              "com.openclaw.presentation": {
                version: 1,
                type: "message.presentation",
              },
            },
          },
        },
      },
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    const firstCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 0);
    expect(firstCall[0]).toBe("room:!room:example");
    expect(firstCall[1]).toBe("caption");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 0).extraContent).toEqual({
      "com.openclaw.presentation": {
        version: 1,
        type: "message.presentation",
      },
    });
    const secondCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 1);
    expect(secondCall[0]).toBe("room:!room:example");
    expect(secondCall[1]).toBe("");
    expect(
      mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 1).extraContent,
    ).toBeUndefined();
  });

  it("applies caption and presentation metadata to the first non-empty media URL", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "test-access-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["", "file:///tmp/a.png"],
        channelData: {
          matrix: {
            extraContent: {
              "com.openclaw.presentation": {
                version: 1,
                type: "message.presentation",
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[1]).toBe("caption");
    const options = mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(options.mediaUrl).toBe("file:///tmp/a.png");
    expect(options.extraContent).toEqual({
      "com.openclaw.presentation": {
        version: 1,
        type: "message.presentation",
      },
    });
  });

  it("falls back to a text send when every media URL is empty", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "test-access-token",
        },
      },
    } as OpenClawConfig;

    const result = await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: [""],
      },
      accountId: "default",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[1]).toBe("caption");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix").mediaUrl).toBeUndefined();
    expect(result).toEqual({
      channel: "matrix",
      messageId: "evt-1",
      target: { kind: "room", id: "!room:example" },
    });
  });

  it("regression: mediaUrls are never silently dropped by sendPayload", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "regression-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:regression",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["file:///img1.png", "file:///img2.png", "file:///img3.png"],
      },
      accountId: "default",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(3);
    const firstCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 0);
    expect(firstCall[0]).toBe("room:!room:regression");
    expect(firstCall[1]).toBe("caption");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 0).mediaUrl).toBe(
      "file:///img1.png",
    );
    const secondCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 1);
    expect(secondCall[0]).toBe("room:!room:regression");
    expect(secondCall[1]).toBe("");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 1).mediaUrl).toBe(
      "file:///img2.png",
    );
    const thirdCall = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix", 2);
    expect(thirdCall[0]).toBe("room:!room:regression");
    expect(thirdCall[1]).toBe("");
    expect(mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix", 2).mediaUrl).toBe(
      "file:///img3.png",
    );
  });
});
