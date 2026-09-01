import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDynamicToolCallWithTimeout } from "./dynamic-tool-execution.js";

describe("dynamic tool timeout logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs process poll timeout context separately from session idle", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "process",
        arguments: { action: "poll", sessionId: "process-session", timeout: 30_000 },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal: () => ({
        executionStarted: true,
        executedArguments: { action: "poll", sessionId: "adjusted-session" },
        sideEffectEvidence: true,
        effectReceipt: { state: "uncertain" },
      }),
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while waiting for process action=poll sessionId=process-session. This is a tool RPC timeout, not a session idle timeout.",
        },
      ],
    });
    await expect(response).resolves.toMatchObject({ executionStarted: true });
    await expect(response).resolves.toMatchObject({
      executedArguments: { action: "poll", sessionId: "adjusted-session" },
    });
    expect(warn).toHaveBeenCalledWith("codex dynamic tool call timed out", {
      tool: "process",
      toolCallId: "call-timeout",
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1,
      timeoutKind: "codex_dynamic_tool_rpc",
      processAction: "poll",
      processSessionId: "process-session",
      processRequestedTimeoutMs: 30_000,
      consoleMessage:
        "codex process tool timeout: action=poll sessionId=process-session toolTimeoutMs=1 requestedWaitMs=30000; per-tool-call watchdog, not session idle; repeated lines usually mean process-poll retry churn, not model progress",
    });
  });

  it("does not split surrogate pairs when truncating timeout log fields", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const action = `${"a".repeat(156)}😀tail`;
    const sessionId = `${"s".repeat(156)}😀tail`;
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-utf16-log-field",
        namespace: null,
        tool: "process",
        arguments: { action, sessionId, timeout: 30_000 },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);

    const result = await response;
    const firstResultItem = result.contentItems[0];
    const resultText = firstResultItem?.type === "inputText" ? firstResultItem.text : "";
    const [, details] = warn.mock.calls[0] ?? [];
    const highSurrogate = String.fromCharCode(0xd83d);

    expect(result.success).toBe(false);
    expect(details).toMatchObject({
      processAction: `${"a".repeat(156)}...`,
      processSessionId: `${"s".repeat(156)}...`,
    });
    expect(resultText).not.toContain(highSurrogate);
    expect(String((details as Record<string, unknown>).consoleMessage)).not.toContain(
      highSurrogate,
    );
  });
});
