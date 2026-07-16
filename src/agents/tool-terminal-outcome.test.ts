import { afterEach, describe, expect, it } from "vitest";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

describe("tool terminal outcome observer", () => {
  afterEach(() => resetAdjustedParamsByToolCallIdForTests());

  it("keeps distinct mutation failures until their matching actions recover", () => {
    const observe = createToolTerminalObserver("run-1");
    const actionA = { action: "send", to: "channel:a", message: "A" };
    const actionB = { action: "send", to: "channel:b", message: "B" };

    observe({
      toolName: "message",
      arguments: actionA,
      outcome: "failure",
      failure: { error: "A failed" },
    });
    observe({
      toolName: "message",
      arguments: actionB,
      outcome: "failure",
      failure: { error: "B failed" },
    });
    const afterB = observe({ toolName: "message", arguments: actionB, outcome: "success" });

    expect(afterB.lastToolError).toMatchObject({
      error: "A failed",
      actionFingerprint: expect.stringContaining("to=channel:a"),
    });
    expect(
      observe({ toolName: "heartbeat_respond", arguments: {}, outcome: "success" }).lastToolError,
    ).toMatchObject({ error: "A failed" });
    expect(
      observe({ toolName: "message", arguments: actionA, outcome: "success" }).lastToolError,
    ).toBeUndefined();
  });

  it("uses host execution and adjusted-argument evidence before fallback facts", () => {
    const runId = "run-2";
    const toolCallId = "call-1";
    recordToolExecutionTracked(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked before execution" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: false,
      lastToolError: { mutatingAction: false },
    });
    expect(adjustedParamsByToolCallId.get(buildAdjustedParamsKey({ runId, toolCallId }))).toEqual({
      action: "send",
      to: "channel:adjusted",
    });
  });

  it("resolves active wrapper truth when a racing runtime omits conservative facts", () => {
    const runId = "run-racing-timeout";
    const toolCallId = "call-racing-timeout";
    recordToolExecutionStarted(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      outcome: "failure",
      failure: { error: "timed out during execution" },
    });

    expect(resolution).toMatchObject({
      executionStarted: true,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: true,
      lastToolError: { mutatingAction: true },
    });
  });

  it("uses settled pre-execution evidence after active tracking is released", () => {
    const runId = "run-3";
    const toolCallId = "call-blocked";
    preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:blocked" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      sideEffectEvidence: false,
      lastToolError: { mutatingAction: false },
    });
  });
});
