import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) =>
    channel === "voicechat" || channel === "telegram",
}));

import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";

const EMPTY_CONFIG = {} as OpenClawConfig;

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
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "voicechat", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
  });

  it("sends the default formatted transcript to the resolved origin", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("uses a custom format when provided", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "custom message",
      format: "🎙️ Heard: {transcript}",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: "🎙️ Heard: custom message" }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "internal-system", From: "some-source" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("prefers OriginatingTo when From is absent", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: "+19999999999" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+19999999999",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("forwards Telegram account and thread metadata to outbound delivery", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        AccountId: "primary",
        MessageThreadId: 77,
      }),
      cfg: EMPTY_CONFIG,
      transcript: "threaded voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "telegram",
      to: "telegram:42",
      accountId: "primary",
      threadId: 77,
      payloads: [
        { text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "threaded voice note") },
      ],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        ctx: createCtx(),
        cfg: EMPTY_CONFIG,
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});
