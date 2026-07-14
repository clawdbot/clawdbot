import fs from "node:fs/promises";
/**
 * Integration-style tests for before_tool_call behavior.
 * Covers loop detection, diagnostics, plugin approval, and skill telemetry
 * around wrapped tool execution.
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
} from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  getBeforeToolCallFailureDisposition,
  getBeforeToolCallPolicyDiagnosticState,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { CRITICAL_THRESHOLD } from "./tool-loop-detection.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

function setGlobalHookRunnerForTest(hookRunner: HookRunner | null): void {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
    hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
      hookRunner: null,
      registry: null,
    };
  }
  hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
}

function getGlobalHookRunnerForTest(): HookRunner | null {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  return hookRunnerGlobalState[hookRunnerGlobalStateKey]?.hookRunner ?? null;
}

type TestHookRunner = HookRunner & {
  hasHooks: ReturnType<typeof vi.fn<HookRunner["hasHooks"]>>;
  runBeforeToolCall: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;
};

function createTestHookRunner(): TestHookRunner {
  return {
    ...createHookRunner(createEmptyPluginRegistry()),
    hasHooks: vi.fn<HookRunner["hasHooks"]>(),
    runBeforeToolCall: vi.fn<HookRunner["runBeforeToolCall"]>(),
  };
}

function asAgentTool(tool: { name: string; execute: ReturnType<typeof vi.fn> }): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

afterEach(() => {
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  mockGetGlobalHookRunner.mockImplementation(() => getGlobalHookRunnerForTest());
});

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: TestHookRunner;
  const enabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: true },
  };

  const disabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: false },
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  function createWrappedTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    loopDetectionContext = enabledLoopDetectionContext,
  ) {
    return wrapToolWithBeforeToolCallHook(
      { name, execute } as unknown as AnyAgentTool,
      loopDetectionContext,
    );
  }

  async function withToolLoopEvents(
    run: (emitted: DiagnosticToolLoopEvent[]) => Promise<void>,
    filter: (evt: DiagnosticToolLoopEvent) => boolean = () => true,
  ) {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && filter(evt)) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  async function withToolExecutionEvents(
    run: (emitted: DiagnosticEventPayload[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      if (evt.type.startsWith("tool.execution.")) {
        emitted.push(evt);
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  async function withDiagnosticEvents(
    run: (emitted: DiagnosticEventPayload[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      emitted.push(evt);
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  async function withSkillUsageDiagnosticEvents(
    run: (
      emitted: DiagnosticEventPayload[],
      privateData: DiagnosticEventPrivateData[],
      flush: () => Promise<void>,
    ) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const skillUsagePrivateData: DiagnosticEventPrivateData[] = [];
    const stopShared = onInternalDiagnosticEvent((event) => emitted.push(event));
    const stopTrusted = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "skill.used") {
        skillUsagePrivateData.push(privateData);
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, skillUsagePrivateData, flush);
    } finally {
      stopTrusted();
      stopShared();
    }
  }

  function createPingPongTools(options?: { withProgress?: boolean }) {
    const readExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `read ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "read ok" }],
          details: { ok: true },
        });
    const listExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `list ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "list ok" }],
          details: { ok: true },
        });
    return {
      readTool: createWrappedTool("read", readExecute),
      listTool: createWrappedTool("list", listExecute),
    };
  }

  async function runPingPongSequence(
    readTool: ReturnType<typeof createWrappedTool>,
    listTool: ReturnType<typeof createWrappedTool>,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
      } else {
        await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
      }
    }
  }

  function createGenericReadRepeatFixture() {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    return {
      tool: createWrappedTool("read", execute),
      params: { path: "/tmp/file" },
    };
  }

  function createNoProgressProcessFixture(sessionId: string) {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    return {
      tool: createWrappedTool("process", execute),
      params: { action: "poll", sessionId },
    };
  }

  function expectCriticalLoopEvent(
    loopEvent: DiagnosticToolLoopEvent | undefined,
    params: {
      detector: "ping_pong" | "known_poll_no_progress";
      toolName: string;
      count?: number;
    },
  ) {
    expect(loopEvent?.type).toBe("tool.loop");
    expect(loopEvent?.level).toBe("critical");
    expect(loopEvent?.action).toBe("block");
    expect(loopEvent?.detector).toBe(params.detector);
    expect(loopEvent?.count).toBe(params.count ?? CRITICAL_THRESHOLD);
    expect(loopEvent?.toolName).toBe(params.toolName);
  }

  function expectToolLoopBlockedResult(result: unknown, expectedReason: string) {
    const record = requireRecord(result, "tool result");
    const content = requireArray(record.content, "tool result content");
    const textContent = requireRecord(content[0], "tool result content item");
    expect(textContent.type).toBe("text");
    expect(String(textContent.text)).toContain(expectedReason);
    const details = requireRecord(record.details, "tool result details");
    expect(details.status).toBe("blocked");
    expect(details.deniedReason).toBe("tool-loop");
    expect(String(details.reason)).toContain(expectedReason);
  }

  async function expectUnblockedToolExecution(
    tool: ReturnType<typeof createWrappedTool>,
    toolCallId: string,
    params: unknown,
  ) {
    const result = await tool.execute(toolCallId, params, undefined, undefined);
    const record = requireRecord(result, "tool result");
    requireArray(record.content, "tool result content");
    requireRecord(record.details, "tool result details");
    return result;
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireArray(value: unknown, label: string): unknown[] {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
      throw new Error(`${label} was not an array`);
    }
    return value;
  }

  function expectEventFields(
    event: DiagnosticEventPayload | DiagnosticToolLoopEvent | undefined,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(event, "diagnostic event");
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
    return record;
  }

  it("blocks known poll loops when no progress repeats", async () => {
    const { tool, params } = createNoProgressProcessFixture("sess-1");

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }

    await withDiagnosticEvents(async (emitted, flush) => {
      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      await flush();
      expectToolLoopBlockedResult(result, "CRITICAL");
      const securityEvent = emitted.find(
        (event): event is Extract<DiagnosticEventPayload, { type: "security.event" }> =>
          event.type === "security.event",
      );
      expect(securityEvent).toMatchObject({
        type: "security.event",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        reason: "tool-loop",
        policy: {
          id: "tool-loop-detection",
          decision: "deny",
          reason: "tool-loop",
        },
        control: {
          id: "tool-loop-detection",
          family: "authorization",
        },
        attributes: {
          params_kind: "object",
          tool_source: "core",
        },
      });
    });
  });

  it("does nothing when loopDetection.enabled is false", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "process", execute }), {
      ...disabledLoopDetectionContext,
    });
    const params = { action: "poll", sessionId: "sess-off" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }
  });

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => {
      return {
        content: [{ type: "text", text: `output ${toolCallId}` }],
        details: { status: "running", aggregated: `output ${toolCallId}` },
      };
    });
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-progress-${i}`, params);
    }
  });

  it("keeps generic repeated calls unblocked below critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }
  });

  it("blocks generic repeated no-progress calls at critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }

    const result = await tool.execute(`read-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
    expectToolLoopBlockedResult(result, "identical outcomes");
  });

  it("does not carry loop history across run ids", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    const params = { path: "/tmp/file" };
    const firstRunTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-1",
    });
    const secondRunTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-2",
    });

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(firstRunTool, `old-run-${i}`, params);
    }

    await expectUnblockedToolExecution(secondRunTool, "new-run-0", params);
  });

  it("escalates generic repeat diagnostics from warning to critical", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createGenericReadRepeatFixture();

      for (let i = 0; i < 21; i += 1) {
        await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
      }

      const genericEvents = emitted.filter((evt) => evt.detector === "generic_repeat");
      expect(genericEvents.map((evt) => [evt.level, evt.count])).toEqual([
        ["warning", 10],
        ["critical", 20],
      ]);
    });
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, 9);

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      const result = await listTool.execute(
        `list-${CRITICAL_THRESHOLD - 1}`,
        { dir: "/workspace" },
        undefined,
        undefined,
      );
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "ping_pong",
        toolName: "list",
      });
    });
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools({ withProgress: true });
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expectUnblockedToolExecution(listTool, `list-${CRITICAL_THRESHOLD - 1}`, {
        dir: "/workspace",
      });

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expectEventFields(warningPingPong, {
        type: "tool.loop",
        level: "warning",
        action: "warn",
        detector: "ping_pong",
      });
    });
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createNoProgressProcessFixture("sess-crit");

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "known_poll_no_progress",
        toolName: "process",
      });
    });
  });

  it("emits diagnostic tool execution events without parameter values", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      trace,
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute(
        "tool-call-1",
        { command: "pwd", token: "sk-1234567890abcdef1234567890abcdef" },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        toolName: "exec",
        toolCallId: "tool-call-1",
        paramsSummary: {
          kind: "object",
        },
      });
      const startedTrace = requireRecord(started.trace, "started trace");
      expect(startedTrace.traceId).toBe(trace.traceId);
      expect(startedTrace.parentSpanId).toBe(trace.spanId);
      expect(typeof startedTrace.spanId).toBe("string");
      expect(startedTrace.traceFlags).toBe(trace.traceFlags);
      expect(emitted[0]?.trace).not.toBe(trace);
      expect(Object.isFrozen(emitted[0]?.trace)).toBe(true);
      const completed = expectEventFields(emitted[1], {
        type: "tool.execution.completed",
      });
      expect(typeof completed.durationMs).toBe("number");
      expect(JSON.stringify(emitted)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(JSON.stringify(emitted)).not.toContain("pwd");
    });
  });

  it.each([
    { label: "fails", error: new Error("hook crashed"), terminalReason: "failed" },
    {
      label: "times out",
      error: Object.assign(new Error("timed out after 5ms"), { name: "TimeoutError" }),
      terminalReason: "timed_out",
    },
  ] as const)(
    "emits a terminal diagnostic when a before_tool_call hook $label",
    async (testCase) => {
      hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
      hookRunner.runBeforeToolCall.mockRejectedValueOnce(testCase.error);
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "session-key",
          sessionId: "session-id",
          runId: "run-1",
          loopDetection: { enabled: false },
        },
      );

      await withToolExecutionEvents(async (emitted, flush) => {
        await expect(
          tool.execute("tool-call-hook-failure", { command: "private" }, undefined, undefined),
        ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
        await flush();

        expect(execute).not.toHaveBeenCalled();
        expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
        const terminal = expectEventFields(emitted[0], {
          type: "tool.execution.error",
          runId: "run-1",
          sessionKey: "session-key",
          sessionId: "session-id",
          agentId: "main",
          toolName: "exec",
          toolCallId: "tool-call-hook-failure",
          paramsSummary: { kind: "object" },
          errorCategory: "before_tool_call",
          terminalReason: testCase.terminalReason,
        });
        expect(typeof terminal.durationMs).toBe("number");
        expect(JSON.stringify(emitted)).not.toContain("private");
      });
    },
  );

  it("emits a terminal diagnostic when hook preflight rejects", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const params = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        throw new Error("private hook preflight failure");
      },
    });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "read", execute } as unknown as AnyAgentTool,
      {
        agentId: "main",
        sessionKey: "session-key",
        runId: "run-1",
      },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-preflight", params, undefined, undefined),
      ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.error",
        runId: "run-1",
        sessionKey: "session-key",
        agentId: "main",
        toolName: "read",
        toolCallId: "tool-call-preflight",
        paramsSummary: { kind: "object" },
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      });
      expect(JSON.stringify(emitted)).not.toContain("private hook preflight failure");
    });
  });

  it("preserves preparation timeout disposition when wrapper diagnostics are delegated", async () => {
    const timeout = Object.assign(new Error("private preparation timeout"), {
      name: "TimeoutError",
    });
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        execute: vi.fn(),
        prepareBeforeToolCallParams: vi.fn().mockRejectedValue(timeout),
      } as unknown as AnyAgentTool,
      { runId: "run-1" },
      { emitDiagnostics: false },
    );

    const error = await tool
      .execute("tool-call-preparation-timeout", { command: "private" }, undefined, undefined)
      .catch((cause: unknown) => cause);

    expect(getBeforeToolCallFailureDisposition(error)).toBe("timed_out");
    expect(error).toHaveProperty("cause", timeout);
  });

  it("emits a blocked terminal diagnostic when tool approval is denied", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Approve tool" },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: "deny" });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-denied", { command: "private" }, undefined, undefined),
      ).rejects.toThrow("Denied by user");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        runId: "run-1",
        sessionKey: "session-key",
        toolName: "exec",
        toolCallId: "tool-call-denied",
        deniedReason: "plugin-approval",
        reason: "plugin-approval",
      });
      expect(JSON.stringify(emitted)).not.toContain("private");
    });
    mockCallGateway.mockReset();
  });

  it("emits a blocked terminal diagnostic when approval is report-only", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Review before running" },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
      { approvalMode: "report" },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-report", { command: "private" }, undefined, undefined),
      ).rejects.toThrow("Review before running");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(mockCallGateway).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        runId: "run-1",
        sessionKey: "session-key",
        toolName: "exec",
        toolCallId: "tool-call-report",
        deniedReason: "plugin-approval",
        reason: "plugin-approval",
      });
      expect(JSON.stringify(emitted)).not.toContain("private");
      expect(JSON.stringify(emitted)).not.toContain("Review before running");
    });
    mockCallGateway.mockReset();
  });

  it.each([
    {
      label: "failure",
      details: { status: "failed", exitCode: 1 },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "failed",
      },
    },
    {
      label: "timeout",
      details: { status: "timeout", timedOut: true },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "timed_out",
      },
    },
    {
      label: "cancellation",
      details: { status: "cancelled" },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "cancelled",
      },
    },
    {
      label: "blocked action",
      details: { status: "blocked" },
      terminal: {
        type: "tool.execution.blocked",
        deniedReason: "tool_result_blocked",
        reason: "tool_result_blocked",
      },
    },
  ])("classifies a resolved $label result as terminal failure", async ({ details, terminal }) => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool failed" }],
      details,
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-1", { command: "false" }, undefined, undefined);
      await flush();

      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.started", terminal.type]);
      expectEventFields(emitted[1], terminal);
    });
  });

  it("classifies plugin and MCP tool execution diagnostics with bounded owner labels", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const rawTool = { name: "mcp_search", execute } as unknown as AnyAgentTool;
    setPluginToolMeta(rawTool, { pluginId: "bundle-mcp", optional: false });
    const tool = wrapToolWithBeforeToolCallHook(rawTool, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-mcp", { query: "status" }, undefined, undefined);
      await flush();

      expectEventFields(emitted[0], {
        type: "tool.execution.started",
        toolName: "mcp_search",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
      expectEventFields(emitted[1], {
        type: "tool.execution.completed",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
    });
  });

  it("emits skill usage diagnostics when a run reads a known skill instruction file", async () => {
    const workspaceDir = path.join("/tmp", "openclaw-skill-usage");
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "demo-skill",
            description: "Demo",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-skill-read",
        { path: `${path.join(".agents", "skills", "demo-skill", "SKILL.md")}</arg_value>>` },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "skill.used",
        "tool.execution.completed",
      ]);
      expectEventFields(emitted[1], {
        type: "skill.used",
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        skillName: "demo-skill",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
        toolCallId: "tool-call-skill-read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain("SKILL.md");
      expect(JSON.stringify(emitted)).not.toContain(skillBaseDir);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
    });
  });

  it("matches home-compacted skill instruction paths from prompts", async () => {
    const skillBaseDir = path.join(os.homedir(), ".openclaw", "skills", "home-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir: "/tmp/openclaw-workspace",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "home-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "home-skill",
            description: "Home skill",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "openclaw-managed",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-home-skill",
        { path: "~/.openclaw/skills/home-skill/SKILL.md" },
        undefined,
        undefined,
      );
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "home-skill",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain(os.homedir());
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
    });
  });

  it("emits skill usage diagnostics for node skill locators", async () => {
    const locator = "node://node-1/skills/remote-skill/SKILL.md";
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "remote-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "remote-skill",
            description: "Remote skill",
            filePath: locator,
            baseDir: "node://node-1/skills/remote-skill",
            source: "openclaw-node",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, _privateData, flush) => {
      await tool.execute("tool-call-node-skill", { path: locator }, undefined, undefined);
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "remote-skill",
        activation: "read",
        toolName: "read",
      });
    });
  });

  it("accounts sandbox skill reads against the original canonical file", async () => {
    const workspaceDir = "/workspace";
    const readPath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";
    const skillFile = "/agent-workspace/skills/demo/SKILL.md";
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir,
      skillUsagePaths: [
        {
          readPath,
          skillFile,
          skillName: "demo",
          skillSource: "workspace",
        },
      ],
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-sandbox-skill",
        { path: ".openclaw/sandbox-skills/skills/demo/SKILL.md" },
        undefined,
        undefined,
      );
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "demo",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFile);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFile);
    });
  });

  it("does not count unused read params as skill usage", async () => {
    const workspaceDir = path.join("/tmp", "openclaw-skill-unused-param");
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "readme" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "demo-skill",
            description: "Demo",
            filePath: path.join(skillBaseDir, "SKILL.md"),
            baseDir: skillBaseDir,
            source: "workspace",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withDiagnosticEvents(async (emitted, flush) => {
      await tool.execute(
        "tool-call-unused-skill-param",
        {
          path: "README.md",
          file: path.join(".agents", "skills", "demo-skill", "SKILL.md"),
        },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
    });
  });

  it("emits skill usage diagnostics for command-dispatched skill tools", async () => {
    const skillBaseDir = path.join("/tmp", "openclaw-skill-command", "skills", "matrix-profile");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "message", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      skillCommand: {
        commandName: "set_profile",
        skillFile: skillFilePath,
        skillName: "matrix-profile",
        skillSource: "workspace",
        toolName: "message",
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-skill-command",
        { command: "display name", commandName: "set_profile", skillName: "matrix-profile" },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "skill.used",
        "tool.execution.completed",
      ]);
      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "matrix-profile",
        skillSource: "workspace",
        activation: "command",
        toolName: "message",
        toolCallId: "tool-call-skill-command",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain("display name");
    });
  });

  it("emits diagnostic tool execution error events with redacted errors", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("failed with key sk-1234567890abcdef1234567890abcdef"));
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("failed with key");
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      const errorEvent = expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-error",
        errorCategory: "Error",
      });
      expect(typeof errorEvent.durationMs).toBe("number");
      expect(JSON.stringify(emitted[1])).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });
  });

  it("classifies a tool error as cancelled only when the run signal is aborted", async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(() => {
      abortController.abort();
      throw new Error("tool stopped with run");
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute(
          "tool-call-cancelled",
          { path: "/tmp/file" },
          abortController.signal,
          undefined,
        ),
      ).rejects.toThrow("tool stopped with run");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-cancelled",
        errorCategory: "aborted",
        terminalReason: "cancelled",
      });
    });
  });

  it("classifies a tool error as timed out when the run timeout signal is aborted", async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(() => {
      abortController.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      throw new Error("tool stopped with timeout");
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-timeout", { path: "/tmp/file" }, abortController.signal, undefined),
      ).rejects.toThrow("tool stopped with timeout");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-timeout",
        terminalReason: "timed_out",
      });
    });
  });

  it("classifies a tool-local timeout without an aborted run signal", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("tool deadline elapsed"), { name: "TimeoutError" }),
      );
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });
    const runSignal = new AbortController().signal;

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-local-timeout", { path: "/tmp/file" }, runSignal, undefined),
      ).rejects.toThrow("tool deadline elapsed");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-local-timeout",
        terminalReason: "timed_out",
      });
    });
  });

  it("emits blocked diagnostics without error severity for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      const result = await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await flush();

      expect(result).toEqual({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((evt) => evt.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        toolName: "read",
        toolCallId: "tool-call-blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      });
    });
  });

  it("emits a security event for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withDiagnosticEvents(async (emitted, flush) => {
      await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await flush();

      const securityEvent = emitted.find(
        (event): event is Extract<DiagnosticEventPayload, { type: "security.event" }> =>
          event.type === "security.event",
      );
      expect(securityEvent).toMatchObject({
        type: "security.event",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        severity: "medium",
        reason: "plugin-before-tool-call",
        actor: { kind: "agent" },
        target: {
          kind: "tool",
          name: "read",
        },
        policy: {
          id: "plugin-before-tool-call",
          decision: "deny",
          reason: "plugin-before-tool-call",
        },
        control: {
          id: "before-tool-call",
          family: "approval",
        },
        attributes: {
          params_kind: "object",
          tool_source: "core",
        },
      });
      expect(securityEvent?.eventId).toBeTypeOf("string");
      expect(JSON.stringify(securityEvent)).not.toContain("/tmp/file");
      expect(emitted.some((event) => event.type === "tool.execution.blocked")).toBe(true);
    });
  });

  it("does not let hostile thrown values break diagnostic error emission", async () => {
    const hostileError = new Proxy(
      {},
      {
        get() {
          throw new Error("diagnostic getter should not run");
        },
        getOwnPropertyDescriptor() {
          throw new Error("diagnostic descriptor failed");
        },
      },
    );
    const execute = vi.fn().mockRejectedValue(hostileError);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-hostile-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toBe(hostileError);
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-hostile-error",
        errorCategory: "object",
      });
      expect(emitted[1]).not.toHaveProperty("errorCode");
    });
  });

  it("emits only numeric HTTP status codes as diagnostic tool error codes", async () => {
    const error = Object.assign(new Error("rate limited"), {
      code: "SECRET_TOKEN",
      status: 429,
    });
    const execute = vi.fn().mockRejectedValue(error);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-status-code", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("rate limited");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        errorCode: "429",
      });
      expect(JSON.stringify(emitted[1])).not.toContain("SECRET_TOKEN");
    });
  });

  it("summarizes hostile object params without enumerating keys", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });
    const params = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("should not enumerate params");
        },
      },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-proxy", params, undefined, undefined);
      await flush();

      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
      });
      expect(started.paramsSummary).toEqual({ kind: "object" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe(params);
    });
  });
});

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: TestHookRunner;
  const mockCallGateway = vi.mocked(callGatewayTool);

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireHookCall(
    index: number,
  ): [event: Record<string, unknown>, context: Record<string, unknown>] {
    const call = hookRunner.runBeforeToolCall.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing before_tool_call hook call ${index + 1}`);
    }
    return [
      requireRecord(call[0], "before_tool_call event"),
      requireRecord(call[1], "before_tool_call context"),
    ];
  }

  function requireGatewayCall(index: number): unknown[] {
    const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing gateway call ${index + 1}`);
    }
    return call;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function registerTelegramPluginApprovalSetup(): void {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            approvalCapability: {
              native: {},
              getActionAvailabilityState: () => ({ kind: "enabled" as const }),
              getExecInitiatingSurfaceState: () => ({ kind: "disabled" as const }),
              describePluginApprovalSetup: () => "Configure Telegram native approval setup.",
            },
          },
        },
      ]),
    );
  }

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    // Keep the global singleton aligned as a fallback in case another setup path
    // preloads hook-runner-global before this test's module reset/mocks take effect.
    setGlobalHookRunnerForTest(hookRunner);
    mockCallGateway.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runAbortDuringApprovalWait(options?: {
    abortReason?: unknown;
    onResolution?: (decision: PluginApprovalResolution) => void | Promise<void>;
  }) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Abortable",
        description: "Will be aborted",
        onResolution: options?.onResolution,
      },
    });

    const controller = new AbortController();
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-abort", status: "accepted" });
    mockCallGateway.mockImplementationOnce(() => new Promise(() => {}));
    setTimeout(() => controller.abort(options?.abortReason ?? new Error("run cancelled")), 10);

    return await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });
  }

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        title: "Should not reach gateway",
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("blocks when before_tool_call hook execution throws", async () => {
    hookRunner.runBeforeToolCall.mockRejectedValueOnce(new Error("hook crashed"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "failed");
    expect(result).toHaveProperty(
      "reason",
      "Tool call blocked because before_tool_call hook failed",
    );
  });

  it("classifies a loop preflight exception as a before-tool failure", async () => {
    const ctx = {
      sessionKey: "main",
      get loopDetection(): never {
        throw new Error("loop state unavailable");
      },
    };

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
      ctx,
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "failed",
      reason: "Tool call blocked because before_tool_call hook failed",
    });
  });

  it("passes diagnostic trace context to before_tool_call hooks", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "pwd" },
      toolCallId: "tool-1",
      ctx: { agentId: "main", sessionKey: "main", runId: "run-1", trace },
    });

    expect(result.blocked).toBe(false);
    const [event, toolContext] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expectRecordFields(toolContext, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(toolContext.trace).toEqual(trace);
    expect(toolContext.trace).not.toBe(trace);
    expect(Object.isFrozen(toolContext.trace)).toBe(true);
  });

  it("passes host-derived apply_patch paths to before_tool_call hooks", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-1",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
      derivedPaths: [
        path.join(cwd, "src/new.ts"),
        path.join(cwd, "src/old.ts"),
        path.join(cwd, "src/renamed.ts"),
        path.join(cwd, "src/dead.ts"),
      ],
    });
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
    });
  });

  it("derives sandboxed apply_patch paths through the sandbox bridge", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: filePath,
              hostPath: "/host/sandbox/src/new.ts",
              relativePath: "src/new.ts",
            }),
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/host/sandbox/src/new.ts"],
    });
  });

  it("does not fail hooks when sandbox path derivation rejects a target", async () => {
    const patch = ["*** Begin Patch", "*** Add File: /outside.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox-rejected",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: () => {
              throw new Error("Path escapes sandbox root");
            },
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expect(event).not.toHaveProperty("derivedPaths");
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-sandbox-rejected",
    });
  });

  it("skips derived path extraction when no policies or hooks can consume it", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const params = {};
    Object.defineProperty(params, "input", {
      enumerable: true,
      get() {
        throw new Error("should not derive paths");
      },
    });

    await expect(
      runBeforeToolCallHook({
        toolName: "apply_patch",
        params,
        toolCallId: "patch-no-hooks",
      }),
    ).resolves.toEqual({ blocked: false, params });
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("reports trusted policy diagnostics through guarded readers", () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const registry = createEmptyPluginRegistry();
    const unreadableIdPolicy: Record<string, unknown> = {
      description: "synthetic trusted policy",
      evaluate: () => undefined,
    };
    Object.defineProperty(unreadableIdPolicy, "id", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trusted policy id is unreadable");
      },
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        source: "test",
        policy: unreadableIdPolicy as never,
      },
      {
        pluginId: "mockplugin",
        pluginName: "Mock Plugin",
        source: "test",
        policy: {
          id: "mockpolicy",
          description: "mock policy",
          evaluate: () => undefined,
        },
      },
    ];
    setActivePluginRegistry(registry);

    let state: ReturnType<typeof getBeforeToolCallPolicyDiagnosticState> | undefined;
    try {
      state = getBeforeToolCallPolicyDiagnosticState();
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }

    expect(state).toEqual({
      hasBeforeToolCallHook: false,
      trustedToolPolicies: [
        {
          id: "fuzzplugin",
          pluginId: "fuzzplugin",
          pluginName: "Fuzz Plugin",
        },
        {
          id: "mockpolicy",
          pluginId: "mockplugin",
          pluginName: "Mock Plugin",
        },
      ],
    });
  });

  it("recomputes host-derived paths after trusted policy param rewrites", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const originalPatch = [
      "*** Begin Patch",
      "*** Add File: src/old.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const rewrittenPatch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const seenByLaterPolicy: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-rewriter",
        pluginName: "Trusted Rewriter",
        source: "test",
        policy: {
          id: "rewrite",
          description: "rewrite",
          evaluate: () => ({ params: { input: rewrittenPatch } }),
        },
      },
      {
        pluginId: "trusted-inspector",
        pluginName: "Trusted Inspector",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenByLaterPolicy.push(event.derivedPaths);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: originalPatch },
      toolCallId: "patch-rewrite",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result).toEqual({ blocked: false, params: { input: rewrittenPatch } });
    expect(seenByLaterPolicy).toEqual([[path.join(cwd, "src/new.ts")]]);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      params: { input: rewrittenPatch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
  });

  it("calls gateway RPC and unblocks on allow-once", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Sensitive",
        description: "Sensitive op",
        pluginId: "sage",
      },
    });

    // First call: plugin.approval.request → returns server-generated id
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", status: "accepted" });
    // Second call: plugin.approval.waitDecision → returns allow-once
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    requireRecord(requestCall[1], "approval request gateway client");
    expect(requireRecord(requestCall[2], "approval request params").twoPhase).toBe(true);
    expect(requestCall[3]).toEqual({ expectFinal: false });
    const waitCall = requireGatewayCall(1);
    expect(waitCall[0]).toBe("plugin.approval.waitDecision");
    requireRecord(waitCall[1], "approval wait gateway client");
    expect(waitCall[2]).toEqual({ id: "server-id-1" });
  });

  it("caps oversized plugin approval timeouts before calling gateway", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Oversized timeout",
        description: "Still valid gateway payload",
        pluginId: "sage",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-oversized", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-oversized", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    const requestCall = requireGatewayCall(0);
    expect(requireRecord(requestCall[1], "approval request gateway client").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
    );
    expect(requireRecord(requestCall[2], "approval request params").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
    );
    const waitCall = requireGatewayCall(1);
    expect(requireRecord(waitCall[1], "approval wait gateway client").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
    );
  });

  it("blocks on deny decision", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Dangerous",
        description: "Dangerous op",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", decision: "deny" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "blocked");
    expect(result).toHaveProperty("reason", "Denied by user");
  });

  it("keeps the generic plugin approval timeout reason unchanged", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout test",
        description: "Will time out",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-timeout", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-timeout", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      reason: "Approval timed out",
    });
  });

  it("blocks turn-source plugin approval timeouts with setup guidance", async () => {
    registerTelegramPluginApprovalSetup();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout test",
        description: "Will time out",
      },
    });

    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-3",
      status: "accepted",
      deliveryRoute: "turn-source",
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-3", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123456789",
        turnSourceAccountId: "default",
      },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "timed_out");
    expect(result).toHaveProperty(
      "reason",
      "Approval timed out\n\nConfigure Telegram native approval setup.",
    );
  });

  it.each([
    ["a timeout", null],
    ["an explicit timeout decision", PluginApprovalResolutions.TIMEOUT],
    ["an unknown decision", "approved"],
    ["a malformed truthy decision", true as unknown as string],
  ])("blocks on %s even when deprecated timeoutBehavior is allow", async (_label, decision) => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Lenient timeout",
        description: "Must fail closed",
        timeoutBehavior: "allow",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", decision });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf /" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: { command: "rm -rf /" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });

  it("blocks exact allow decisions excluded by the request", async () => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Restricted approval",
        description: "Allow once only",
        allowedDecisions: ["allow-once", "deny"],
        onResolution,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-restricted", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-restricted",
      decision: "allow-always",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "unsafe-command" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      disposition: "timed_out",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });

  it("blocks a wait decision bound to another approval id", async () => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Bound approval",
        description: "Must match the request id",
        onResolution,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-bound", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-other",
      decision: "allow-once",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "unsafe-command" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      disposition: "timed_out",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });

  it("falls back to block on gateway error", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway down",
        description: "Gateway is unavailable",
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("unknown method plugin.approval.request"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
  });

  it.each([
    [
      "surfaces validation rejections",
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message:
          "invalid plugin.approval.request params: at /title: must not have more than 80 characters",
      }),
      "Plugin approval request rejected: invalid plugin.approval.request params: at /title: must not have more than 80 characters",
    ],
    [
      "keeps structured service failures on the unavailable fallback",
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "approval service unavailable",
      }),
      "Plugin approval required (gateway unavailable)",
    ],
  ])("%s", async (_label, error, expectedReason) => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "x".repeat(81),
        description: "Gateway classification test",
      },
    });
    mockCallGateway.mockRejectedValueOnce(error);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", expectedReason);
  });

  it("reports an expired accepted approval without calling it a request rejection", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: { title: "Approval", description: "Wait phase classification" },
    });
    mockCallGateway
      .mockResolvedValueOnce({ id: "plugin:accepted", status: "accepted" })
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "approval expired or not found",
        }),
      );

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toHaveProperty(
      "reason",
      "Plugin approval no longer available: approval expired or not found",
    );
  });

  it("blocks when gateway returns no id", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Registration returns no id");
  });

  it("blocks on immediate null decision without calling waitDecision even when timeoutBehavior is allow", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No route",
        description: "No approval route available",
        timeoutBehavior: "allow",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-immediate", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval unavailable (no approval route)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("unblocks immediately when abort signal fires during waitDecision", async () => {
    const result = await runAbortDuringApprovalWait();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
  });

  it("classifies non-Error abort reasons as run abort cancellation", async () => {
    const result = await runAbortDuringApprovalWait({ abortReason: "sessions_yield" });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
  });

  it("removes abort listener after waitDecision resolves", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Cleanup listener",
        description: "Wait resolves quickly",
      },
    });

    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-cleanup", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-cleanup", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });

    expect(result.blocked).toBe(false);
    expect(removeListenerSpy.mock.calls.map(([type]) => type)).toContain("abort");
  });

  it("calls onResolution with allow-once on approval", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("allow-once");
  });

  it("allows allow-always decisions for tool approvals", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs durable approval",
        description: "Check this durable approval",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-allow-always", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-allow-always",
      decision: "allow-always",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "echo ok" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "echo ok" },
      approvalResolution: "allow-always",
    });
    expect(onResolution).toHaveBeenCalledWith("allow-always");
  });

  it("does not await onResolution before returning approval outcome", async () => {
    const onResolution = vi.fn(() => new Promise<void>(() => {}));

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Non-blocking callback",
        description: "Should not block tool execution",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1-nonblocking", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-r1-nonblocking",
      decision: "allow-once",
    });

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        runBeforeToolCallHook({
          toolName: "bash",
          params: {},
          ctx: { agentId: "main", sessionKey: "main" },
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runBeforeToolCallHook waited for onResolution")),
            250,
          );
        }),
      ]);

      expect(result).toEqual({
        blocked: false,
        params: {},
        approvalResolution: "allow-once",
      });
      expect(onResolution).toHaveBeenCalledWith("allow-once");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  it("calls onResolution with deny on denial", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", decision: "deny" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it("calls onResolution with timeout when decision is null", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout resolution",
        description: "Will time out",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", decision: null });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("timeout");
  });

  it("calls onResolution with cancelled on gateway error", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway error",
        description: "Gateway will fail",
        onResolution,
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("gateway down"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when abort signal fires", async () => {
    const onResolution = vi.fn();
    const result = await runAbortDuringApprovalWait({ onResolution });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when gateway returns no id", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("forwards turn source routing fields from ctx to plugin.approval.request", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Channel-routed approval",
        description: "Must route to telegram",
        pluginId: "my-plugin",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "route-id-1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "route-id-1", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "fetch",
      params: { url: "https://example.com" },
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123456789",
        turnSourceAccountId: "acct-42",
        turnSourceThreadId: 9001,
      },
    });

    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBe("telegram");
    expect(requestParams.turnSourceTo).toBe("-100123456789");
    expect(requestParams.turnSourceAccountId).toBe("acct-42");
    expect(requestParams.turnSourceThreadId).toBe(9001);
  });

  it("uses the transport channel when tool policy provider differs", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Transport routed approval",
        description: "Must use the transport channel",
        pluginId: "my-plugin",
      },
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-route-"));
    await fs.writeFile(path.join(tempDir, "note.txt"), "hello");
    mockCallGateway.mockResolvedValueOnce({ id: "transport-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "transport-route-id",
      decision: "allow-once",
    });

    const tools = createOpenClawCodingTools({
      workspaceDir: tempDir,
      messageProvider: "discord-voice",
      messageChannel: "discord",
      currentChannelId: "native-channel-1",
      currentMessagingTarget: "channel:deliverable-1",
      agentAccountId: "acct-1",
      currentThreadTs: "thread-1",
      approvalReviewerDeviceId: "device-tui-reviewer",
    });
    const readTool = tools.find((tool) => tool.name === "read");
    if (!readTool) {
      throw new Error("missing read tool");
    }
    await readTool.execute("tool-hook-route", { path: "note.txt" }, undefined, undefined);

    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBe("discord");
    expect(requestParams.turnSourceTo).toBe("channel:deliverable-1");
    expect(requestParams.turnSourceAccountId).toBe("acct-1");
    expect(requestParams.turnSourceThreadId).toBe("thread-1");
    expect(requestParams.approvalReviewerDeviceIds).toEqual(["device-tui-reviewer"]);
  });

  it("omits turn source routing fields when ctx does not carry them", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No route ctx",
        description: "Local-only approval",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "no-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "no-route-id", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    const requestCall = requireGatewayCall(0);
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBeUndefined();
    expect(requestParams.turnSourceTo).toBeUndefined();
    expect(requestParams.turnSourceAccountId).toBeUndefined();
    expect(requestParams.turnSourceThreadId).toBeUndefined();
  });
});

describe("before_tool_call tool content private-data capture", () => {
  type TrustedToolEvent = {
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  async function withTrustedToolEvents(
    run: (emitted: TrustedToolEvent[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: TrustedToolEvent[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("tool.execution.")) {
        emitted.push({ event, privateData });
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  function configWithToolContent(
    fields: { toolInputs?: boolean; toolOutputs?: boolean } = {
      toolInputs: true,
      toolOutputs: true,
    },
  ) {
    return {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          traces: true,
          captureContent: { enabled: true, ...fields },
        },
      },
    } as unknown as import("../config/types.openclaw.js").OpenClawConfig;
  }

  it("attaches tool input/output to private data when opted in", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file body" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(completed?.privateData.toolContent?.toolOutput).toEqual({
        content: [{ type: "text", text: "file body" }],
      });
      // Public event payload must never carry raw params/results.
      expect(JSON.stringify(completed?.event)).not.toContain("/etc/secret");
      expect(JSON.stringify(completed?.event)).not.toContain("file body");
    });
  });

  it("omits tool content from private data when capture is not configured", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed).toBeDefined();
      expect(completed?.privateData.toolContent).toBeUndefined();
    });
  });

  it("captures only opted-in fields and clones away from live params", async () => {
    const liveParams = { path: "/etc/secret" };
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "out" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent({ toolInputs: true, toolOutputs: false }),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", liveParams, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(completed?.privateData.toolContent?.toolOutput).toBeUndefined();
      // Captured snapshot is a clone, not the live params object.
      expect(completed?.privateData.toolContent?.toolInput).not.toBe(liveParams);
    });
  });

  it("attaches tool input but not output on execution errors", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await expect(
        tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined),
      ).rejects.toThrow("boom");
      await flush();

      const errored = emitted.find((e) => e.event.type === "tool.execution.error");
      expect(errored?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(errored?.privateData.toolContent?.toolOutput).toBeUndefined();
    });
  });
});
