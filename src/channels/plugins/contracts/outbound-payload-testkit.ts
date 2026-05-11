import { beforeEach, expect, it, type Mock } from "vitest";
import type { ReplyPayload } from "../../../plugin-sdk/reply-payload.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";

type PayloadLike = Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "text">;

type SendResultLike = {
  messageId: string;
  [key: string]: unknown;
};

type ChunkingMode =
  | {
      longTextLength: number;
      maxChunkLength: number;
      mode: "split";
    }
  | {
      longTextLength: number;
      mode: "passthrough";
    };

type OutboundPayloadHarness = {
  run: () => Promise<Record<string, unknown>>;
  sendMock: Mock;
  to: string;
};

export type OutboundPayloadHarnessParams = {
  payload: PayloadLike;
  sendResults?: SendResultLike[];
};

function sendCall(sendMock: Mock, index: number): unknown[] {
  const call = sendMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected send call ${index}`);
  }
  return call;
}

export function installChannelOutboundPayloadContractSuite(params: {
  channel: string;
  chunking: ChunkingMode;
  createHarness: (
    params: OutboundPayloadHarnessParams,
  ) => OutboundPayloadHarness | Promise<OutboundPayloadHarness>;
}) {
  beforeEach(() => {
    resetGlobalHookRunner();
  });

  it("text-only delegates to sendText", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: { text: "hello" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("hello");
    expect(call[2]).toBeDefined();
    expect(result.channel).toBe(params.channel);
  });

  it("single media delegates to sendMedia", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: { text: "cap", mediaUrl: "https://example.com/a.jpg" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("cap");
    expect((call[2] as Record<string, unknown>).mediaUrl).toBe("https://example.com/a.jpg");
    expect(result.channel).toBe(params.channel);
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      },
      sendResults: [{ messageId: "m-1" }, { messageId: "m-2" }],
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = sendCall(sendMock, 0);
    expect(first[0]).toBe(to);
    expect(first[1]).toBe("caption");
    expect((first[2] as Record<string, unknown>).mediaUrl).toBe("https://example.com/1.jpg");
    const second = sendCall(sendMock, 1);
    expect(second[0]).toBe(to);
    expect(second[1]).toBe("");
    expect((second[2] as Record<string, unknown>).mediaUrl).toBe("https://example.com/2.jpg");
    expect(result.channel).toBe(params.channel);
    expect(result.messageId).toBe("m-2");
  });

  it("empty payload returns no-op", async () => {
    const { run, sendMock } = await params.createHarness({ payload: {} });
    const result = await run();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: params.channel, messageId: "" });
  });

  if (params.chunking.mode === "passthrough") {
    it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
      const text = "a".repeat(params.chunking.longTextLength);
      const { run, sendMock, to } = await params.createHarness({ payload: { text } });
      const result = await run();

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = sendCall(sendMock, 0);
      expect(call[0]).toBe(to);
      expect(call[1]).toBe(text);
      expect(call[2]).toBeDefined();
      expect(result.channel).toBe(params.channel);
    });
    return;
  }

  const chunking = params.chunking;

  it("chunking splits long text", async () => {
    const text = "a".repeat(chunking.longTextLength);
    const { run, sendMock } = await params.createHarness({
      payload: { text },
      sendResults: [{ messageId: "c-1" }, { messageId: "c-2" }],
    });
    const result = await run();

    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendMock.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(chunking.maxChunkLength);
    }
    expect(result.channel).toBe(params.channel);
  });
}
