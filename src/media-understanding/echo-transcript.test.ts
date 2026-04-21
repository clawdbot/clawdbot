import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "voicechat",
}));

import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";

function createCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue([{ channel: "voicechat", messageId: "echo-1" }]);
  });

  it("sends the default formatted transcript to the resolved origin", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: {} as OpenClawConfig,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: {},
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
    });
  });

  it("uses a custom format when provided", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: {} as OpenClawConfig,
      transcript: "custom message",
      format: "🎙️ Heard: {transcript}",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "🎙️ Heard: custom message" }],
      }),
    );
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "internal-system", From: "some-source" }),
      cfg: {} as OpenClawConfig,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      cfg: {} as OpenClawConfig,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("prefers OriginatingTo when From is absent", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: "+19999999999" }),
      cfg: {} as OpenClawConfig,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+19999999999",
      }),
    );
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        ctx: createCtx(),
        cfg: {} as OpenClawConfig,
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});
