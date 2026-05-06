import { describe, expect, it, vi } from "vitest";
import {
  createLiveMessageState,
  defineFinalizableLivePreviewAdapter,
  deliverFinalizableLivePreview,
  deliverWithFinalizableLivePreviewAdapter,
  markLiveMessageCancelled,
  markLiveMessageFinalized,
  markLiveMessagePreviewUpdated,
} from "./live.js";
import { createMessageReceiveContext, shouldAckMessageAfterStage } from "./receive.js";
import { classifyDurableSendRecoveryState, createDurableMessageStateRecord } from "./state.js";

describe("message lifecycle primitives", () => {
  it("tracks live preview finalization state", () => {
    const receipt = {
      primaryPlatformMessageId: "m1",
      platformMessageIds: ["m1"],
      parts: [],
      sentAt: 123,
    };

    const preview = createLiveMessageState({ receipt });
    expect(preview).toEqual(
      expect.objectContaining({
        phase: "previewing",
        canFinalizeInPlace: true,
      }),
    );

    expect(markLiveMessageFinalized(preview, receipt)).toEqual(
      expect.objectContaining({
        phase: "finalized",
        canFinalizeInPlace: false,
      }),
    );
    expect(markLiveMessageCancelled(preview)).toEqual(
      expect.objectContaining({
        phase: "cancelled",
        canFinalizeInPlace: false,
      }),
    );
  });

  it("tracks live preview rendered batch updates", () => {
    const preview = createLiveMessageState();
    const rendered = {
      payloads: [{ text: "draft" }],
      plan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"] as const, text: "draft", mediaUrls: [] }],
      },
    };

    expect(markLiveMessagePreviewUpdated(preview, rendered)).toEqual(
      expect.objectContaining({
        phase: "previewing",
        lastRendered: rendered,
      }),
    );
  });

  it("finalizes live previews in place with preview receipts", async () => {
    const editFinal = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => undefined);
    const onPreviewFinalized = vi.fn(async () => undefined);

    const result = await deliverFinalizableLivePreview({
      kind: "final",
      payload: { text: "done" },
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "preview-1",
        seal: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      buildFinalEdit: (payload) => ({ text: payload.text }),
      editFinal,
      deliverNormally,
      onPreviewFinalized,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-1", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(result.liveState).toEqual(
      expect.objectContaining({
        phase: "finalized",
        canFinalizeInPlace: false,
        receipt: expect.objectContaining({
          primaryPlatformMessageId: "preview-1",
          platformMessageIds: ["preview-1"],
        }),
      }),
    );
    expect(onPreviewFinalized).toHaveBeenCalledWith(
      "preview-1",
      expect.objectContaining({ primaryPlatformMessageId: "preview-1" }),
      result.liveState,
    );
  });

  it("treats live preview fallback delivery as terminal state", async () => {
    const discardPending = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => true);

    const result = await deliverFinalizableLivePreview({
      kind: "final",
      payload: { text: "with media" },
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "preview-2",
        discardPending,
        clear,
      },
      buildFinalEdit: () => undefined,
      editFinal: vi.fn(async () => undefined),
      deliverNormally,
    });

    expect(result.kind).toBe("normal-delivered");
    expect(discardPending).toHaveBeenCalledTimes(1);
    expect(deliverNormally).toHaveBeenCalledWith({ text: "with media" });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.liveState).toEqual(
      expect.objectContaining({
        phase: "cancelled",
        canFinalizeInPlace: false,
      }),
    );
  });

  it("delivers through finalizable live preview adapters", async () => {
    const editFinal = vi.fn(async () => undefined);
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "preview-adapter-1",
        clear: vi.fn(async () => undefined),
      },
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text.toUpperCase() }),
      editFinal,
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally: vi.fn(async () => undefined),
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-adapter-1", { text: "DONE" });
  });

  it("lets live preview adapters resolve the committed platform id after final edit", async () => {
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "preview-before-edit",
        clear: vi.fn(async () => undefined),
      },
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text }),
      editFinal: vi.fn(async () => undefined),
      resolveFinalizedId: () => "message-after-edit",
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally: vi.fn(async () => undefined),
    });

    expect(result.liveState?.receipt?.primaryPlatformMessageId).toBe("message-after-edit");
  });

  it("falls back to normal delivery when no live preview adapter is available", async () => {
    const deliverNormally = vi.fn(async () => undefined);

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "plain" },
      deliverNormally,
    });

    expect(result.kind).toBe("normal-delivered");
    expect(deliverNormally).toHaveBeenCalledWith({ text: "plain" });
  });

  it("lets live preview adapters retain ambiguous failed final edits without fallback send", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const handlePreviewEditError = vi.fn(() => "retain" as const);
    const editError = new Error("timeout after request");
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "preview-maybe-final",
        clear: vi.fn(async () => undefined),
      },
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text }),
      editFinal: vi.fn(async () => {
        throw editError;
      }),
      handlePreviewEditError,
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally,
    });

    expect(result.kind).toBe("preview-retained");
    expect(result.liveState?.phase).toBe("previewing");
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(handlePreviewEditError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: editError,
        id: "preview-maybe-final",
        edit: { text: "done" },
        payload: { text: "done" },
      }),
    );
  });

  it("does not fallback-send after a successful preview edit when finalization hooks fail", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const onPreviewFinalized = vi.fn(async () => {
      throw new Error("receipt side effect failed");
    });
    const editFinal = vi.fn(async () => undefined);

    await expect(
      deliverFinalizableLivePreview({
        kind: "final",
        payload: { text: "done" },
        draft: {
          flush: vi.fn(async () => undefined),
          id: () => "preview-finalized-before-hook",
          seal: vi.fn(async () => undefined),
          clear: vi.fn(async () => undefined),
        },
        buildFinalEdit: (payload) => ({ text: payload.text }),
        editFinal,
        deliverNormally,
        onPreviewFinalized,
      }),
    ).rejects.toThrow("receipt side effect failed");

    expect(editFinal).toHaveBeenCalledWith("preview-finalized-before-hook", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
  });

  it("creates receive contexts with explicit ack policy defaults", () => {
    const ctx = createMessageReceiveContext({
      id: "rx-1",
      channel: "telegram",
      message: { text: "hello" },
      receivedAt: 123,
    });

    expect(ctx).toEqual(
      expect.objectContaining({
        id: "rx-1",
        channel: "telegram",
        message: { text: "hello" },
        ackPolicy: "after_receive_record",
        ackState: "pending",
        receivedAt: 123,
      }),
    );
  });

  it("acks and nacks receive contexts through explicit hooks", async () => {
    const onAck = vi.fn(async () => undefined);
    const onNack = vi.fn(async () => undefined);
    const ctx = createMessageReceiveContext({
      id: "rx-ack",
      channel: "telegram",
      message: { text: "hello" },
      ackPolicy: "after_durable_send",
      onAck,
      onNack,
    });

    expect(ctx.shouldAckAfter("receive_record")).toBe(false);
    expect(ctx.shouldAckAfter("durable_send")).toBe(true);

    await ctx.ack();
    await ctx.ack();
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(ctx.ackState).toBe("acked");
    expect(ctx.ackedAt).toEqual(expect.any(Number));

    await ctx.nack(new Error("offset failed"));
    expect(onNack).toHaveBeenCalledWith(expect.any(Error));
    expect(ctx.ackState).toBe("nacked");
    expect(ctx.nackErrorMessage).toBe("offset failed");
  });

  it("maps ack policies to lifecycle stages", () => {
    expect(shouldAckMessageAfterStage("after_receive_record", "receive_record")).toBe(true);
    expect(shouldAckMessageAfterStage("after_receive_record", "agent_dispatch")).toBe(false);
    expect(shouldAckMessageAfterStage("after_agent_dispatch", "agent_dispatch")).toBe(true);
    expect(shouldAckMessageAfterStage("after_durable_send", "durable_send")).toBe(true);
    expect(shouldAckMessageAfterStage("manual", "manual")).toBe(false);
  });

  it("classifies unknown-after-send recovery only after platform send may have started", () => {
    expect(
      classifyDurableSendRecoveryState({
        hasIntent: true,
        hasReceipt: false,
        platformSendMayHaveStarted: true,
      }),
    ).toBe("unknown_after_send");
    expect(
      classifyDurableSendRecoveryState({
        hasIntent: true,
        hasReceipt: false,
        platformSendMayHaveStarted: false,
      }),
    ).toBe("pending");
  });

  it("creates durable message state records with normalized errors", () => {
    expect(
      createDurableMessageStateRecord({
        intent: {
          id: "intent-1",
          channel: "telegram",
          to: "12345",
          durability: "required",
        },
        state: "failed",
        error: new Error("network"),
        updatedAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        errorMessage: "network",
        updatedAt: 123,
      }),
    );
  });
});
