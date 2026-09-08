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
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 11, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 12, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 13, resumes: true },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: undefined, resumes: false },
    { terminalSeq: undefined, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
    { terminalSeq: 10, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: Infinity, resumes: false },
  ])("requires newer run-event order before resuming an error: %j", (scenario) => {
    let projection = createSessionProjection(scope);
    const message = { role: "assistant", content: [], stopReason: "error" };
    for (const event of [
      { state: "delta", seq: 8 },
      { state: "error", seq: scenario.terminalSeq, message },
      { state: "error", seq: scenario.repeatedSeq, message },
    ]) {
      const result = reduceSessionProjectionRunEvent(projection, {
        ...event,
        runId: "shared-run",
        errorMessage: "provider unavailable",
      });
      if (!result) {
        throw new Error("Expected a run projection");
      }
      projection = result.projection;
    }
    const delta = {
      runId: "shared-run",
      state: "delta",
      seq: scenario.deltaSeq,
      message: { role: "assistant", content: "resumed output" },
    };
    const resumed = reduceSessionProjectionRunEvent(projection, delta);
    expect(resumed?.currentRun?.status).toBe(scenario.resumes ? "streaming" : "error");
    if (!scenario.resumes) {
      expect(resumed?.projection).toBe(projection);
      expect(resumed?.currentRun?.message).toBe(message);
      expect(resumed?.currentRun?.errorMessage).toBe("provider unavailable");
    }
  });

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
