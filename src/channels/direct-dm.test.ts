import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dispatchInboundDirectDm } from "./direct-dm.js";

const mocks = vi.hoisted(() => ({
  dispatchChannelInboundTurn: vi.fn(async () => undefined),
  onModelSelected: vi.fn(),
}));

vi.mock("./inbound-event/context.js", () => ({
  buildChannelInboundEventContext: vi.fn(() => ({ Body: "envelope:hello" })),
}));

vi.mock("./inbound-event/envelope.js", () => ({
  resolveChannelInboundRouteEnvelope: vi.fn(() => ({
    route: {
      agentId: "agent-1",
      accountId: "account-1",
      sessionKey: "agent:agent-1:nostr:direct:peer-1",
    },
    buildEnvelope: vi.fn(() => "envelope:hello"),
  })),
}));

vi.mock("./message/reply-pipeline.js", () => ({
  createChannelReplyPipeline: vi.fn(() => ({
    humanDelay: { minMs: 1, maxMs: 2 },
    onModelSelected: mocks.onModelSelected,
  })),
}));

vi.mock("./turn/kernel.js", () => ({
  dispatchChannelInboundTurn: mocks.dispatchChannelInboundTurn,
  runPreparedInboundReply: vi.fn(),
}));

describe("dispatchInboundDirectDm", () => {
  it("forwards the canonical model-selection reply pipeline", async () => {
    await dispatchInboundDirectDm({
      cfg: {} as OpenClawConfig,
      channel: "nostr",
      channelLabel: "Nostr",
      accountId: "account-1",
      peer: { kind: "direct", id: "peer-1" },
      senderId: "peer-1",
      senderAddress: "nostr:peer-1",
      recipientAddress: "nostr:bot-1",
      conversationLabel: "peer-1",
      rawBody: "hello",
      messageId: "event-1",
      deliver: async () => undefined,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(mocks.dispatchChannelInboundTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        replyPipeline: { humanDelay: { minMs: 1, maxMs: 2 } },
        replyOptions: { onModelSelected: mocks.onModelSelected },
      }),
    );
  });

  it("threads a durable ingress adoption lifecycle into the turn plan", async () => {
    const turnAdoptionLifecycle = {
      admission: "exclusive" as const,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      abortSignal: new AbortController().signal,
    };

    await dispatchInboundDirectDm({
      cfg: {} as OpenClawConfig,
      channel: "nostr",
      channelLabel: "Nostr",
      accountId: "account-1",
      peer: { kind: "direct", id: "peer-1" },
      senderId: "peer-1",
      senderAddress: "nostr:peer-1",
      recipientAddress: "nostr:bot-1",
      conversationLabel: "peer-1",
      rawBody: "hello",
      messageId: "event-1",
      turnAdoptionLifecycle,
      deliver: async () => undefined,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(mocks.dispatchChannelInboundTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({ turnAdoptionLifecycle }),
      }),
    );
  });
});
