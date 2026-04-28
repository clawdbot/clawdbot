import { describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  CRITICAL_THRESHOLD,
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  TOOL_CALL_HISTORY_SIZE,
  UNKNOWN_TOOL_THRESHOLD,
  WARNING_THRESHOLD,
  detectToolCallLoop,
  getToolCallStats,
  hashToolCall,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

const enabledLoopDetectionConfig: ToolLoopDetectionConfig = { enabled: true };

const shortHistoryLoopConfig: ToolLoopDetectionConfig = {
  enabled: true,
  historySize: 4,
};

function recordSuccessfulCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  result: unknown,
  index: number,
): void {
  const toolCallId = `${toolName}-${index}`;
  recordToolCall(state, toolName, params, toolCallId);
  recordToolCallOutcome(state, {
    toolName,
    toolParams: params,
    toolCallId,
    result,
  });
}

function recordFailedCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  error: unknown,
  index: number,
): void {
  const toolCallId = `${toolName}-error-${index}`;
  recordToolCall(state, toolName, params, toolCallId);
  recordToolCallOutcome(state, {
    toolName,
    toolParams: params,
    toolCallId,
    error,
  });
}

function recordRepeatedSuccessfulCalls(params: {
  state: SessionState;
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  startIndex?: number;
}) {
  const startIndex = params.startIndex ?? 0;
  for (let i = 0; i < params.count; i += 1) {
    recordSuccessfulCall(
      params.state,
      params.toolName,
      params.toolParams,
      params.result,
      startIndex + i,
    );
  }
}

function createNoProgressPollFixture(sessionId: string) {
  return {
    params: { action: "poll", sessionId },
    result: {
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    },
  };
}

function createReadNoProgressFixture() {
  return {
    toolName: "read",
    params: { path: "/same.txt" },
    result: {
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    },
  } as const;
}

function createPingPongFixture() {
  return {
    state: createState(),
    readParams: { path: "/a.txt" },
    listParams: { dir: "/workspace" },
  };
}

function detectLoopAfterRepeatedCalls(params: {
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  config?: ToolLoopDetectionConfig;
}) {
  const state = createState();
  recordRepeatedSuccessfulCalls({
    state,
    toolName: params.toolName,
    toolParams: params.toolParams,
    result: params.result,
    count: params.count,
  });
  return detectToolCallLoop(
    state,
    params.toolName,
    params.toolParams,
    params.config ?? enabledLoopDetectionConfig,
  );
}

function recordSuccessfulPingPongCalls(params: {
  state: SessionState;
  readParams: { path: string };
  listParams: { dir: string };
  count: number;
  textAtIndex: (toolName: "read" | "list", index: number) => string;
}) {
  for (let i = 0; i < params.count; i += 1) {
    if (i % 2 === 0) {
      recordSuccessfulCall(
        params.state,
        "read",
        params.readParams,
        { content: [{ type: "text", text: params.textAtIndex("read", i) }], details: { ok: true } },
        i,
      );
    } else {
      recordSuccessfulCall(
        params.state,
        "list",
        params.listParams,
        { content: [{ type: "text", text: params.textAtIndex("list", i) }], details: { ok: true } },
        i,
      );
    }
  }
}

function expectPingPongLoop(
  loopResult: ReturnType<typeof detectToolCallLoop>,
  expected: { level: "warning" | "critical"; count: number; expectCriticalText?: boolean },
) {
  expect(loopResult.stuck).toBe(true);
  if (!loopResult.stuck) {
    return;
  }
  expect(loopResult.level).toBe(expected.level);
  expect(loopResult.detector).toBe("ping_pong");
  expect(loopResult.count).toBe(expected.count);
  if (expected.expectCriticalText) {
    expect(loopResult.message).toContain("CRITICAL");
  }
}

