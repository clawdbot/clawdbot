// Codex tests cover run attemptynamic tools plugin behavior.
import path from "node:path";
import { onAgentEvent, type AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";
import {
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { testing } from "./run-attempt.js";

function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

function activeDiagnosticToolKeys(events: DiagnosticEventPayload[]): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.execution.started") {
      active.add(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    } else if (
      event.type === "tool.execution.completed" ||
      event.type === "tool.execution.error" ||
      event.type === "tool.execution.blocked"
    ) {
      active.delete(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    }
  }
  return active;
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt dynamic tools", () => {
  it("passes the live run session key to Codex dynamic tools when sandbox policy uses another key", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sessionKey = "agent:main:main";

    expect(
      testing.resolveOpenClawCodingToolsSessionKeys(
        params,
        "agent:main:telegram:default:direct:1234",
      ),
    ).toEqual({
      sessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
    });

    expect(testing.resolveOpenClawCodingToolsSessionKeys(params, "agent:main:main")).toEqual({
      sessionKey: "agent:main:main",
      runSessionKey: undefined,
    });
  });

  it("emits normalized tool progress around app-server dynamic tool requests", async () => {
    const harness = createStartedThreadHarness();
    const onRunAgentEvent = vi.fn();
    const onExecutionPhase = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = onRunAgentEvent;
    params.onExecutionPhase = onExecutionPhase;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("thread/start");

    const toolResult = (await harness.handleServerRequest({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lookup",
        arguments: {
          action: "search",
          token: "plain-secret-value-12345",
          text: "hello",
        },
      },
    })) as {
      contentItems?: Array<{ text?: string; type?: string }>;
      success?: boolean;
    };
    expect(toolResult.success).toBe(false);
    expect(toolResult.contentItems?.[0]?.type).toBe("inputText");
    expect(toolResult.contentItems?.[0]?.text).toMatch(/^Unknown OpenClaw tool: lookup$/u);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await flushDiagnosticEvents();
    unsubscribeDiagnostics();

    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data?: {
        args?: Record<string, unknown>;
        isError?: boolean;
        name?: string;
        phase?: string;
        result?: { success?: boolean };
        toolCallId?: string;
      };
      stream?: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "tool" && event.data?.phase === "start",
    );
    expect(startEvent?.data?.name).toBe("lookup");
    expect(startEvent?.data?.toolCallId).toBe("call-1");
    expect(startEvent?.data?.args?.action).toBe("search");
    expect(startEvent?.data?.args?.token).toBe("plain-…2345");
    expect(startEvent?.data?.args?.text).toBe("hello");
    const resultEvent = agentEvents.find(
      (event) =>
        event.stream === "tool" &&
        event.data?.phase === "result" &&
        event.data.result !== undefined,
    );
    expect(resultEvent?.data?.name).toBe("lookup");
    expect(resultEvent?.data?.toolCallId).toBe("call-1");
    expect(resultEvent?.data?.isError).toBe(true);
    expect(resultEvent?.data?.result?.success).toBe(false);
    expect(JSON.stringify(agentEvents)).not.toContain("plain-secret-value-12345");
    const globalStartEvent = globalAgentEvents.find(
      (event) => event.stream === "tool" && event.data.phase === "start",
    );
    expect(globalStartEvent?.runId).toBe("run-1");
    expect(globalStartEvent?.sessionKey).toBe("agent:main:session-1");
    expect(globalStartEvent?.data.name).toBe("lookup");
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "turn_accepted",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
      tool: "lookup",
      toolCallId: "call-1",
    });
    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "lookup",
        toolCallId: "call-1",
      },
      {
        type: "tool.execution.error",
        toolName: "lookup",
        toolCallId: "call-1",
      },
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("clears dynamic tool diagnostics after successful terminal responses", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-1",
        namespace: null,
        tool: "echo",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;

      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: true,
          contentItems: [{ type: "inputText", text: "echo done" }],
        },
      });

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          {
            type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error";
          }
        > => event.type.startsWith("tool.execution."),
      );
      const toolDiagnosticEventSummaries = toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      }));
      expect(toolDiagnosticEventSummaries).toContainEqual({
        type: "tool.execution.started",
        toolName: "echo",
        toolCallId: "call-echo-1",
      });
      expect(toolDiagnosticEventSummaries.at(-1)).toEqual({
        type: "tool.execution.completed",
        toolName: "echo",
        toolCallId: "call-echo-1",
      });
      expect(
        toolDiagnosticEventSummaries.filter((event) => event.type === "tool.execution.started"),
      ).toHaveLength(1);
      expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("emits request-boundary terminal diagnostics when a wrapped dynamic tool does not", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-unobserved-terminal",
        namespace: null,
        tool: "echo",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;

      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId: "other-run",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        toolName: "echo",
        toolCallId: "call-echo-unobserved-terminal",
        durationMs: 1,
      });
      expect(
        testing.hasPendingDynamicToolTerminalDiagnostic({
          call,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      ).toBe(false);

      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: true,
          contentItems: [{ type: "inputText", text: "echo done" }],
        },
      });

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
        > => event.type.startsWith("tool.execution."),
      );
      expect(
        toolDiagnosticEvents.map((event) => ({
          runId: event.runId,
          type: event.type,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        })),
      ).toEqual([
        {
          runId: "run-1",
          type: "tool.execution.started",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
        {
          runId: "other-run",
          type: "tool.execution.completed",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
        {
          runId: "run-1",
          type: "tool.execution.completed",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
      ]);
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("does not duplicate terminal diagnostics for wrapped dynamic tool blocks", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-blocked",
        namespace: null,
        tool: "echo",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;
      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: false,
          diagnosticTerminalType: "blocked",
          contentItems: [{ type: "inputText", text: "blocked by policy" }],
        },
      });
      expect(
        testing.hasPendingDynamicToolTerminalDiagnostic({
          call,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      ).toBe(true);

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          {
            type:
              | "tool.execution.blocked"
              | "tool.execution.started"
              | "tool.execution.completed"
              | "tool.execution.error";
          }
        > => event.type.startsWith("tool.execution."),
      );
      expect(
        toolDiagnosticEvents.map((event) => ({
          type: event.type,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "echo",
          toolCallId: "call-echo-blocked",
        },
        {
          type: "tool.execution.blocked",
          toolName: "echo",
          toolCallId: "call-echo-blocked",
        },
      ]);
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("does not duplicate terminal diagnostics for wrapped dynamic tool errors", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-error",
        namespace: null,
        tool: "echo",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;
      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: false,
          contentItems: [{ type: "inputText", text: "wrapped tool failed" }],
        },
      });
      expect(
        testing.hasPendingDynamicToolTerminalDiagnostic({
          call,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      ).toBe(true);

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
        > => event.type.startsWith("tool.execution."),
      );
      expect(
        toolDiagnosticEvents.map((event) => ({
          type: event.type,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "echo",
          toolCallId: "call-echo-error",
        },
        {
          type: "tool.execution.error",
          toolName: "echo",
          toolCallId: "call-echo-error",
        },
      ]);
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("does not duplicate terminal diagnostics for wrapped dynamic tool timeout fallbacks", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-timeout",
        namespace: null,
        tool: "echo",
        arguments: { timeoutMs: 1 },
      } satisfies CodexDynamicToolCallParams;
      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "OpenClaw dynamic tool call timed out after 1ms while running tool echo.",
            },
          ],
        },
      });
      expect(
        testing.hasPendingDynamicToolTerminalDiagnostic({
          call,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      ).toBe(true);

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
        > => event.type.startsWith("tool.execution."),
      );
      expect(
        toolDiagnosticEvents.map((event) => ({
          type: event.type,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "echo",
          toolCallId: "call-echo-timeout",
        },
        {
          type: "tool.execution.error",
          toolName: "echo",
          toolCallId: "call-echo-timeout",
        },
      ]);
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it("passes normalized channel context to app-server dynamic tool result hooks", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    const sessionKey = "agent:main:session-1";
    const hookChannelId = testing.resolveCodexAppServerHookChannelId(params, sessionKey);

    const bridge = createCodexDynamicToolBridge({
      tools: [createRuntimeDynamicTool("echo")],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey,
        runId: "run-1",
        channelId: hookChannelId,
      },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-echo-1",
      namespace: null,
      tool: "echo",
      arguments: {},
    });

    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    expect(afterToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        channelId: "-100123",
        toolName: "echo",
        toolCallId: "call-echo-1",
      }),
    );
  });
});
