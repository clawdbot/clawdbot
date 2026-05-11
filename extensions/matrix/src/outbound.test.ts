import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

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

  it("passes resolved cfg to sendMessageMatrix for media sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendMedia!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      mediaUrl: "file:///tmp/cat.png",
      mediaLocalRoots: ["/tmp/openclaw"],
      accountId: "default",
      audioAsVoice: true,
    });

    const call = mockCall(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(call[0]).toBe("room:!room:example");
    expect(call[1]).toBe("caption");
    const options = mockOptions(mocks.sendMessageMatrix, "sendMessageMatrix");
    expect(options.cfg).toBe(cfg);
    expect(options.mediaUrl).toBe("file:///tmp/cat.png");
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
      (rendered?.channelData?.matrix as { extraContent?: Record<string, unknown> }).extraContent?.[
        "com.openclaw.presentation"
      ],
    ).toEqual({
      ...presentation,
      version: 1,
      type: "message.presentation",
    });
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
