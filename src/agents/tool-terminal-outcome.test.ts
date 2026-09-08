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
import { inferToolMetaFromArgsCore } from "./tool-display.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

describe("tool terminal outcome observer", () => {
  afterEach(() => resetAdjustedParamsByToolCallIdForTests());

  it("keeps the latest failure when a different tool succeeds", () => {
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
    const afterRead = observe({ toolName: "read", arguments: {}, outcome: "success" });

    expect(afterRead.lastToolError).toMatchObject({ error: "B failed" });
    const payloads = buildPayloads({ lastToolError: afterRead.lastToolError });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ isError: true });
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
      failure: { error: "timed out during execution", executionStarted: false },
    });

    expect(resolution).toMatchObject({
      executionStarted: true,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: true,
      lastToolError: { executionStarted: true, mutatingAction: true },
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
      lastToolError: { executionStarted: false, mutatingAction: false },
    });
  });

  it.each([
    {
      name: "pre-execution rejection",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        executionStarted: false,
        outcome: "failure",
        failure: { error: "blocked" },
      },
      state: "uncertain",
    },
    {
      name: "completed read",
      input: { toolName: "message", arguments: { action: "read" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed read",
      input: {
        toolName: "message",
        arguments: { action: "read" },
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed computer observation",
      input: { toolName: "computer", arguments: { action: "list_windows" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed computer observation",
      input: {
        toolName: "computer",
        arguments: { action: "get_cursor_position" },
        outcome: "failure",
        failure: { error: "observation unavailable" },
      },
      state: "failed_no_effect",
    },
    {
      name: "owner-declared replay-safe failure",
      input: {
        toolName: "plugin_read",
        arguments: {},
        replaySafe: true,
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed mutation",
      input: { toolName: "message", arguments: { action: "send" }, outcome: "success" },
      state: "mutation_committed",
    },
    {
      name: "completed unknown operation",
      input: { toolName: "plugin_unknown", arguments: {}, outcome: "success" },
      state: "uncertain",
    },
    {
      name: "failed mutation",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        outcome: "failure",
        failure: { error: "send failed" },
      },
      state: "uncertain",
    },
  ] as const)("records a host-owned effect receipt for $name", ({ input, state }) => {
    expect(createToolTerminalObserver("run-effect-receipt")(input).effectReceipt).toEqual({
      state,
    });
  });

  it("clears a failed sessions_spawn once a retry with adjusted arguments succeeds", () => {
    const observe = createToolTerminalObserver("run-spawn-retry");
    const failedArgs = {
      task: "Investigate the flaky gateway test",
      label: "Investigate",
      cwd: "/outside/workspace",
    };
    // The retry the model actually issues: drops the rejected cwd and rewords the task.
    const retryArgs = { task: "Investigate the flaky gateway test in repo scope" };

    observe({
      toolName: "sessions_spawn",
      arguments: failedArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      outcome: "failure",
      failure: { error: "cwd is outside the workspace" },
    });
    const afterRetry = observe({
      toolName: "sessions_spawn",
      arguments: retryArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", retryArgs),
      outcome: "success",
    });

    expect(afterRetry.lastToolError).toBeUndefined();

    const payloads = buildPayloads({ lastToolError: afterRetry.lastToolError });
    expect(payloads).toEqual([]);
  });

  it("keeps the sessions_spawn failure warning when no later spawn succeeds", () => {
    const observe = createToolTerminalObserver("run-spawn-failed");
    const failedArgs = { task: "Investigate the flaky gateway test", label: "Investigate" };

    const terminal = observe({
      toolName: "sessions_spawn",
      arguments: failedArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      outcome: "failure",
      failure: { error: "cwd is outside the workspace" },
    });

    const payloads = buildPayloads({
      assistantTexts: ["Started Investigate in a new session."],
      lastToolError: terminal.lastToolError,
    });
    expect(payloads.map((payload) => payload.text)).toEqual([
      "Started Investigate in a new session.",
    ]);
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

  it("treats the assistant reply as authoritative after a failed persistence call", () => {
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

  it("clears a failed persistence action after the same tool succeeds", () => {
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
    ).toBeUndefined();
  });
});
