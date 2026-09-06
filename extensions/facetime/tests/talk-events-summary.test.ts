import { describe, expect, it } from "vitest";
import { summarizeRecentTalkEvents } from "../src/talk-events-summary.js";

describe("talk event summaries", () => {
  it("returns compact status-safe summaries for recent talk events", () => {
    const events = [
      { type: "session.started", payload: { callUUID: "call-1" } },
      { type: "input.audio.delta", turnId: "turn-1", payload: { byteLength: 2400 } },
      { type: "transcript.done", turnId: "turn-1", payload: { role: "user", text: "hello" } },
      { type: "tool.call", turnId: "turn-1", callId: "tool-1", payload: { name: "lookup" } },
      {
        type: "session.error",
        final: true,
        payload: { message: "provider failed", detail: "not included" },
      },
    ];

    expect(summarizeRecentTalkEvents(events, 4)).toEqual([
      { type: "input.audio.delta", turnId: "turn-1", byteLength: 2400 },
      { type: "transcript.done", turnId: "turn-1", text: "hello" },
      { type: "tool.call", turnId: "turn-1", callId: "tool-1", name: "lookup" },
      { type: "session.error", final: true, message: "provider failed" },
    ]);
  });

  it("handles malformed events defensively", () => {
    expect(summarizeRecentTalkEvents([null, "bad", { payload: "bad" }])).toEqual([
      { type: "unknown" },
      { type: "unknown" },
      { type: "unknown" },
    ]);
  });
});
