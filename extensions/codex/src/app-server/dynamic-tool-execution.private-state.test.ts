import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeAgentToolTargetSessionKey,
  createAgentToolExecutionPrivateState,
  recordAgentToolTargetSessionKey,
  runWithAgentToolExecutionPrivateState,
  snapshotAgentToolExecutionPrivateState,
} from "../../../../packages/agent-core/src/tool-execution-private-state.js";
import {
  handleDynamicToolCallWithTimeout,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";

describe("Codex dynamic tool private state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retains private execution state when the outer watchdog wins without protocol leakage", async () => {
    vi.useFakeTimers();
    const state = createAgentToolExecutionPrivateState();
    runWithAgentToolExecutionPrivateState(state, () => {
      recordAgentToolTargetSessionKey("agent:watchdog:main");
    });
    const privateState = snapshotAgentToolExecutionPrivateState(state);
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-private-timeout",
        namespace: null,
        tool: "sessions_send",
        arguments: { sessionKey: "forged-model-value" },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
        consumeToolExecutionSnapshot: vi.fn(() => ({
          executionStarted: true,
          privateState,
        })),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    const runtimeResponse = await response;
    expect(Object.keys(runtimeResponse)).not.toContain("privateState");
    expect(toCodexDynamicToolProtocolResponse(runtimeResponse)).not.toHaveProperty("privateState");
    expect(consumeAgentToolTargetSessionKey(runtimeResponse.privateState)).toBe(
      "agent:watchdog:main",
    );
  });
});
