import { afterEach, describe, expect, it } from "vitest";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
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
    expect(afterB.lastToolRecovery).toEqual({ toolName: "message" });
    expect(
      observe({ toolName: "heartbeat_respond", arguments: {}, outcome: "success" }).lastToolError,
    ).toMatchObject({ error: "A failed" });
    expect(
      observe({ toolName: "message", arguments: actionA, outcome: "success" }).lastToolError,
    ).toBeUndefined();
  });

  it("surfaces the successful cross-tool recovery without leaking failure details", () => {
    const observe = createToolTerminalObserver("run-edit-recovery");

    observe({
      toolName: "edit",
      arguments: { path: "/tmp/demo.txt", oldText: "missing", newText: "after" },
      outcome: "failure",
      failure: { error: "Could not find TOP_SECRET text in /tmp/demo.txt" },
    });
    const recovered = observe({
      toolName: "write",
      arguments: { path: "/tmp/demo.txt", content: "after" },
      outcome: "success",
    });
    const afterRead = observe({
      toolName: "read",
      arguments: { path: "/tmp/demo.txt" },
      outcome: "success",
    });
    const payloads = buildPayloads({ lastToolRecovery: afterRead.lastToolRecovery });

    expect(recovered.lastToolError).toBeUndefined();
    expect(recovered.lastToolRecovery).toEqual({ toolName: "write" });
    expect(afterRead.lastToolRecovery).toEqual({ toolName: "write" });
    expect(payloads.map((payload) => payload.text)).toEqual(["✅ ✍️ Write succeeded after retry."]);
    expect(JSON.stringify(payloads)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(payloads)).not.toContain("/tmp/demo.txt");
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

  it("preserves durable memory recall side-effect evidence", () => {
    const observe = createToolTerminalObserver("run-memory");

    expect(
      observe({
        toolName: "memory_search",
        arguments: { query: "recall" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: true });
    expect(
      observe({
        toolName: "memory_get",
        arguments: { path: "memory/notes.md" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: false });
  });

  it("keeps a failed persistence claim visible, appends a correction, and hides owner metadata", () => {
    const observation = {
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "429 insufficient_quota" },
      ownerMutation: {
        ownerKey: '["memory-lancedb","memory_store"]',
      },
    } as const;
    const terminal = createToolTerminalObserver("run-memory-store")(observation);

    const payloads = buildPayloads({
      assistantTexts: ["I've saved that preference and will remember it."],
      lastToolError: terminal.lastToolError,
    });

    expect(payloads).toEqual([
      expect.objectContaining({ text: "I've saved that preference and will remember it." }),
      expect.objectContaining({ isError: true }),
    ]);
    expect(JSON.stringify(payloads)).not.toContain("memory-lancedb");
  });

  it("does not treat an unowned same-name tool as a persistence mutation", () => {
    const terminal = createToolTerminalObserver("run-third-party-store")({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "store unavailable" },
    });

    expect(terminal.lastToolError).toMatchObject({ mutatingAction: false });
  });

  it("clears a failed persistence action only after the same fact succeeds", () => {
    const observe = createToolTerminalObserver("run-memory-store-retry");
    const ownerKey = '["memory-lancedb","memory_store"]';
    const ownerMutation = { ownerKey };

    observe({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      outcome: "failure",
      failure: { error: "store unavailable" },
      ownerMutation,
    });
    expect(
      observe({
        toolName: "memory_store",
        arguments: { text: "The user prefers imperial units." },
        outcome: "success",
        ownerMutation,
      }).lastToolError,
    ).toMatchObject({
      actionFingerprint: expect.stringContaining(`owner=${ownerKey}|args=`),
    });
    expect(
      observe({
        toolName: "memory_store",
        arguments: { text: "The user prefers metric units." },
        outcome: "success",
        ownerMutation,
      }).lastToolError,
    ).toBeUndefined();
  });
});
