import { describe, expect, it, vi } from "vitest";
import { resolveCurrentSourceMessagingToolPartial } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent as createTextUpdateEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageUpdate current-source message-tool previews", () => {
  it("holds delta-only continuation fragments and releases one full divergent snapshot", () => {
    const state = {
      currentSourceMessagingToolHeldPartial: undefined as string | undefined,
      currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
    };

    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "QA-MSTEAMS",
        visibleDelta: "QA-MSTEAMS",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "-DM-OK",
        visibleDelta: "-DM-OK",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS-DM-OK" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: " with more detail",
        visibleDelta: " with more detail",
      }),
    ).toEqual({ hold: false, text: "QA-MSTEAMS-DM-OK with more detail" });
    expect(state.currentSourceMessagingToolHeldPartial).toBeUndefined();
  });

  it("holds automatic partial prefixes and exact duplicates after source delivery", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const sentText = "QA-MSTEAMS-DM-OK";
    const context = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: [sentText.toLowerCase()],
      },
    });

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "QA-MSTEAMS",
        id: "msg_source_duplicate",
      }),
    );
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: sentText,
        id: "msg_source_duplicate",
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("releases the full cumulative snapshot when automatic text diverges", async () => {
    const onPartialReply = vi.fn();
    const sentText = "QA-MSTEAMS-DM-OK";
    const context = createMessageUpdateContext({
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: [sentText.toLowerCase()],
      },
    });

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "QA-MSTEAMS",
        id: "msg_source_diverges",
      }),
    );
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: `${sentText} with more detail`,
        id: "msg_source_diverges",
      }),
    );

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${sentText} with more detail` }),
    );
  });

  it("keeps unrelated automatic partial text visible", async () => {
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
      },
    });

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: "A genuinely different answer",
        id: "msg_source_different",
      }),
    );

    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "A genuinely different answer" }),
    );
  });
});
