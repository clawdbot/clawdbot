import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjectionRunEvent,
  type SessionProjectionScope,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

describe("session projection Gateway run events", () => {
  it.each([
    { name: "regular final", event: { state: "final" }, status: "completed" },
    {
      name: "yielded end turn",
      event: { state: "final", yielded: true, stopReason: "end_turn" },
      status: "yielded",
    },
    {
      name: "message-owned error",
      event: {
        state: "final",
        message: { role: "assistant", content: "failure", stopReason: "error" },
      },
      status: "error",
    },
    {
      name: "provider timeout",
      event: { state: "error", errorKind: "timeout" },
      status: "timeout",
    },
    { name: "aborted run", event: { state: "aborted" }, status: "aborted" },
    { name: "live delta", event: { state: "delta" }, status: "streaming" },
  ])("normalizes a $name identically for browser and TUI", ({ event, status }) => {
    const result = reduceSessionProjectionRunEvent(
      createSessionProjection(scope),
      { ...event, runId: "shared-run" },
      scope,
    );
    expect(result?.previousRun).toBeUndefined();
    expect(result?.currentRun?.status).toBe(status);
    expect(result?.projection.runs["shared-run"]?.status).toBe(status);
  });

  it("returns both canonical run projections for a duplicate Gateway terminal", () => {
    const final = {
      runId: "shared-run",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "delivered final" }],
        __openclaw: { id: "final-1", seq: 1 },
      },
    };
    const first = reduceSessionProjectionRunEvent(createSessionProjection(scope), final);
    expect(first).not.toBeNull();
    if (!first) {
      return;
    }
    const repeated = reduceSessionProjectionRunEvent(first.projection, final);
    expect(repeated?.previousRun).toBe(first.currentRun);
    expect(repeated?.projection).toBe(first.projection);
    expect(repeated?.currentRun).toBe(first.currentRun);
  });

  it.each(["status", "unknown", undefined])("rejects non-run Gateway event state %j", (state) => {
    expect(
      reduceSessionProjectionRunEvent(createSessionProjection(scope), {
        runId: "shared-run",
        state,
      }),
    ).toBeNull();
  });
});
