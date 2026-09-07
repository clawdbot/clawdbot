import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./mock-openai-contracts.js";
import {
  buildAssistantEvents,
  buildPartialFailureEvents,
  buildAssistantThenToolCallEvents,
  buildFailedResponseEvents,
  buildReasoningAndAssistantEvents,
  buildReasoningOnlyEvents,
} from "./mock-openai-events.js";

function readOutputItemSlots(events: StreamEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === "response.output_item.added" || event.type === "response.output_item.done",
    )
    .map((event) => {
      if (
        event.type !== "response.output_item.added" &&
        event.type !== "response.output_item.done"
      ) {
        throw new Error("expected a response output item event");
      }
      return {
        type: event.type,
        itemId: event.item.id,
        outputIndex: event.output_index,
      };
    });
}

describe("mock OpenAI Responses output item slots", () => {
  it("emits the provider no-details failure used by repeated-request recovery QA", () => {
    const events = buildFailedResponseEvents();
    expect(events).toEqual([
      expect.objectContaining({ type: "response.created" }),
      expect.objectContaining({
        type: "response.failed",
        response: expect.not.objectContaining({ error: expect.anything() }),
      }),
    ]);
    expect(events.some((event) => event.type === "response.output_text.delta")).toBe(false);
  });

  it("emits an unfinished assistant delta before the failed response", () => {
    const marker = "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE";
    const events = buildPartialFailureEvents(marker);

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.failed",
    ]);
    expect(events[1]).toMatchObject({
      item: { type: "message", role: "assistant", status: "in_progress" },
    });
    expect(events[3]).toMatchObject({
      type: "response.output_text.delta",
      delta: marker,
    });
    expect(events.some((event) => event.type === "response.output_item.done")).toBe(false);
  });

  it("indexes preview deltas and the final answer on the same assistant slot", () => {
    const events = buildAssistantEvents([
      {
        id: "streamed-answer",
        phase: "final_answer",
        streamDeltas: ["preview ", "in progress"],
        text: "FINAL-MARKER",
      },
    ]);

    expect(readOutputItemSlots(events)).toEqual([
      {
        type: "response.output_item.added",
        itemId: "streamed-answer",
        outputIndex: 0,
      },
      {
        type: "response.output_item.done",
        itemId: "streamed-answer",
        outputIndex: 0,
      },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "response.output_text.delta" || event.type === "response.output_text.done",
      ),
    ).toEqual([
      {
        type: "response.output_text.delta",
        item_id: "streamed-answer",
        output_index: 0,
        content_index: 0,
        delta: "preview ",
      },
      {
        type: "response.output_text.delta",
        item_id: "streamed-answer",
        output_index: 0,
        content_index: 0,
        delta: "in progress",
      },
      {
        type: "response.output_text.done",
        item_id: "streamed-answer",
        output_index: 0,
        content_index: 0,
        text: "FINAL-MARKER",
      },
    ]);
  });

  it("keeps each streamed assistant on its own indexed slot", () => {
    const events = buildAssistantEvents([
      {
        id: "first-answer",
        streamDeltas: ["first"],
        text: "first",
      },
      {
        id: "second-answer",
        streamDeltas: ["second"],
        text: "second",
      },
    ]);

    expect(readOutputItemSlots(events)).toEqual([
      {
        type: "response.output_item.added",
        itemId: "first-answer",
        outputIndex: 0,
      },
      {
        type: "response.output_item.done",
        itemId: "first-answer",
        outputIndex: 0,
      },
      {
        type: "response.output_item.added",
        itemId: "second-answer",
        outputIndex: 1,
      },
      {
        type: "response.output_item.done",
        itemId: "second-answer",
        outputIndex: 1,
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => {
          if (event.type !== "response.output_text.delta") {
            throw new Error("expected a response text delta");
          }
          return {
            itemId: event.item_id,
            outputIndex: event.output_index,
          };
        }),
    ).toEqual([
      { itemId: "first-answer", outputIndex: 0 },
      { itemId: "second-answer", outputIndex: 1 },
    ]);
  });

  it("assigns separate assistant and function-call slots", () => {
    const events = buildAssistantThenToolCallEvents(
      {
        id: "assistant-before-tool",
        phase: "commentary",
        streamDeltas: ["looking up"],
        text: "looking up",
      },
      "read",
      { path: "README.md" },
    );

    expect(readOutputItemSlots(events)).toEqual([
      {
        type: "response.output_item.added",
        itemId: "assistant-before-tool",
        outputIndex: 0,
      },
      {
        type: "response.output_item.done",
        itemId: "assistant-before-tool",
        outputIndex: 0,
      },
      {
        type: "response.output_item.added",
        itemId: expect.any(String),
        outputIndex: 1,
      },
      {
        type: "response.output_item.done",
        itemId: expect.any(String),
        outputIndex: 1,
      },
    ]);
    expect(events.find((event) => event.type === "response.function_call_arguments.delta")).toEqual(
      {
        type: "response.function_call_arguments.delta",
        item_id: expect.any(String),
        output_index: 1,
        delta: JSON.stringify({ path: "README.md" }),
      },
    );
    expect(
      events
        .filter(
          (event) =>
            event.type === "response.output_item.added" ||
            event.type === "response.output_item.done",
        )
        .map((event) => event.item)
        .filter((item) => item.type === "message"),
    ).toEqual([
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
    ]);
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed?.response.output[0]).toEqual(
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
    );
  });

  it("indexes reasoning before the streamed assistant answer", () => {
    const events = buildReasoningAndAssistantEvents({
      reasoningId: "reasoning-before-answer",
      answerId: "reasoned-answer",
      answerText: "reasoned final",
    });

    expect(readOutputItemSlots(events)).toEqual([
      {
        type: "response.output_item.added",
        itemId: "reasoning-before-answer",
        outputIndex: 0,
      },
      {
        type: "response.output_item.done",
        itemId: "reasoning-before-answer",
        outputIndex: 0,
      },
      {
        type: "response.output_item.added",
        itemId: "reasoned-answer",
        outputIndex: 1,
      },
      {
        type: "response.output_item.done",
        itemId: "reasoned-answer",
        outputIndex: 1,
      },
    ]);
  });

  it("indexes a reasoning-only output on its first slot", () => {
    expect(readOutputItemSlots(buildReasoningOnlyEvents("thinking", "reasoning-only"))).toEqual([
      {
        type: "response.output_item.added",
        itemId: "reasoning-only",
        outputIndex: 0,
      },
      {
        type: "response.output_item.done",
        itemId: "reasoning-only",
        outputIndex: 0,
      },
    ]);
  });
});
