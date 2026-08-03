import { describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  createSessionActivityNoteState,
  flushSessionActivityAssistantNote,
  noteSessionActivityEvent,
} from "./session-activity-notes.js";

function assistantEvent(ts: number, text: string, delta: string): AgentEventPayload {
  return {
    runId: "run-1",
    seq: ts,
    stream: "assistant",
    ts,
    data: { text, delta },
  };
}

describe("session activity assistant buffering", () => {
  it("defers cumulative rescans inside the throttle and flushes the exact latest text", () => {
    const state = createSessionActivityNoteState();
    noteSessionActivityEvent(state, assistantEvent(1_000, "first", "first"));
    noteSessionActivityEvent(state, assistantEvent(1_050, "first second", " second"));

    expect(state.assistantBuffer).toBe("first");
    expect(state.assistantBufferDirty).toBe(true);

    flushSessionActivityAssistantNote(state);

    expect(state.assistantBuffer).toBe("first second");
    expect(state.notes.at(-1)?.text).toBe("Assistant: first second");
  });

  it("preserves split internal-context filtering when the forced flush follows a burst", () => {
    const state = createSessionActivityNoteState();
    noteSessionActivityEvent(
      state,
      assistantEvent(1_000, "visible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n", "visible"),
    );
    noteSessionActivityEvent(
      state,
      assistantEvent(
        1_050,
        "visible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nafter",
        "secret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nafter",
      ),
    );

    flushSessionActivityAssistantNote(state);

    expect(state.notes.at(-1)?.text).toBe("Assistant: visible after");
  });

  it("keeps delta-only producers on the bounded incremental path", () => {
    const state = createSessionActivityNoteState();
    noteSessionActivityEvent(state, assistantEvent(1_000, "", "a".repeat(5_000)));
    noteSessionActivityEvent(state, assistantEvent(1_001, "", "tail"));

    expect(state.assistantBuffer).toHaveLength(4_096);
    expect(state.assistantBuffer.endsWith("tail")).toBe(true);
    expect(state.assistantBufferDirty).toBe(false);
  });

  it("does not report a signal-only aborted lifecycle end as done", () => {
    const state = createSessionActivityNoteState();
    noteSessionActivityEvent(state, {
      runId: "run-aborted",
      seq: 1,
      stream: "lifecycle",
      ts: 1_000,
      data: { phase: "end", aborted: true },
    });

    expect(state.notes.at(-1)?.text).toBe("Run failed");
  });
});
