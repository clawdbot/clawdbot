import { describe, expect, it } from "vitest";
import { normalizeGatewayEvent } from "./normalize.js";

// Terminal tool/item events are emitted with phase:"end" plus the real status
// (running|completed|failed|blocked), so failed/blocked must not collapse to completed.
function agentItemEvent(data: Record<string, unknown>) {
  return { event: "agent", payload: { runId: "r1", stream: "item", data } };
}

describe("normalizeGatewayEvent IDs", () => {
  it.each([
    { field: "sequence", seq: 0, ts: 123, expectedId: "0:agent:r1:main:123" },
    { field: "timestamp", seq: 1, ts: 0, expectedId: "1:agent:r1:main:0" },
  ])("preserves zero $field values", ({ seq, ts, expectedId }) => {
    const event = normalizeGatewayEvent({
      event: "agent",
      seq,
      payload: {
        runId: "r1",
        sessionKey: "main",
        ts,
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });

    expect(event.id).toBe(expectedId);
    expect(event.ts).toBe(ts);
  });
});

describe("normalizeGatewayEvent terminal tool item status", () => {
  it("classifies a failed terminal tool item as tool.call.failed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "failed" })).type).toBe(
      "tool.call.failed",
    );
  });

  it("classifies a blocked terminal tool item as tool.call.failed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "blocked" })).type).toBe(
      "tool.call.failed",
    );
  });

  it("still classifies a completed terminal tool item as tool.call.completed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "completed" })).type).toBe(
      "tool.call.completed",
    );
  });

  it("still classifies a phase:end tool item without status as tool.call.completed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end" })).type).toBe(
      "tool.call.completed",
    );
  });
});
