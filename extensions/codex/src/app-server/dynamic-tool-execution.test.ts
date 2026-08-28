// Codex tests cover dynamic tool execution plugin behavior.
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS;
const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

describe("dynamic tool execution helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each<{
    name: string;
    tool: string;
    arguments: CodexDynamicToolCallParams["arguments"];
    timeoutMs: number;
  }>([
    {
      name: "keeps explicit dynamic tool timeouts above the default bridge deadline",
      tool: "image_generate",
      arguments: { prompt: "cat", timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS + 1_000 },
      timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS + 1_000,
    },
    {
      name: "ignores partial dynamic tool timeout strings",
      tool: "session_status",
      arguments: { timeoutMs: "1abc" },
      timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
    },
    {
      name: "honors timeoutSeconds when timeoutMs is absent",
      tool: "session_status",
      arguments: { timeoutSeconds: 30 },
      timeoutMs: 60_000,
    },
    {
      name: "prefers timeoutMs over timeoutSeconds",
      tool: "session_status",
      arguments: { timeoutMs: 5_000, timeoutSeconds: 30 },
      timeoutMs: 5_000,
    },
    {
      name: "ignores non-positive timeoutSeconds",
      tool: "session_status",
      arguments: { timeoutSeconds: -1 },
      timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
    },
    {
      name: "rejects fractional timeoutSeconds and falls back to the default",
      tool: "session_status",
      arguments: { timeoutSeconds: 1.5 },
      timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
    },
  ])("$name", ({ tool, arguments: args, timeoutMs }) => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-timeout",
          namespace: null,
          tool,
          arguments: args,
        },
        config: undefined,
      }),
    ).toBe(timeoutMs);
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
              mediaModels: {
                image: {
                  primary: "openai/gpt-image-1",
                  timeoutMs: 180_000,
                },
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
          callId: "call-image-capability-default",
          namespace: null,
          tool: "view_image",
          arguments: { prompt: "describe", paths: ["/tmp/one.jpg"] },
        },
        config: {
          tools: {
            media: {
              models: [{ provider: "openai", model: "vision", capabilities: ["image"] }],
              image: { timeoutSeconds: 180 },
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
          callId: "call-image-mixed-timeouts",
          namespace: null,
          tool: "view_image",
          arguments: { prompt: "describe", paths: ["/tmp/one.jpg"] },
        },
        config: {
          tools: {
            media: {
              models: [
                { provider: "openai", model: "inherited", capabilities: ["image"] },
                {
                  provider: "openai",
                  model: "short",
                  capabilities: ["image"],
                  timeoutSeconds: 60,
                },
              ],
              image: { timeoutSeconds: 180 },
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
          tool: "view_image",
          arguments: { prompt: "describe", paths: ["/tmp/one.jpg"] },
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
          tool: "view_image",
          arguments: { prompt: "describe", paths: ["/tmp/one.jpg"] },
        },
        config: {
          tools: {
            media: {
              models: [
                { provider: "openai", model: "short", timeoutSeconds: 60, capabilities: ["image"] },
                { provider: "openai", model: "long", timeoutSeconds: 180, capabilities: ["image"] },
              ],
              image: { preferredModel: "openai/long" },
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
    const fullWaitTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 600 } },
      config: undefined,
    });
    expect(fullWaitTimeoutMs).toBe(630_000);
    expect(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(fullWaitTimeoutMs);
  });

  it.each([
    { name: "default", timeoutSeconds: undefined, expectedMs: 930_000 },
    { name: "explicit 15 minutes", timeoutSeconds: 900, expectedMs: 930_000 },
    { name: "one hour", timeoutSeconds: 3600, expectedMs: 3_630_000 },
    { name: "clamped maximum", timeoutSeconds: 99_999, expectedMs: 3_630_000 },
    { name: "clamped minimum", timeoutSeconds: 1, expectedMs: 60_000 },
    { name: "invalid fractional", timeoutSeconds: 1.5, expectedMs: 90_000 },
  ])("preserves the $name human question wait", ({ timeoutSeconds, expectedMs }) => {
    for (const tool of ["secrets", "ask_user"]) {
      expect(
        resolveDynamicToolCallTimeoutMs({
          call: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "credential-wait",
            namespace: null,
            tool,
            arguments: {
              action: "request",
              name: "TEST_API_KEY",
              ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
            },
          },
          config: undefined,
        }),
      ).toBe(expectedMs);
    }
  });

  it.each(["list", "delete"])("keeps secrets %s on the ordinary tool deadline", (action) => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "credential-metadata",
          namespace: null,
          tool: "secrets",
          arguments: { action, name: "TEST_API_KEY" },
        },
        config: undefined,
      }),
    ).toBe(90_000);
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
        effectReceipt: { state: "uncertain" as const },
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

  it.each([
    { tool: "session_status", deadlineMs: 600_000 },
    { tool: "agents_wait", deadlineMs: 630_000 },
  ])("enforces the resolved $tool cap at $deadlineMs ms", async ({ tool, deadlineMs }) => {
    vi.useFakeTimers();
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-capped-timeout",
      namespace: null,
      tool,
      arguments: { timeoutSeconds: 1_000 },
    };
    const onTimeout = vi.fn();
    const response = handleDynamicToolCallWithTimeout({
      call,
      toolBridge: { handleToolCall: vi.fn(() => new Promise<never>(() => {})) },
      signal: new AbortController().signal,
      timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined }),
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "timed_out",
    });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a timeout during pre-execution hooks as unstarted", async () => {
    vi.useFakeTimers();
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: false,
      sideEffectEvidence: false,
      effectReceipt: { state: "uncertain" as const },
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
        effectReceipt: { state: "uncertain" as const },
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

  it.each([
    { tool: "sessions_send", timeoutSeconds: 1, completionMs: 6_000 },
    { tool: "agents_wait", timeoutSeconds: 600, completionMs: 600_000 },
    { tool: "agents_wait", timeoutSeconds: 600, completionMs: 605_000 },
  ])(
    "preserves the $tool result after $completionMs ms",
    async ({ tool, timeoutSeconds, completionMs }) => {
      vi.useFakeTimers();
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-structured-timeout",
        namespace: null,
        tool,
        arguments: { timeoutSeconds },
      };
      const structuredTimeout: CodexDynamicToolCallResponse = {
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: JSON.stringify(
              tool === "agents_wait"
                ? { completed: [], pending: ["run-child"] }
                : {
                    runId: "run-child",
                    status: "timeout",
                    sentBeforeError: true,
                  },
            ),
          },
        ],
      };
      const response = handleDynamicToolCallWithTimeout({
        call,
        toolBridge: {
          handleToolCall: vi.fn(
            () =>
              new Promise<CodexDynamicToolCallResponse>((resolve) => {
                // Inner tool deadlines can start after setup; the outer watchdog
                // must preserve their result through the completion grace period.
                setTimeout(() => resolve(structuredTimeout), completionMs);
              }),
          ),
        },
        signal: new AbortController().signal,
        timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined }),
      });

      await vi.advanceTimersByTimeAsync(completionMs);

      await expect(response).resolves.toEqual(structuredTimeout);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
