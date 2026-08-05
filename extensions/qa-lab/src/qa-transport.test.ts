// Qa Lab tests cover shared transport behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";

describe("waitForQaTransportAccountReady", () => {
  it.each([
    { description: "disconnected", connected: false, lifecycle: "starting" },
    { description: "unauthenticated", connected: true, lifecycle: "starting" },
    { description: "blocked", connected: true, lifecycle: "blocked" },
  ])("does not declare a $description account ready", async ({ connected, lifecycle }) => {
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          slack: [{ accountId: "sut", connected, lifecycle, running: true }],
        },
      }),
    };

    await expect(
      waitForQaTransportAccountReady({
        accountId: "sut",
        channel: "slack",
        gateway,
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(`"lifecycle":"${lifecycle}"`);
  });

  it("keeps channel-status probes inside the readiness deadline", async () => {
    const call = vi.fn().mockResolvedValue({ channelAccounts: {} });

    await expect(
      waitForQaTransportAccountReady({
        accountId: "sut",
        channel: "slack",
        gateway: { call },
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out after 5ms waiting for slack ready");

    expect(call).toHaveBeenCalledWith(
      "channels.status",
      { probe: false, timeoutMs: expect.any(Number) },
      { timeoutMs: expect.any(Number) },
    );
    const [, probe, request] = call.mock.calls[0] ?? [];
    expect(probe.timeoutMs).toBeLessThanOrEqual(5);
    expect(request.timeoutMs).toBeLessThanOrEqual(5);
  });
});

describe("createQaStateBackedTransportAdapter", () => {
  it("runs transport reset before clearing shared state", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "hello",
    });
    const resetTransport = vi.fn(() => {
      expect(state.getSnapshot().messages).toHaveLength(1);
    });
    const adapter = createQaStateBackedTransportAdapter(state, {
      id: "live",
      label: "Live",
      accountId: "sut",
      requiredPluginIds: [],
      prepareFlow: vi.fn(),
      supportedActions: [],
      resetTransport,
      sendInbound: async (input) => state.addInboundMessage(input),
      createGatewayConfig: () => ({}),
      waitReady: async () => undefined,
      buildAgentDelivery: ({ target }) => ({
        channel: "live",
        to: target,
        replyChannel: "live",
        replyTo: target,
      }),
      handleAction: async () => undefined,
      createReportNotes: () => [],
    });

    await adapter.reset();

    expect(resetTransport).toHaveBeenCalledOnce();
    expect(adapter.prepareFlow).toBeTypeOf("function");
    expect(state.getSnapshot().messages).toHaveLength(0);
  });
});

describe("waitForQaTransportOutboundSequence", () => {
  it("returns preview and final edit events for one threaded message", async () => {
    const state = createQaBusState();
    state.createThread({
      conversationId: "qa-room",
      createdBy: "alice",
      title: "QA thread",
    });
    const preview = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "preview",
      threadId: "42",
      to: "thread:qa-room/42",
    });
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "qa-room",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          threadId: "42",
          timeoutMs: 100,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { text: "final marker", threadId: "42" },
    });
  });

  it("does not accept a matching preview that is deleted during final settling", async () => {
    const state = createQaBusState();
    const preview = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "preview",
      to: "dm:alice",
    });
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });
    setTimeout(() => {
      state.deleteMessage({ accountId: "default", messageId: preview.id });
    }, 5);

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 20,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 50,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).rejects.toThrow("timed out after 50ms");
  });

  it("does not count an already-final send as a preview", async () => {
    const state = createQaBusState();
    const final = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "final marker",
      to: "dm:alice",
    });
    state.editMessage({
      accountId: "default",
      messageId: final.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 20,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).rejects.toThrow("timed out after 20ms");
  });

  it("ignores foreign-account and inbound edit events when proving a final reply", async () => {
    const state = createQaBusState();
    const expected = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "owned preview",
    });
    state.editMessage({
      accountId: "default",
      messageId: expected.id,
      text: "final marker",
    });

    const foreign = state.addOutboundMessage({
      accountId: "other",
      to: "dm:alice",
      text: "foreign preview",
    });
    state.editMessage({
      accountId: "other",
      messageId: foreign.id,
      text: "final marker",
    });

    const inbound = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "inbound original",
    });
    state.editMessage({
      accountId: "default",
      messageId: inbound.id,
      text: "inbound preview",
    });
    state.editMessage({
      accountId: "default",
      messageId: inbound.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 50,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { accountId: "default", direction: "outbound", id: expected.id },
    });
  });
});
