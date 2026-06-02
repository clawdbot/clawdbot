import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
  CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS,
  CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
  CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  resolveTerminalDynamicToolBatchAction,
  shouldBlockTerminalReleaseForNonTerminalDynamicToolResult,
  shouldReleaseTurnAfterTerminalDynamicTool,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

describe("dynamic tool execution helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps explicit dynamic tool timeouts above the default bridge deadline", () => {
    const timeoutMs = CODEX_DYNAMIC_TOOL_TIMEOUT_MS + 1_000;

    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-long",
          namespace: null,
          tool: "image_generate",
          arguments: { prompt: "cat", timeoutMs },
        },
        config: undefined,
      }),
    ).toBe(timeoutMs);
  });

  it("ignores partial dynamic tool timeout strings", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-partial-timeout",
          namespace: null,
          tool: "session_status",
          arguments: { timeoutMs: "1abc" },
        },
        config: undefined,
      }),
    ).toBe(CODEX_DYNAMIC_TOOL_TIMEOUT_MS);
  });

  it("uses configured image generation timeouts for Codex dynamic tool calls", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-generate-default",
          namespace: null,
          tool: "image_generate",
          arguments: { prompt: "cat" },
        },
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
                timeoutMs: 180_000,
              },
            },
          },
        },
      }),
    ).toBe(180_000);
  });

  it("uses default media and message dynamic tool deadlines", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-generate-default",
          namespace: null,
          tool: "image_generate",
          arguments: { prompt: "cat" },
        },
        config: undefined,
      }),
    ).toBe(120_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-default",
          namespace: null,
          tool: "image",
          arguments: { prompt: "describe", images: ["/tmp/one.jpg"] },
        },
        config: undefined,
      }),
    ).toBe(CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-message",
          namespace: null,
          tool: "message",
          arguments: { action: "send", message: "long outbound update" },
        },
        config: undefined,
      }),
    ).toBe(CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS);
  });

  it("uses media image config and caps excessive dynamic tool timeouts", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-default",
          namespace: null,
          tool: "image",
          arguments: { prompt: "describe", images: ["/tmp/one.jpg"] },
        },
        config: {
          tools: {
            media: {
              image: {
                timeoutSeconds: 180,
              },
            },
          },
        },
      }),
    ).toBe(180_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-too-long",
          namespace: null,
          tool: "image_generate",
          arguments: {
            prompt: "cat",
            timeoutMs: CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + 1_000,
          },
        },
        config: undefined,
      }),
    ).toBe(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS);
  });

  it("uses a 90 second default for generic Codex dynamic tool calls", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-session-status",
          namespace: null,
          tool: "session_status",
          arguments: { sessionKey: "current" },
        },
        config: undefined,
      }),
    ).toBe(90_000);
  });

  it("returns a failed dynamic tool response when an app-server tool call exceeds the deadline", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "hello" },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          capturedSignal = options?.signal;
          return new Promise<never>(() => {});
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
        },
      ],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
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

  it("keeps async-start metadata on internal dynamic tool progress only", () => {
    const response: CodexDynamicToolCallResponse = {
      contentItems: [{ type: "inputText", text: "Background task started." }],
      success: true,
    };
    Object.defineProperty(response, "asyncStarted", {
      configurable: true,
      enumerable: false,
      value: true,
    });

    const protocolResponse = toCodexDynamicToolProtocolResponse(response);
    const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);

    expect(protocolResponse).toEqual({
      contentItems: [{ type: "inputText", text: "Background task started." }],
      success: true,
    });
    expect(Object.keys(protocolResponse)).not.toContain("asyncStarted");
    expect(progressResponse).toEqual({
      contentItems: [{ type: "inputText", text: "Background task started." }],
      details: { async: true, status: "started" },
      success: true,
    });
  });

  it("allows turn release after successful terminal dynamic tool responses", () => {
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: true,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 1,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseTurnAfterTerminalDynamicTool({
        completed: false,
        aborted: false,
        responseSuccess: true,
        currentTurnHadNonTerminalDynamicToolResult: false,
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 1,
      }),
    ).toBe(false);
  });

  it("resolves terminal dynamic tool batch state", () => {
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 1,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: false,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("wait");
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: true,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("clear-nonterminal-batch");
    expect(
      resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: 0,
        activeTurnItemIdsCount: 0,
        pendingOpenClawDynamicToolCompletionIdsCount: 0,
        currentTurnHadNonTerminalDynamicToolResult: false,
        hasPendingTerminalDynamicToolRelease: true,
      }),
    ).toBe("release-pending-terminal");
  });

  it("does not let async-start tool results block terminal side-effect batches", () => {
    const asyncStartedResponse = {
      contentItems: [{ type: "inputText" as const, text: "Background task started." }],
      success: true,
    };
    Object.defineProperty(asyncStartedResponse, "asyncStarted", {
      configurable: true,
      enumerable: false,
      value: true,
    });

    expect(shouldBlockTerminalReleaseForNonTerminalDynamicToolResult(asyncStartedResponse)).toBe(
      false,
    );
    expect(
      shouldBlockTerminalReleaseForNonTerminalDynamicToolResult({
        contentItems: [{ type: "inputText", text: "regular output" }],
        success: true,
      }),
    ).toBe(true);
  });
});
