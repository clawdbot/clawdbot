import { describe, expect, it, vi } from "vitest";
import {
  createMessageUpdateContext,
  firstMockArg,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageUpdate commentary phase", () => {
  it("suppresses commentary-phase partial delivery and text_end flush", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    updateMessage(
      ctx,
      createTextUpdateEvent({ type: "text_delta", text: "Need send.", messagePhase: "commentary" }),
    );
    updateMessage(
      ctx,
      createTextUpdateEvent({ type: "text_end", text: "Need send.", messagePhase: "commentary" }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
  });

  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = createOpenAiResponsesTextBlock({
      text: "Need send.",
      id: "msg_sig",
      phase: "commentary",
    });
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );
    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );

    await Promise.resolve();

    // Archive-always: commentary (textSignature-only phase — the F3 shape) is
    // emitted on the bus for archival + window, but kept out of the reply lanes.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");
  });

  it("keeps commentary partials out of reply lanes while emitting them on the bus", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      shouldEmitPartialReplies: false,
    });

    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Working...",
        partial: createOpenAiResponsesPartial({
          text: "Working...",
          id: "item_commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        }),
      }),
    );

    // Emit-always: the bus sees the commentary delta with its phase tag. The raw
    // cumulative buffer retains it for end-event dedupe, but reply blocks stay untouched.
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const commentaryEvent = firstMockArg(onAgentEvent, "agent event") as
      | { stream?: string; data?: { delta?: string; phase?: string } }
      | undefined;
    expect(commentaryEvent?.stream).toBe("assistant");
    expect(commentaryEvent?.data?.phase).toBe("commentary");
    expect(commentaryEvent?.data).toMatchObject({
      text: "Working...",
      delta: "",
      replace: true,
      phase: "commentary",
      itemId: "item_commentary",
    });
    expect(ctx.state.deltaBuffer).toBe("Working...");
    expect(ctx.state.blockBuffer).toBe("");

    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Done.",
        partial: createOpenAiResponsesPartial({
          text: "Done.",
          id: "item_final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(2);
    const event = onAgentEvent.mock.calls[1]?.[0] as
      | { stream?: string; data?: { text?: string; delta?: string } }
      | undefined;
    expect(event?.stream).toBe("assistant");
    expect(event?.data?.text).toBe("Done.");
    expect(event?.data?.delta).toBe("Done.");
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = createMessageUpdateContext({
      debug,
      shouldEmitPartialReplies: false,
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    updateMessage(ctx, createTextUpdateEvent({ type: "text_end", text: "" }));

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });
});