describe("tool-loop-detection", () => {
  describe("hashToolCall", () => {
    it("creates consistent hash for same tool and params", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("read", { path: "/file.txt" });
      expect(hash1).toBe(hash2);
    });

    it("creates different hashes for different params", () => {
      const hash1 = hashToolCall("read", { path: "/file1.txt" });
      const hash2 = hashToolCall("read", { path: "/file2.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("creates different hashes for different tools", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("write", { path: "/file.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("handles non-object params", () => {
      expect(() => hashToolCall("tool", "string-param")).not.toThrow();
      expect(() => hashToolCall("tool", 123)).not.toThrow();
      expect(() => hashToolCall("tool", null)).not.toThrow();
    });

    it("produces deterministic hashes regardless of key order", () => {
      const hash1 = hashToolCall("tool", { a: 1, b: 2 });
      const hash2 = hashToolCall("tool", { b: 2, a: 1 });
      expect(hash1).toBe(hash2);
    });

    it("keeps hashes fixed-size even for large params", () => {
      const payload = { data: "x".repeat(20_000) };
      const hash = hashToolCall("read", payload);
      expect(hash.startsWith("read:")).toBe(true);
      expect(hash.length).toBe("read:".length + 64);
    });
  });

  describe("recordToolCall", () => {
    it("adds tool call to empty history", () => {
      const state = createState();

      recordToolCall(state, "read", { path: "/file.txt" }, "call-1");

      expect(state.toolCallHistory).toHaveLength(1);
      expect(state.toolCallHistory?.[0]?.toolName).toBe("read");
      expect(state.toolCallHistory?.[0]?.toolCallId).toBe("call-1");
    });

    it("maintains sliding window of last N calls", () => {
      const state = createState();

      for (let i = 0; i < TOOL_CALL_HISTORY_SIZE + 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`);
      }

      expect(state.toolCallHistory).toHaveLength(TOOL_CALL_HISTORY_SIZE);

      const oldestCall = state.toolCallHistory?.[0];
      expect(oldestCall?.argsHash).toBe(hashToolCall("tool", { iteration: 10 }));
    });

    it("records timestamp for each call", () => {
      const state = createState();
      const before = Date.now();
      recordToolCall(state, "tool", { arg: 1 }, "call-ts");
      const after = Date.now();

      const timestamp = state.toolCallHistory?.[0]?.timestamp ?? 0;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("records run id when provided", () => {
      const state = createState();

      recordToolCall(state, "tool", { arg: 1 }, "call-run", enabledLoopDetectionConfig, {
        runId: "run-1",
      });

      expect(state.toolCallHistory?.[0]?.runId).toBe("run-1");
    });

    it("respects configured historySize", () => {
      const state = createState();

      for (let i = 0; i < 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`, shortHistoryLoopConfig);
      }

      expect(state.toolCallHistory).toHaveLength(4);
      expect(state.toolCallHistory?.[0]?.argsHash).toBe(hashToolCall("tool", { iteration: 6 }));
    });
  });

  describe("detectToolCallLoop", () => {
    it("is disabled by default", () => {
      const state = createState();

      for (let i = 0; i < 20; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `default-${i}`);
      }

      const loopResult = detectToolCallLoop(state, "read", { path: "/same.txt" });
      expect(loopResult.stuck).toBe(false);
    });

    it("does not flag unique tool calls", () => {
      const state = createState();

      for (let i = 0; i < 15; i += 1) {
        recordToolCall(state, "read", { path: `/file${i}.txt` }, `call-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/new-file.txt" },
        enabledLoopDetectionConfig,
      );
      expect(result.stuck).toBe(false);
    });

    it("ignores repeated history from other runs", () => {
      const state = createState();
      const params = { path: "/same.txt" };

      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", params, `old-run-${i}`, enabledLoopDetectionConfig, {
          runId: "heartbeat-1",
        });
      }

      const result = detectToolCallLoop(state, "read", params, enabledLoopDetectionConfig, {
        runId: "heartbeat-2",
      });

      expect(result.stuck).toBe(false);
    });

    it("detects repeated history within the same run", () => {
      const state = createState();
      const params = { path: "/same.txt" };

      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", params, `same-run-${i}`, enabledLoopDetectionConfig, {
          runId: "run-1",
        });
      }

      const result = detectToolCallLoop(state, "read", params, enabledLoopDetectionConfig, {
        runId: "run-1",
      });

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe("generic_repeat");
        expect(result.count).toBe(WARNING_THRESHOLD);
      }
    });

    it("keeps scoped and unscoped history isolated", () => {
      const state = createState();
      const params = { path: "/same.txt" };

      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", params, `scoped-${i}`, enabledLoopDetectionConfig, {
          runId: "run-1",
        });
      }

      const result = detectToolCallLoop(state, "read", params, enabledLoopDetectionConfig);

      expect(result.stuck).toBe(false);
    });

    it("warns on generic repeated tool+args calls", () => {
      const state = createState();
      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `warn-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/same.txt" },
        enabledLoopDetectionConfig,
      );

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe("warning");
        expect(result.detector).toBe("generic_repeat");
        expect(result.count).toBe(WARNING_THRESHOLD);
        expect(result.message).toContain("WARNING");
        expect(result.message).toContain(`${WARNING_THRESHOLD} times`);
      }
    });

    it("keeps generic loops warn-only below global breaker threshold", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: fixture.toolName,
        toolParams: fixture.params,
        result: fixture.result,
        count: CRITICAL_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
      }
    });

    it("applies custom thresholds when detection is enabled", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-custom");
      const config: ToolLoopDetectionConfig = {
        enabled: true,
        warningThreshold: 2,
        criticalThreshold: 4,
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: true,
          pingPong: false,
        },
      };

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: 2,
      });
      const warningResult = detectToolCallLoop(state, "process", params, config);
      expect(warningResult.stuck).toBe(true);
      if (warningResult.stuck) {
        expect(warningResult.level).toBe("warning");
      }

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: 2,
        startIndex: 2,
      });
      const criticalResult = detectToolCallLoop(state, "process", params, config);
      expect(criticalResult.stuck).toBe(true);
      if (criticalResult.stuck) {
        expect(criticalResult.level).toBe("critical");
        expect(criticalResult.detector).toBe("known_poll_no_progress");
      }
    });

    it("can disable specific detectors", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-no-detectors");
      const config: ToolLoopDetectionConfig = {
        enabled: true,
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: false,
          pingPong: false,
        },
      };

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: CRITICAL_THRESHOLD,
      });

      const loopResult = detectToolCallLoop(state, "process", params, config);
      expect(loopResult.stuck).toBe(false);
    });

    it("warns for known polling no-progress loops", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: "process",
        toolParams: params,
        result,
        count: WARNING_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("no progress");
      }
    });

    it("blocks known polling no-progress loops at critical threshold", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: "process",
        toolParams: params,
        result,
        count: CRITICAL_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("CRITICAL");
      }
    });

    it("does not block known polling when output progresses", () => {
      const state = createState();
      const params = { action: "poll", sessionId: "sess-1" };

      for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
        const result = {
          content: [{ type: "text", text: `line ${i}` }],
          details: { status: "running", aggregated: `line ${i}` },
        };
        recordSuccessfulCall(state, "process", params, result, i);
      }

      const loopResult = detectToolCallLoop(state, "process", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(false);
    });

    it("blocks any tool with global no-progress breaker at 30", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: fixture.toolName,
        toolParams: fixture.params,
        result: fixture.result,
        count: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("global_circuit_breaker");
        expect(loopResult.message).toContain("global circuit breaker");
      }
    });

    it("blocks repeated completed exec calls despite volatile runtime details", () => {
      const state = createState();
      const params = { command: "grafana-api.sh datasources" };

      for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
        recordSuccessfulCall(
          state,
          "exec",
          params,
          {
            content: [{ type: "text", text: "Loki\nPrometheus" }],
            details: {
              status: "completed",
              exitCode: 0,
              durationMs: 100 + index,
              cwd: `/tmp/run-${index}`,
              aggregated: "Loki\nPrometheus",
            },
          },
          index,
        );
      }

      const loopResult = detectToolCallLoop(state, "exec", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("global_circuit_breaker");
      }
    });

    it("blocks repeated running exec calls despite volatile session details and text", () => {
      const state = createState();
      const params = { command: "tail -f /var/log/app.log", yieldMs: 1000 };

      for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
        recordSuccessfulCall(
          state,
          "exec",
          params,
          {
            content: [
              {
                type: "text",
                text: `Command still running (session sess-${index}, pid ${1000 + index})`,
              },
            ],
            details: {
              status: "running",
              sessionId: `sess-${index}`,
              pid: 1000 + index,
              startedAt: Date.now() + index,
              cwd: `/tmp/run-${index}`,
              tail: "(no new output)",
            },
          },
          index,
        );
      }

      const loopResult = detectToolCallLoop(state, "exec", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("global_circuit_breaker");
      }
    });

    it("keeps changing exec output below the global no-progress breaker", () => {
      const state = createState();
      const params = { command: "date" };

      for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
        recordSuccessfulCall(
          state,
          "exec",
          params,
          {
            content: [{ type: "text", text: `tick ${index}` }],
            details: {
              status: "completed",
              exitCode: 0,
              durationMs: 100 + index,
              aggregated: `tick ${index}`,
            },
          },
          index,
        );
      }

      const loopResult = detectToolCallLoop(state, "exec", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("generic_repeat");
      }
    });

    it("keeps changing empty-output exec failures below the global no-progress breaker", () => {
      const state = createState();
      const params = { command: "openclaw flaky-helper" };

      for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
        recordSuccessfulCall(
          state,
          "exec",
          params,
          {
            content: [{ type: "text", text: `Runtime failed before spawn: attempt ${index}` }],
            details: {
              status: "failed",
              exitCode: null,
              durationMs: 100 + index,
              aggregated: "",
            },
          },
          index,
        );
      }

      const loopResult = detectToolCallLoop(state, "exec", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("generic_repeat");
      }
    });

    it("does not block repeated unknown-tool failures before the unknown-tool threshold", () => {
      const state = createState();
      const toolName = "exec";
      const unknownToolError = new Error("Tool exec not found");

      for (let index = 0; index < UNKNOWN_TOOL_THRESHOLD - 1; index += 1) {
        recordFailedCall(state, toolName, { command: `echo ${index}` }, unknownToolError, index);
      }

      const loopResult = detectToolCallLoop(
        state,
        toolName,
        { command: "echo still allowed" },
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("blocks repeated unknown-tool failures even when the args keep changing", () => {
      const state = createState();
      const toolName = "exec";
      const unknownToolError = new Error("Tool exec not found");

      const attempts = [
        { command: "ls" },
        { command: "pwd" },
        { input: "whoami" },
        { cmd: "env" },
        { shell: "bash -lc ls" },
        { command: "printf ok" },
        { cwd: "/tmp", command: "ls" },
        { args: ["ls", "/tmp"] },
        { command: "find . -maxdepth 1" },
        { text: "run ls" },
        { command: "uname -a" },
        { command: "id" },
        { command: "date" },
        { command: "ps" },
        { command: "df -h" },
        { command: "free -m" },
        { command: "ls /tmp" },
        { command: "ls -la" },
        { command: "cat /etc/hostname" },
        { command: "echo done" },
      ];

      for (const [index, params] of attempts.entries()) {
        recordFailedCall(state, toolName, params, unknownToolError, index);
      }

      const loopResult = detectToolCallLoop(
        state,
        toolName,
        { command: "echo still looping" },
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.detector).toBe("unknown_tool_repeat");
        expect(loopResult.level).toBe("critical");
      }
    });

    it("warns on ping-pong alternating patterns", () => {
      const state = createState();
      const readParams = { path: "/a.txt" };
      const listParams = { dir: "/workspace" };

      for (let i = 0; i < WARNING_THRESHOLD - 1; i += 1) {
        if (i % 2 === 0) {
          recordToolCall(state, "read", readParams, `read-${i}`);
        } else {
          recordToolCall(state, "list", listParams, `list-${i}`);
        }
      }

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { level: "warning", count: WARNING_THRESHOLD });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("blocks ping-pong alternating patterns at critical threshold", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        state,
        readParams,
        listParams,
        count: CRITICAL_THRESHOLD - 1,
        textAtIndex: (toolName) => (toolName === "read" ? "read stable" : "list stable"),
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, {
        level: "critical",
        count: CRITICAL_THRESHOLD,
        expectCriticalText: true,
      });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("does not block ping-pong at critical threshold when outcomes are progressing", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        state,
        readParams,
        listParams,
        count: CRITICAL_THRESHOLD - 1,
        textAtIndex: (toolName, index) => `${toolName} ${index}`,
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { level: "warning", count: CRITICAL_THRESHOLD });
    });

    it("does not flag ping-pong when alternation is broken", () => {
      const state = createState();
      recordToolCall(state, "read", { path: "/a.txt" }, "a1");
      recordToolCall(state, "list", { dir: "/workspace" }, "b1");
      recordToolCall(state, "read", { path: "/a.txt" }, "a2");
      recordToolCall(state, "write", { path: "/tmp/out.txt" }, "c1"); // breaks alternation

      const loopResult = detectToolCallLoop(
        state,
        "list",
        { dir: "/workspace" },
        enabledLoopDetectionConfig,
      );
      expect(loopResult.stuck).toBe(false);
    });

    it("records fixed-size result hashes for large tool outputs", () => {
      const state = createState();
      const params = { action: "log", sessionId: "sess-big" };
      const toolCallId = "log-big";
      recordToolCall(state, "process", params, toolCallId);
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: params,
        toolCallId,
        result: {
          content: [{ type: "text", text: "y".repeat(40_000) }],
          details: { status: "running", totalLines: 1, totalChars: 40_000 },
        },
      });

      const entry = state.toolCallHistory?.find((call) => call.toolCallId === toolCallId);
      expect(typeof entry?.resultHash).toBe("string");
      expect(entry?.resultHash?.length).toBe(64);
    });

    it("does not attach outcomes to matching calls from other runs", () => {
      const state = createState();
      const params = { path: "/same.txt" };
      recordToolCall(state, "read", params, "call-1", enabledLoopDetectionConfig, {
        runId: "run-1",
      });

      recordToolCallOutcome(state, {
        toolName: "read",
        toolParams: params,
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "same output" }] },
        config: enabledLoopDetectionConfig,
        runId: "run-2",
      });

      expect(state.toolCallHistory).toHaveLength(2);
      expect(state.toolCallHistory?.[0]?.resultHash).toBeUndefined();
      expect(state.toolCallHistory?.[1]?.runId).toBe("run-2");
      expect(state.toolCallHistory?.[1]?.resultHash).toBeTypeOf("string");
    });

    it("handles empty history", () => {
      const state = createState();

      const result = detectToolCallLoop(state, "tool", { arg: 1 }, enabledLoopDetectionConfig);
      expect(result.stuck).toBe(false);
    });
  });

  describe("getToolCallStats", () => {
    it("returns zero stats for empty history", () => {
      const state = createState();

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });

    it("counts total calls and unique patterns", () => {
      const state = createState();

      for (let i = 0; i < 5; i += 1) {
        recordToolCall(state, "read", { path: "/file.txt" }, `same-${i}`);
      }

      recordToolCall(state, "write", { path: "/output.txt" }, "write-1");
      recordToolCall(state, "list", { dir: "/home" }, "list-1");
      recordToolCall(state, "read", { path: "/other.txt" }, "read-other");

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(8);
      expect(stats.uniquePatterns).toBe(4);
    });

    it("identifies most frequent pattern", () => {
      const state = createState();

      for (let i = 0; i < 3; i += 1) {
        recordToolCall(state, "read", { path: "/file1.txt" }, `p1-${i}`);
      }

      for (let i = 0; i < 7; i += 1) {
        recordToolCall(state, "read", { path: "/file2.txt" }, `p2-${i}`);
      }

      for (let i = 0; i < 2; i += 1) {
        recordToolCall(state, "write", { path: "/output.txt" }, `p3-${i}`);
      }

      const stats = getToolCallStats(state);
      expect(stats.mostFrequent?.toolName).toBe("read");
      expect(stats.mostFrequent?.count).toBe(7);
    });
  });
});
