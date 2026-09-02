import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dispatchInboundDirectDm } from "./direct-dm.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import { resolveStableChannelMessageIngress } from "./message-access/runtime.js";

const mocks = vi.hoisted(() => ({
  dispatchRoutedChannelTurn: vi.fn(async () => undefined),
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

vi.mock("./turn/lifecycle.js", () => ({
  dispatchRoutedChannelTurn: mocks.dispatchRoutedChannelTurn,
}));

describe("dispatchInboundDirectDm", () => {
  it("forwards the canonical model-selection reply pipeline", async () => {
    const channelIngress = await resolveStableChannelMessageIngress({
      channelId: "nostr",
      accountId: "account-1",
      subject: { stableId: "peer-1" },
      conversation: { kind: "direct", id: "peer-1" },
      dmPolicy: "open",
    });
    await dispatchInboundDirectDm({
      channelIngress,
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

    expect(mocks.dispatchRoutedChannelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        replyPipeline: { humanDelay: { minMs: 1, maxMs: 2 } },
        replyOptions: { onModelSelected: mocks.onModelSelected },
      }),
    );
    expect(vi.mocked(buildChannelInboundEventContext).mock.calls[0]?.[0].channelIngress).toBe(
      channelIngress,
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
      channelIngress: "unsupported",
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

    expect(mocks.dispatchRoutedChannelTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({ turnAdoptionLifecycle }),
      }),
    );
    expect(vi.mocked(buildChannelInboundEventContext).mock.calls[1]?.[0].channelIngress).toBe(
      "unsupported",
    );
  });

  it("resolves exact ingress provenance once after the final route is known", async () => {
    const resolveChannelIngress = vi.fn(
      async (
        contextBinding: Parameters<typeof resolveStableChannelMessageIngress>[0]["contextBinding"],
      ) =>
        await resolveStableChannelMessageIngress({
          channelId: "nostr",
          accountId: "account-1",
          subject: { stableId: "peer-1" },
          conversation: { kind: "direct", id: "peer-1" },
          contextBinding,
          dmPolicy: "open",
        }),
    );

    await dispatchInboundDirectDm({
      resolveChannelIngress,
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

    expect(resolveChannelIngress).toHaveBeenCalledOnce();
    expect(resolveChannelIngress).toHaveBeenCalledWith({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:nostr:direct:peer-1",
      messageId: "event-1",
      inboundEventKind: "user_request",
    });
    expect(vi.mocked(buildChannelInboundEventContext).mock.calls.at(-1)?.[0].channelIngress).toBe(
      await resolveChannelIngress.mock.results[0]?.value,
    );
  });

  it("preserves the shipped SDK contract for callers without ingress provenance", async () => {
    await dispatchInboundDirectDm({
      cfg: {} as OpenClawConfig,
      channel: "external",
      channelLabel: "External",
      accountId: "default",
      peer: { kind: "direct", id: "peer-1" },
      senderId: "peer-1",
      senderAddress: "external:peer-1",
      recipientAddress: "external:bot-1",
      conversationLabel: "peer-1",
      rawBody: "hello",
      messageId: "event-external-1",
      deliver: async () => undefined,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(
      vi.mocked(buildChannelInboundEventContext).mock.calls.at(-1)?.[0].channelIngress,
    ).toBeUndefined();
  });

  it("preserves Reef's explicit unsupported trust-path classification", async () => {
    await dispatchInboundDirectDm({
      channelIngress: "unsupported",
      cfg: {} as OpenClawConfig,
      channel: "reef",
      channelLabel: "Reef",
      accountId: "default",
      peer: { kind: "direct", id: "peer-1" },
      senderId: "peer-1",
      senderAddress: "reef:peer-1",
      recipientAddress: "reef:bot-1",
      conversationLabel: "@peer-1's agent",
      rawBody: "hello",
      messageId: "event-reef-1",
      inboundAccessAuthorized: true,
      deliver: async () => undefined,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    const contextParams = vi.mocked(buildChannelInboundEventContext).mock.calls.at(-1)?.[0];
    expect(contextParams?.channelIngress).toBe("unsupported");
    expect(contextParams?.reply).toEqual({
      to: "reef:bot-1",
      originatingTo: "reef:peer-1",
    });
    expect(contextParams?.conversation.routePeer).toEqual({ kind: "direct", id: "peer-1" });
  });
});
