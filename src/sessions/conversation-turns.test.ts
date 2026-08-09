import { describe, expect, it } from "vitest";
import {
  cancelPendingConversationTurn,
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "./conversation-turns.js";

function register(conversationRef = "conv_a", signal?: AbortSignal) {
  return registerPendingConversationTurn({
    agentId: "main",
    conversationRef,
    sessionId: "session-main",
    timeoutMs: 5_000,
    signal,
  });
}

describe("conversation turn correlation", () => {
  it("returns the stable operation id with an exact reply claim", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-alias",
      conversationRef: "conv_alias",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-alias");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_alias",
      sessionId: "session-main",
      messageId: "inbound-alias",
      replyToId: "outbound-alias",
      text: "alias reply",
    });

    expect(claim?.turnId).toBe("turn-alias");
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({ text: "alias reply" });
  });

  it("matches a reply to the exact outbound transport message", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-1");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-1",
      replyToId: "outbound-1",
      text: "hello from peer",
    });
    expect(claim).toBeDefined();
    claim?.complete({ transcriptMessageId: "transcript-1" });

    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "inbound-1",
      replyToId: "outbound-1",
      text: "hello from peer",
      transcriptMessageId: "transcript-1",
    });
  });

  it("matches a reply that promotes the outbound message into its own thread", async () => {
    const pending = register("conv_parent");
    pending.setOutboundMessageId("outbound-thread-root");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_child",
      parentConversationRef: "conv_parent",
      sessionId: "session-main",
      messageId: "inbound-thread-reply",
      replyToId: "outbound-thread-root",
      threadId: "outbound-thread-root",
      text: "threaded hello",
    });

    expect(claim).toBeDefined();
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef: "conv_child",
      replyToId: "outbound-thread-root",
      threadId: "outbound-thread-root",
    });
  });

  it("does not promote a reply thread from a different conversation in a shared session", async () => {
    const pending = register("conv_peer_a");
    pending.setOutboundMessageId("outbound-peer-a");
    pending.markReady();

    await expect(
      claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: "conv_peer_b_thread",
        parentConversationRef: "conv_peer_b",
        sessionId: "session-main",
        messageId: "inbound-peer-b",
        replyToId: "outbound-peer-a",
        threadId: "outbound-peer-a",
        text: "reply from the wrong peer",
      }),
    ).resolves.toBeUndefined();

    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("releases a failed persistence claim for a transport retry", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-retry");
    pending.markReady();

    const first = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-retry-1",
      replyToId: "outbound-retry",
      text: "first delivery",
    });
    expect(first).toBeDefined();
    first?.release();

    const retry = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-retry-2",
      replyToId: "outbound-retry",
      text: "retried delivery",
    });
    expect(retry).toBeDefined();
    retry?.complete();
    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "inbound-retry-2",
      text: "retried delivery",
    });
  });

  it("does not guess between concurrent uncorrelated turns", async () => {
    const first = register();
    const second = register();
    first.setOutboundMessageId("outbound-1");
    second.setOutboundMessageId("outbound-2");
    first.markReady();
    second.markReady();

    await expect(
      claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: "conv_a",
        sessionId: "session-main",
        messageId: "inbound-unknown",
        text: "ambiguous",
      }),
    ).resolves.toBeUndefined();

    const exact = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-2",
      replyToId: "outbound-2",
      text: "second",
    });
    exact?.complete();
    await expect(second.wait()).resolves.toMatchObject({ text: "second" });
    first.cancel();
    await expect(first.wait()).resolves.toBeUndefined();
  });

  it("does not consume an unsolicited message when only one turn is pending", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-1");
    pending.markReady();
    await expect(
      claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: "conv_a",
        sessionId: "session-main",
        messageId: "inbound-1",
        text: "unsolicited",
      }),
    ).resolves.toBeUndefined();
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("cancels immediately when its caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = register("conv_aborted", controller.signal);
    pending.setOutboundMessageId("never-sent");
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("stops consuming replies after Gateway cancellation", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "cancelled-turn",
      conversationRef: "conv_cancelled",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-cancelled");
    pending.markReady();

    expect(cancelPendingConversationTurn({ agentId: "main", id: "cancelled-turn" })).toBe(true);
    await expect(pending.wait()).resolves.toBeUndefined();
    await expect(
      claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: "conv_cancelled",
        sessionId: "session-main",
        messageId: "inbound-after-cancel",
        replyToId: "outbound-cancelled",
        text: "dispatch me normally",
      }),
    ).resolves.toBeUndefined();
    expect(cancelPendingConversationTurn({ agentId: "main", id: "cancelled-turn" })).toBe(false);
  });

  it("ignores delayed handle writes after a turn id is reused", async () => {
    const first = registerPendingConversationTurn({
      agentId: "main",
      id: "reused-turn",
      conversationRef: "conv_reused",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    first.cancel();
    await expect(first.wait()).resolves.toBeUndefined();

    const replacement = registerPendingConversationTurn({
      agentId: "main",
      id: "reused-turn",
      conversationRef: "conv_reused",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    first.setOutboundMessageId("outbound-stale");
    first.markReady();
    replacement.setOutboundMessageId("outbound-current");
    replacement.markReady();

    const claim = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_reused",
      sessionId: "session-main",
      messageId: "inbound-current",
      replyToId: "outbound-current",
      text: "current reply",
    });
    expect(claim).toBeDefined();
    claim?.complete();
    await expect(replacement.wait()).resolves.toMatchObject({ text: "current reply" });
  });

  it("isolates equal turn IDs between agents", async () => {
    const first = registerPendingConversationTurn({
      agentId: "first-agent",
      id: "shared-turn",
      conversationRef: "conv_shared",
      sessionId: "session-shared",
      timeoutMs: 5_000,
    });
    const second = registerPendingConversationTurn({
      agentId: "second-agent",
      id: "shared-turn",
      conversationRef: "conv_shared",
      sessionId: "session-shared",
      timeoutMs: 5_000,
    });
    first.setOutboundMessageId("outbound-first");
    second.setOutboundMessageId("outbound-second");
    first.markReady();
    second.markReady();

    expect(cancelPendingConversationTurn({ agentId: "first-agent", id: "shared-turn" })).toBe(true);
    await expect(first.wait()).resolves.toBeUndefined();
    const claim = await claimPendingConversationTurnReply({
      agentId: "second-agent",
      conversationRef: "conv_shared",
      sessionId: "session-shared",
      messageId: "inbound-second",
      replyToId: "outbound-second",
      text: "second reply",
    });
    claim?.complete();
    await expect(second.wait()).resolves.toMatchObject({ text: "second reply" });
  });

  it("gates an exact reply until outbound context is durable", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-fast");
    const claimPromise = claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-fast",
      replyToId: "outbound-fast",
      text: "fast reply",
    });

    pending.markReady();
    const claim = await claimPromise;
    expect(claim).toBeDefined();
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({ text: "fast reply" });
  });

  it("does not wait on an unknown reply id while outbound delivery is unresolved", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      conversationRef: "conv_unresolved",
      sessionId: "session-main",
      timeoutMs: 10_000,
    });

    await expect(
      claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: "conv_unresolved",
        sessionId: "session-main",
        messageId: "inbound-older-reply",
        replyToId: "older-outbound-id",
        text: "unrelated reply",
      }),
    ).resolves.toBeUndefined();
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("keeps the configured timeout active until reply persistence completes", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      conversationRef: "conv_slow_persist",
      sessionId: "session-main",
      timeoutMs: 1,
    });
    pending.setOutboundMessageId("outbound-slow");
    pending.markReady();
    const claim = await claimPendingConversationTurnReply({
      agentId: "main",
      conversationRef: "conv_slow_persist",
      sessionId: "session-main",
      messageId: "inbound-slow",
      replyToId: "outbound-slow",
      text: "arrived before timeout",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await expect(pending.wait()).resolves.toBeUndefined();
    claim?.complete();
  });
});
