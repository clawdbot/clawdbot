import { describe, expect, it } from "vitest";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import { isCriticalToolLoopVeto } from "./agent-tools.before-tool-call.types.js";

describe("buildBlockedToolResult", () => {
  it("includes terminate: true for critical tool-loop vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason:
        "CRITICAL: Called exec with identical arguments and outcomes 10 times. Session blocked.",
      deniedReason: "tool-loop",
      toolCallId: "call-tl-1",
      runId: "run-1",
    });
    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "tool-loop",
    });
    // agent-core requires terminate: true on all finalized results to stop
    // the tool batch; without it the model retries the blocked tool.
    expect(result.terminate).toBe(true);
  });

  it("does not include terminate for plugin-before-tool-call vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Plugin before-tool-call denied",
      deniedReason: "plugin-before-tool-call",
      toolCallId: "call-pb-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-before-tool-call");
    expect(result.terminate).toBeUndefined();
  });

  it("does not include terminate for plugin-approval vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Plugin approval denied",
      deniedReason: "plugin-approval",
      toolCallId: "call-pa-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-approval");
    expect(result.terminate).toBeUndefined();
  });

  it("defaults deniedReason to plugin-before-tool-call when omitted", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Default deny",
      toolCallId: "call-def-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-before-tool-call");
    expect(result.terminate).toBeUndefined();
  });
});

describe("isCriticalToolLoopVeto", () => {
  // The helper guards `unknown` tool-result details at two call sites
  // (buildBlockedToolResult per-result terminate, and the session
  // shouldStopAfterTurn mixed-batch scan). Non-tool-loop vetoes and
  // malformed details must not be treated as critical.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "tool-loop"],
    ["number", 0],
    ["object without deniedReason", { status: "blocked" }],
    ["tool-loop reason without blocked status", { deniedReason: "tool-loop" }],
    ["tool-loop reason with non-blocked status", { status: "error", deniedReason: "tool-loop" }],
    ["plugin-approval veto", { deniedReason: "plugin-approval" }],
    ["plugin-before-tool-call veto", { deniedReason: "plugin-before-tool-call" }],
  ])("returns false for %s", (_label, details) => {
    expect(isCriticalToolLoopVeto(details)).toBe(false);
  });

  it("returns true and narrows to a tool-loop veto", () => {
    const details: unknown = { status: "blocked", deniedReason: "tool-loop" };
    expect(isCriticalToolLoopVeto(details)).toBe(true);
    // Type guard narrows `details` so callers can read deniedReason safely.
    if (isCriticalToolLoopVeto(details)) {
      expect(details.deniedReason).toBe("tool-loop");
    }
  });
});
