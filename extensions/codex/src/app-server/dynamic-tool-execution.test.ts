// Codex tests cover dynamic tool execution plugin behavior.
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  resolveTerminalDynamicToolBatchAction,
  shouldBlockTerminalReleaseForNonTerminalDynamicToolResult,
  shouldReleaseTurnAfterTerminalDynamicTool,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS;

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

  it("honors timeoutSeconds when timeoutMs is absent", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-seconds",
          namespace: null,
          tool: "session_status",
          arguments: { timeoutSeconds: 30 },
        },
        config: undefined,
      }),
    ).toBe(60_000);
  });

  it("prefers timeoutMs over timeoutSeconds", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-both",
          namespace: null,
          tool: "session_status",
          arguments: { timeoutMs: 5_000, timeoutSeconds: 30 },
        },
        config: undefined,
      }),
    ).toBe(5_000);
  });

  it("ignores non-positive timeoutSeconds", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-bad-seconds",
          namespace: null,
          tool: "session_status",
          arguments: { timeoutSeconds: -1 },
        },
        config: undefined,
      }),
    ).toBe(CODEX_DYNAMIC_TOOL_TIMEOUT_MS);
  });

  it("rejects fractional timeoutSeconds and falls back to the default", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-fractional-seconds",
          namespace: null,
          tool: "session_status",
          arguments: { timeoutSeconds: 1.5 },
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
          callId: "call-computer-wait",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait", duration: 100 },
        },
        config: undefined,
      }),
    ).toBe(220_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-transport-timeout",
          namespace: null,
          tool: "computer",
          arguments: { action: "left_click", coordinate: [1, 1], timeoutMs: 1_000 },
        },
        config: undefined,
      }),
    ).toBe(34_000);
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
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-message-transport-timeout",
          namespace: null,
          tool: "message",
          arguments: {
            action: "send",
            message: "long outbound update",
            timeoutMs: 30_000,
          },
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

  it("gives agents_wait the long-running cap while preserving its inner timeout budget", () => {
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-agents-wait",
      namespace: null,
      tool: "agents_wait",
    };

    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"] } },
        config: undefined,
      }),
    ).toBe(630_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 120 } },
        config: undefined,
      }),
    ).toBe(150_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 600 } },
        config: undefined,
      }),
    ).toBe(630_000);
  });

  it("returns a failed dynamic tool response when an app-server tool call exceeds the deadline", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const onFallbackSelected = vi.fn();
    const onAgentToolResult = vi.fn();
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
      onAgentToolResult,
      observeToolTerminal: () => ({
        executionStarted: true,
        sideEffectEvidence: true,
      }),
      onFallbackSelected,
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
    expect((await response).diagnosticTerminalReason).toBe("timed_out");
    expect((await response).executionStarted).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    expect(onFallbackSelected).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "message",
      result: {
        content: [
          {
            type: "text",
            text: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
          },
        ],
        details: {
          status: "timed_out",
          error: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
        },
      },
      isError: true,
    });
  });

  it("marks a timeout during pre-execution hooks as unstarted", async () => {
    vi.useFakeTimers();
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: false,
      sideEffectEvidence: false,
    }));
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-prehook-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "hello" },
      },
      toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ executionStarted: false, success: false });
    expect((await response).sideEffectEvidence).toBeUndefined();
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call-prehook-timeout",
        toolName: "message",
        outcome: "failure",
      }),
    );
  });

  it("delegates an unpublished abort boundary to the terminal observer", async () => {
    vi.useFakeTimers();
    const observeToolTerminal = vi.fn(
      (
        _observation: Parameters<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>[0],
      ) => ({
        executionStarted: false,
        executedArguments: {
          action: "send",
          target: "channel:adjusted",
          text: "hello",
        },
        sideEffectEvidence: false,
      }),
    );
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-abort-aware-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", target: "channel:original", text: "hello" },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          expect(options?.retainExecutionSnapshot).toBe(true);
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                const reason = options.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("tool call aborted"));
              },
              { once: true },
            );
          });
        }),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ executionStarted: false, success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { action: "send", target: "channel:original", text: "hello" },
        outcome: "failure",
      }),
    );
    expect(observeToolTerminal.mock.calls[0]?.[0]).not.toHaveProperty("executionStarted");
    await expect(response).resolves.toMatchObject({
      executedArguments: {
        action: "send",
        target: "channel:adjusted",
        text: "hello",
      },
    });
  });

  it("uses a conservative dispatched fallback without a terminal observer", async () => {
    vi.useFakeTimers();
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-untracked-timeout",
        namespace: null,
        tool: "custom_mutation",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
      signal: new AbortController().signal,
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ executionStarted: true, success: false });
    expect((await response).sideEffectEvidence).toBe(true);
  });

  it("lets a structured sessions_send timeout win after setup work", async () => {
    vi.useFakeTimers();
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-session-send-timeout",
      namespace: null,
      tool: "sessions_send",
      arguments: { sessionKey: "agent:child", message: "ping", timeoutSeconds: 1 },
    };
    const structuredTimeout: CodexDynamicToolCallResponse = {
      success: true,
      contentItems: [
        {
          type: "inputText" as const,
          text: JSON.stringify({
            runId: "run-child",
            status: "timeout",
            sentBeforeError: true,
          }),
        },
      ],
    };
    const response = handleDynamicToolCallWithTimeout({
      call,
      toolBridge: {
        handleToolCall: vi.fn(
          () =>
            new Promise<CodexDynamicToolCallResponse>((resolve) => {
              // sessions_send can spend time resolving/snapshotting the target
              // before its own timeoutSeconds wait starts.
              setTimeout(() => resolve(structuredTimeout), 6_000);
            }),
        ),
      },
      signal: new AbortController().signal,
      timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined }),
    });

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(response).resolves.toEqual(structuredTimeout);
  });

  it("reports pre-execution cancellations to the private result observer", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const onAgentToolResult = vi.fn();
    const handleToolCall = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-aborted",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall },
      signal: controller.signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(result).toEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: "OpenClaw dynamic tool call aborted before execution." },
      ],
    });
    expect(result.diagnosticTerminalReason).toBe("cancelled");
    expect(result.executionStarted).toBe(false);
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_search",
      result: {
        content: [{ type: "text", text: "OpenClaw dynamic tool call aborted before execution." }],
        details: {
          status: "cancelled",
          error: "OpenClaw dynamic tool call aborted before execution.",
        },
      },
      isError: true,
    });
  });

  it.each([
    Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
    "turn_completion_idle_timeout",
  ])("preserves enclosing timeout provenance for pre-execution aborts", async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout-abort",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(result.diagnosticTerminalReason).toBe("timed_out");
  });

  it("classifies app-server client closure as a failed tool outcome", async () => {
    const controller = new AbortController();
    controller.abort("client_closed");

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-client-closed",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(result.diagnosticTerminalReason).toBe("failed");
  });

  it("preserves enclosing timeout provenance for active tool aborts", async () => {
    const controller = new AbortController();
    const resultPromise = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-active-timeout-abort",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort(Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }));

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
  });

  it("preserves timeout provenance when the dynamic tool bridge rejects", async () => {
    const timeoutError = Object.assign(new Error("tool deadline elapsed"), {
      name: "TimeoutError",
    });
    const onAgentToolResult = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-rejected-timeout",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: {
        handleToolCall: vi.fn(async () => {
          throw timeoutError;
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(result).toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_search",
      result: {
        content: [{ type: "text", text: "tool deadline elapsed" }],
        details: { status: "timed_out", error: "tool deadline elapsed" },
      },
      isError: true,
    });
  });

  it("contains hostile rejected values while notifying the private observer", async () => {
    const hostileError = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("message getter escaped");
      },
    });
    const onAgentToolResult = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-hostile-error",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: {
        handleToolCall: vi.fn(async () => {
          throw hostileError;
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(result).toMatchObject({
      success: false,
      diagnosticTerminalReason: "failed",
      contentItems: [{ type: "inputText", text: "OpenClaw dynamic tool call failed." }],
    });
    expect(onAgentToolResult).toHaveBeenCalledOnce();
  });

  it("contains hostile abort reasons while notifying the private observer", async () => {
    const hostileReason = Object.defineProperty({}, "name", {
      get() {
        throw new Error("name getter escaped");
      },
    });
    const controller = new AbortController();
    controller.abort(hostileReason);
    const onAgentToolResult = vi.fn();

    const result = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-hostile-abort",
        namespace: null,
        tool: "memory_search",
        arguments: {},
      },
      toolBridge: { handleToolCall: vi.fn() },
      signal: controller.signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(result).toMatchObject({
      success: false,
      diagnosticTerminalReason: "cancelled",
    });
    expect(onAgentToolResult).toHaveBeenCalledOnce();
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
    Object.defineProperties(response, {
      executedArguments: {
        configurable: true,
        enumerable: false,
        value: { action: "send", to: "channel:123" },
      },
      executionStarted: {
        configurable: true,
        enumerable: false,
        value: true,
      },
    });

    const protocolResponse = toCodexDynamicToolProtocolResponse(response);
    const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);

    expect(protocolResponse).toEqual({
      contentItems: [{ type: "inputText", text: "Background task started." }],
      success: true,
    });
    expect(Object.keys(protocolResponse)).not.toContain("asyncStarted");
    expect("executionStarted" in protocolResponse).toBe(false);
    expect("executedArguments" in protocolResponse).toBe(false);
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
