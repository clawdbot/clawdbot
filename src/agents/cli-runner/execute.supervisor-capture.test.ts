// Covers CLI execution paths where the process supervisor keeps stdout capture
// disabled and the runner must parse streamed chunks without relying on tails.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult as recordMcpLoopbackToolCallResultForHandle,
  resolveMcpLoopbackYieldContext,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createManagedRun, supervisorSpawnMock } from "../cli-runner.test-support.js";
import { getCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function recordMcpLoopbackToolCallResult(params: {
  captureKey: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
  outcome?: "blocked" | "cancelled" | "completed" | "failed" | "timed_out" | "unknown";
  deniedReason?: string;
}): void {
  const captureHandle = markMcpLoopbackToolCallStarted(params);
  if (!captureHandle) {
    return;
  }
  const outcome = params.outcome ?? (params.isError ? "failed" : "completed");
  const result =
    outcome === "blocked"
      ? {
          outcome,
          deniedReason: params.deniedReason ?? "plugin-before-tool-call",
        }
      : { outcome, result: params.result };
  recordMcpLoopbackToolCallResultForHandle({
    captureHandle,
    toolName: params.toolName,
    args: params.args,
    ...result,
  });
  markMcpLoopbackToolCallFinished(captureHandle);
}

function buildPreparedCliRunContext(params: {
  output: "jsonl" | "text";
  provider?: string;
  runId?: string;
  beforeExecution?: () => Promise<void>;
}): PreparedCliRunContext {
  const provider = params.provider ?? "codex-cli";
  const backend = {
    command: "agent-cli",
    args: [],
    output: params.output,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model: "model",
      timeoutMs: 1_000,
      runId: params.runId ?? `run-${params.output}`,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
      ...(params.beforeExecution ? { beforeExecution: params.beforeExecution } : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function requireSupervisorSpawnInput(): SupervisorSpawnInput {
  const call = supervisorSpawnMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected supervisor spawn");
  }
  return call[0] as SupervisorSpawnInput;
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  supervisorSpawnMock.mockReset();
});

describe("executePreparedCliRun supervisor output capture", () => {
  it("runs prepared backend staging inside the serialized execution queue", async () => {
    const firstSpawnEntered = createDeferred();
    const releaseFirstSpawn = createDeferred();
    const events: string[] = [];
    let spawnCount = 0;

    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      spawnCount += 1;
      const input = args[0] as SupervisorSpawnInput;
      const label = spawnCount === 1 ? "first" : "second";
      events.push(`spawn:${label}`);
      input.onStdout?.(`answer ${label}`);
      if (label === "first") {
        firstSpawnEntered.resolve();
        await releaseFirstSpawn.promise;
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const first = executePreparedCliRun(
      buildPreparedCliRunContext({
        output: "text",
        runId: "run-first",
        beforeExecution: async () => {
          events.push("stage:first");
        },
      }),
    );
    await firstSpawnEntered.promise;
    const second = executePreparedCliRun(
      buildPreparedCliRunContext({
        output: "text",
        runId: "run-second",
        beforeExecution: async () => {
          events.push("stage:second");
        },
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(events).toEqual(["stage:first", "spawn:first"]);

    releaseFirstSpawn.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["stage:first", "spawn:first", "stage:second", "spawn:second"]);
  });

  it("disables supervisor capture without parsing from the diagnostic stdout tail", async () => {
    const fullText = `start-${"x".repeat(80 * 1024)}-end`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(fullText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : fullText,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    const spawnInput = requireSupervisorSpawnInput();

    expect(spawnInput.captureOutput).toBe(false);
    expect(result.rawText).toBe(fullText);
  });

  it("rejects oversized successful stdout instead of parsing a truncated tail", async () => {
    const noisyPrefix = "x".repeat(2 * 1024 * 1024);
    const finalText = "final answer";

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(noisyPrefix);
      input.onStdout?.(finalText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${noisyPrefix}${finalText}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await expect(
      executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
    ).rejects.toThrow("CLI stdout exceeded");
    const spawnInput = requireSupervisorSpawnInput();

    expect(spawnInput.captureOutput).toBe(false);
  });

  it("parses valid oversized JSONL output incrementally", async () => {
    // JSONL agents can emit huge tool deltas; only the incremental parser sees
    // the complete stream once supervisor capture is intentionally off.
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "session-jsonl-large",
      result: "final answer",
    })}\n`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.text).toBe("final answer");
    expect(result.sessionId).toBe("session-jsonl-large");
  });

  it("parses oversized resume JSONL output from the effective resume output mode", async () => {
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "resume-jsonl-session",
      result: "resumed answer",
    })}\n`;
    const context = buildPreparedCliRunContext({
      output: "text",
      provider: "resume-jsonl-cli",
    });
    // Resume can switch the backend from text to JSONL, so the executor must
    // derive parser mode from the effective resume config instead of the base.
    Object.assign(context.preparedBackend.backend, {
      jsonlDialect: "claude-stream-json" as const,
      resumeArgs: ["resume", "{sessionId}"],
      resumeOutput: "jsonl" as const,
      sessionMode: "existing" as const,
    });

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context, "resume-jsonl-session");

    expect(result.text).toBe("resumed answer");
    expect(result.sessionId).toBe("resume-jsonl-session");
  });

  it("classifies failed stdout from the retained parse buffer before the diagnostic tail", async () => {
    // The error classifier needs the retained parse buffer; the human-facing
    // diagnostic tail may contain only noise once stdout grows large.
    const errorPrefix = `${JSON.stringify({
      type: "result",
      is_error: true,
      result: "429 rate limit exceeded",
    })}\n`;
    const noisyTail = "x".repeat(80 * 1024);

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(errorPrefix);
      input.onStdout?.(noisyTail);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${errorPrefix}${noisyTail}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    } catch (error) {
      const classified = error as { reason?: unknown; status?: unknown };
      expect(classified.reason).toBe("rate_limit");
      expect(classified.status).toBe(429);
      return;
    }
    throw new Error("Expected CLI run to reject with a rate limit error");
  });

  it("fails one-shot Claude is_error results even when the process exits successfully", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Credit balance is too low",
      session_id: "session-jsonl-error",
    })}\n`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(stdout);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : stdout,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      ),
    ).rejects.toMatchObject({
      name: "FailoverError",
      message: "Credit balance is too low",
    });
  });

  it("still streams every JSONL stdout chunk with supervisor capture disabled", async () => {
    // Streaming events are emitted from live chunks, not from the final captured
    // stdout string, so users still see deltas when captureOutput is false.
    const agentEvents: Array<{ text?: string; delta?: string }> = [];
    const stop = onAgentEvent((event) => {
      if (event.stream !== "assistant") {
        return;
      }
      agentEvents.push({
        text: typeof event.data.text === "string" ? event.data.text : undefined,
        delta: typeof event.data.delta === "string" ? event.data.delta : undefined,
      });
    });
    const chunks = [
      `${JSON.stringify({ type: "init", session_id: "session-jsonl" })}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      })}\n`,
      `not-json ${"x".repeat(80 * 1024)}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      })}\n`,
      `${JSON.stringify({
        type: "result",
        session_id: "session-jsonl",
        result: "Hello world",
      })}\n`,
    ];

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : chunks.join(""),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
      const spawnInput = requireSupervisorSpawnInput();

      expect(spawnInput.captureOutput).toBe(false);
      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("emits metadata-only lifecycle records for parsed CLI tools", async () => {
    const secret = "secret tool input and result";
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "call-1",
              name: "mcp__team__lookup",
              input: { query: secret },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: secret }],
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.params.sessionKey = "agent:coder:main";
    context.params.agentId = "coder";

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toEqual([
      expect.objectContaining({
        type: "tool.execution.started",
        runId: "run-jsonl",
        sessionKey: "agent:coder:main",
        sessionId: "session-1",
        agentId: "coder",
        toolName: "mcp__team__lookup",
        toolSource: "mcp",
        toolOwner: "cli-runner",
        toolCallId: "call-1",
      }),
      expect.objectContaining({
        type: "tool.execution.completed",
        runId: "run-jsonl",
        toolCallId: "call-1",
      }),
    ]);
    expect(JSON.stringify(toolEvents)).not.toContain(secret);
  });

  it.each([
    {
      name: "policy block",
      outcome: "blocked",
      deniedReason: "plugin-approval",
      expected: { type: "tool.execution.blocked", deniedReason: "plugin-approval" },
    },
    {
      name: "resolved failure",
      outcome: "failed",
      deniedReason: undefined,
      expected: { type: "tool.execution.error", terminalReason: "failed" },
    },
    {
      name: "resolved timeout",
      outcome: "timed_out",
      deniedReason: undefined,
      expected: { type: "tool.execution.error", terminalReason: "timed_out" },
    },
  ] as const)("preserves loopback $name for parsed CLI tools", async (testCase) => {
    const toolCallId = `call-${testCase.outcome}`;
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "mcp_tool_use",
                id: toolCallId,
                name: "mcp__openclaw__message",
                input: { action: "react" },
              },
            ],
          },
        })}\n`,
      );
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "react" },
        isError: true,
        outcome: testCase.outcome,
        ...(testCase.deniedReason ? { deniedReason: testCase.deniedReason } : {}),
      });
      input.onStdout?.(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: "blocked",
                is_error: true,
              },
            ],
          },
        })}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId },
      { ...testCase.expected, toolCallId },
    ]);
  });

  it("binds a loopback call admitted before its parsed CLI identity", async () => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        toolName: "message",
        args: { action: "react", emoji: "early" },
      });
      if (!captureHandle) {
        throw new Error("Expected early loopback capture handle");
      }
      input.onStdout?.(
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "mcp_tool_use",
                id: "call-early",
                name: "mcp__openclaw__message",
                input: { action: "react", emoji: "early" },
              },
            ],
          },
        })}\n`,
      );
      recordMcpLoopbackToolCallResultForHandle({
        captureHandle,
        toolName: "message",
        args: { action: "react", emoji: "early" },
        outcome: "blocked",
        deniedReason: "plugin-approval",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      input.onStdout?.(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-early",
                content: "blocked",
                is_error: true,
              },
            ],
          },
        })}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-early" },
      {
        type: "tool.execution.blocked",
        toolCallId: "call-early",
        deniedReason: "plugin-approval",
      },
    ]);
  });

  it("correlates parallel same-name loopback calls by arguments instead of admission order", async () => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "mcp_tool_use",
                id: "call-a",
                name: "mcp__openclaw__message",
                input: { action: "react", emoji: "A" },
              },
              {
                type: "mcp_tool_use",
                id: "call-b",
                name: "mcp__openclaw__message",
                input: { action: "react", emoji: "B" },
              },
            ],
          },
        })}\n`,
      );
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "react", emoji: "B" },
        isError: true,
        outcome: "failed",
      });
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "react", emoji: "A" },
        isError: false,
        outcome: "completed",
      });
      input.onStdout?.(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call-a", content: "ok" },
              { type: "tool_result", tool_use_id: "call-b", content: "failed", is_error: true },
            ],
          },
        })}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-a" },
      { type: "tool.execution.started", toolCallId: "call-b" },
      { type: "tool.execution.completed", toolCallId: "call-a" },
      { type: "tool.execution.error", toolCallId: "call-b", terminalReason: "failed" },
    ]);
  });

  it.each([
    "request before both CLI identities",
    "request between CLI identities",
    "first tool finishes before second CLI identity",
  ])("keeps identical parallel outcomes unknown with %s", async (ordering) => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const toolArgs = { action: "react", emoji: "same" };
      const emitToolStarts = (toolCallIds: string[]) => {
        input.onStdout?.(
          `${JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: toolCallIds.map((id) => ({
                type: "mcp_tool_use",
                id,
                name: "mcp__openclaw__message",
                input: toolArgs,
              })),
            },
          })}\n`,
        );
      };
      const recordOutcome = (outcome: "completed" | "failed") =>
        recordMcpLoopbackToolCallResult({
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "message",
          args: toolArgs,
          isError: outcome === "failed",
          outcome,
        });
      const emitToolResults = (toolCallIds: string[]) => {
        input.onStdout?.(
          `${JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: toolCallIds.map((toolCallId) => ({
                type: "tool_result",
                tool_use_id: toolCallId,
                content: "ok",
              })),
            },
          })}\n`,
        );
      };
      if (ordering === "request before both CLI identities") {
        recordOutcome("failed");
        emitToolStarts(["call-identical-a", "call-identical-b"]);
        recordOutcome("completed");
      } else if (ordering === "request between CLI identities") {
        emitToolStarts(["call-identical-a"]);
        recordOutcome("failed");
        recordOutcome("completed");
        emitToolStarts(["call-identical-b"]);
      } else {
        emitToolStarts(["call-identical-a"]);
        recordOutcome("failed");
        recordOutcome("completed");
        emitToolResults(["call-identical-a"]);
        emitToolStarts(["call-identical-b"]);
      }
      emitToolResults(
        ordering === "first tool finishes before second CLI identity"
          ? ["call-identical-b"]
          : ["call-identical-a", "call-identical-b"],
      );
      emitToolStarts(["call-identical-later"]);
      recordOutcome("completed");
      input.onStdout?.(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-identical-later", content: "ok" }],
          },
        })}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toHaveLength(6);
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.execution.started",
          toolCallId: "call-identical-a",
        }),
        expect.objectContaining({
          type: "tool.execution.started",
          toolCallId: "call-identical-b",
        }),
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "call-identical-a",
          errorCode: "tool_outcome_unknown",
        }),
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "call-identical-b",
          errorCode: "tool_outcome_unknown",
        }),
        expect.objectContaining({
          type: "tool.execution.started",
          toolCallId: "call-identical-later",
        }),
        expect.objectContaining({
          type: "tool.execution.completed",
          toolCallId: "call-identical-later",
        }),
      ]),
    );
  });

  it("uses a loopback outcome that settles during the post-process drain", async () => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const toolArgs = { action: "react", emoji: "A" };
      input.onStdout?.(
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "mcp_tool_use",
                id: "call-draining",
                name: "mcp__openclaw__message",
                input: toolArgs,
              },
            ],
          },
        })}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        toolName: "message",
        args: toolArgs,
      });
      if (!captureHandle) {
        throw new Error("Expected loopback capture handle");
      }
      setTimeout(() => {
        recordMcpLoopbackToolCallResultForHandle({
          captureHandle,
          toolName: "message",
          args: toolArgs,
          outcome: "completed",
          result: { ok: true },
        });
        markMcpLoopbackToolCallFinished(captureHandle);
      }, 10);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    try {
      await executePreparedCliRun(context);
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-draining" },
      { type: "tool.execution.completed", toolCallId: "call-draining" },
    ]);
  });

  it("finishes parsed CLI tools when the process exits before a tool result", async () => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    const toolStart = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "call-incomplete",
            name: "mcp__team__lookup",
            input: {},
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(toolStart);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await expect(
        executePreparedCliRun(
          buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
        ),
      ).rejects.toThrow();
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      {
        type: "tool.execution.started",
        toolCallId: "call-incomplete",
      },
      {
        type: "tool.execution.error",
        toolCallId: "call-incomplete",
        errorCategory: "cli_tool_incomplete",
      },
    ]);
  });

  it("cancels an outstanding parsed CLI tool when the enclosing run is aborted", async () => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    const abortController = new AbortController();
    const toolStart = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "call-cancelled",
            name: "mcp__openclaw__cron",
            input: {},
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(toolStart);
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "cron",
        args: {},
        isError: true,
        outcome: "unknown",
      });
      abortController.abort();
      return createManagedRun({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.params.abortSignal = abortController.signal;
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).rejects.toThrow("aborted");
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-cancelled" },
      {
        type: "tool.execution.error",
        toolCallId: "call-cancelled",
        errorCategory: "aborted",
        terminalReason: "cancelled",
      },
    ]);
  });

  it.each([
    {
      label: "MCP tool",
      type: "mcp_tool_use",
      toolCallId: "call-timeout",
      name: "mcp__openclaw__cron",
      expected: { terminalReason: "timed_out" },
    },
    {
      label: "server-native tool",
      type: "server_tool_use",
      toolCallId: "call-native-unknown",
      name: "web_search",
      expected: { errorCode: "tool_outcome_unknown" },
    },
  ] as const)("classifies an outstanding parsed $label when the run times out", async (fixture) => {
    const toolEvents: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => toolEvents.push(event));
    const toolStart = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: fixture.type,
            id: fixture.toolCallId,
            name: fixture.name,
            input: {},
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(toolStart);
      if (fixture.type === "mcp_tool_use") {
        recordMcpLoopbackToolCallResult({
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "cron",
          args: {},
          isError: true,
          outcome: "unknown",
        });
      }
      if (fixture.type === "server_tool_use") {
        recordMcpLoopbackToolCallResult({
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "web_search",
          args: {},
          isError: false,
          outcome: "completed",
        });
      }
      return createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 1_000,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      });
    });

    try {
      const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
      context.mcpDeliveryCapture = true;
      await expect(executePreparedCliRun(context)).rejects.toThrow("exceeded timeout");
    } finally {
      stop();
    }

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: fixture.toolCallId },
      {
        type: "tool.execution.error",
        toolCallId: fixture.toolCallId,
        ...fixture.expected,
      },
    ]);
    if (fixture.type === "server_tool_use") {
      expect(toolEvents[1]).not.toHaveProperty("terminalReason");
    }
  });

  it("reports only confirmed message deliveries from correlated JSONL tool events", async () => {
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "message-send-1",
              name: "mcp__openclaw__message",
              input: {
                action: "send",
                channel: "telegram",
                target: "chat123",
                message: "done",
              },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "message-send-1",
              content: [{ type: "text", text: JSON.stringify({ result: { messageId: "msg-1" } }) }],
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { ok: true, to: "spaces/AAA" },
        isError: false,
      });
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;
    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("captures message text aliases from correlated JSONL tool events", async () => {
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "message-send-text-alias",
              name: "mcp__openclaw__message",
              input: {
                action: "send",
                channel: "telegram",
                target: "chat123",
                text: "done",
              },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "message-send-text-alias",
              content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
            },
          ],
        },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.messagingToolSentTexts).toEqual(["done"]);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("bounds pending and committed JSONL message delivery evidence", async () => {
    const starts = Array.from({ length: 65 }, (_, index) => ({
      type: "mcp_tool_use",
      id: `message-send-${index}`,
      name: "mcp__openclaw__message",
      input: {
        action: "send",
        channel: "telegram",
        target: `chat${index}`,
        message: "done",
      },
    }));
    const results = starts.map((start) => ({
      type: "mcp_tool_result",
      tool_use_id: start.id,
      content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
    }));
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [...starts, ...results] },
      })}\n`,
      `${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.messagingToolSentTargets).toHaveLength(64);
    expect(result.messagingToolSentTargets?.[0]?.to).toBe("chat1");
    expect(result.messagingToolSentTargets?.at(-1)?.to).toBe("chat64");
  });

  it("fails closed when an unresolved JSONL message send is evicted", async () => {
    const starts = Array.from({ length: 65 }, (_, index) => ({
      type: "mcp_tool_use",
      id: `message-send-${index}`,
      name: "mcp__openclaw__message",
      input: {
        action: "send",
        channel: "telegram",
        target: `chat${index}`,
        message: "done",
      },
    }));
    const chunks = [
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            ...starts,
            {
              type: "mcp_tool_result",
              tool_use_id: starts[0]?.id,
              content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
            },
          ],
        },
      })}\n`,
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(true);
  });

  it("fails closed when a JSONL message send remains unresolved after exit", async () => {
    const chunk = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "message-send-unresolved",
            name: "mcp__openclaw__message",
            input: {
              action: "send",
              channel: "telegram",
              target: "chat123",
              message: "done",
            },
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(chunk);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(true);
  });

  it("keeps an unresolved JSONL dry-run message retryable", async () => {
    const chunk = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_tool_use",
            id: "message-dry-run-unresolved",
            name: "mcp__openclaw__message",
            input: {
              action: "send",
              channel: "telegram",
              target: "chat123",
              message: "done",
              dryRun: true,
            },
          },
        ],
      },
    })}\n`;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(chunk);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "failed",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBeUndefined();
  });

  it("fails closed for suppressed non-streaming MCP message results", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { status: "suppressed" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBeUndefined();
    expect(result.messagingToolSentTargets).toBeUndefined();
  });

  it("records sessions_yield through the serialized MCP capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureHandle = markMcpLoopbackRequestStarted(input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
      await resolveMcpLoopbackYieldContext(captureHandle)?.onYield("waiting on subagents");
      markMcpLoopbackRequestFinished(captureHandle);
      input.onStdout?.("yield acknowledged");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.yielded).toBe(true);
  });

  it("keeps mutation delivery out of sent-reply dedupe evidence", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "edit",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toBeUndefined();
    expect(result.messagingToolSentTargets).toBeUndefined();
  });

  it("preserves the current provider for implicit message send targets", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "slack";
    context.params.currentChannelId = "C123";
    context.params.currentThreadTs = "1700000000.000100";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          target: "C123",
          message: "done",
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        provider: "slack",
        to: "C123",
      }),
    ]);
  });

  it("preserves partial delivery evidence from unknown MCP message outcomes", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
          mediaUrl: "https://example.com/photo.png",
        },
        result: Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
        isError: true,
        outcome: "unknown",
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
        mediaUrls: ["https://example.com/photo.png"],
      }),
    ]);
  });

  it("reports confirmed non-streaming MCP message results from the serialized capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { result: { messageId: "msg-1" } },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
        text: "done",
      }),
    ]);
  });

  it("reports confirmed poll delivery from the serialized capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "poll",
          channel: "telegram",
          target: "chat123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        result: { pollId: "poll-1" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it.each([
    {
      action: "reply",
      args: {
        action: "reply",
        channel: "telegram",
        target: "chat123",
        message: "done",
      },
    },
    {
      action: "sticker",
      args: {
        action: "sticker",
        channel: "telegram",
        target: "chat123",
        stickerId: "sticker-1",
      },
    },
  ] as const)("records target evidence for confirmed $action delivery", async ({ args }) => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args,
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toBeUndefined();
    expect(result.messagingToolSentMediaUrls).toBeUndefined();
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("records target evidence for confirmed conversation creation", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "thread-create",
          channel: "telegram",
          target: "chat123",
          message: "new thread",
        },
        result: { ok: true, thread: { id: "thread-1" } },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("records current-target evidence for confirmed implicit reply delivery", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "telegram";
    context.params.currentChannelId = "chat123";
    supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
      const input = spawnArgs[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "reply",
          message: "done",
        },
        result: { ok: true },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);
  });

  it("preserves text and media evidence for confirmed implicit message sends", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "implicit reply",
          mediaUrl: "https://example.com/implicit.png",
        },
        result: {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: {
              text: "implicit reply",
              mediaUrl: "https://example.com/implicit.png",
            },
          },
        },
        isError: false,
      });
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "implicit reply",
          mediaUrl: "https://example.com/implicit.png",
        },
        result: {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: {
              text: "implicit reply",
              mediaUrl: "https://example.com/implicit.png",
            },
          },
        },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["implicit reply"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["https://example.com/implicit.png"]);
    expect(result.messagingToolSentTargets).toBeUndefined();
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "implicit reply",
        mediaUrl: "https://example.com/implicit.png",
      },
      {
        text: "implicit reply",
        mediaUrl: "https://example.com/implicit.png",
      },
    ]);
  });

  it("retains confirmed delivery for long non-streaming message calls", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      recordMcpLoopbackToolCallResult({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "x".repeat(20 * 1024),
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({ tool: "message", provider: "telegram", to: "chat123" }),
    ]);
  });

  it("deactivates a Claude live capture when process startup fails", async () => {
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;
    context.preparedBackend.backend.liveSession = "claude-stdio";
    const activateCapture = vi.fn<(captureKey: string) => void>();
    const deactivateCapture = vi.fn<(captureKey: string) => void>();
    context.preparedBackend.mcpClientGrantCapture = {
      activate: activateCapture,
      deactivate: deactivateCapture,
    };
    supervisorSpawnMock.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(executePreparedCliRun(context)).rejects.toThrow("spawn failed");

    expect(activateCapture).toHaveBeenCalledOnce();
    expect(deactivateCapture).toHaveBeenCalledExactlyOnceWith(activateCapture.mock.calls[0]?.[0]);
    expect(activateCapture.mock.invocationCallOrder[0]).toBeLessThan(
      supervisorSpawnMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("captures non-Claude JSONL sends and fences every attempt with a unique key", async () => {
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    const activateCapture = vi.fn<(captureKey: string) => void>();
    const deactivateCapture = vi.fn<(captureKey: string) => void>();
    context.preparedBackend.mcpClientGrantCapture = {
      activate: activateCapture,
      deactivate: deactivateCapture,
    };
    const captureKeys: string[] = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      captureKeys.push(captureKey);
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
        },
        result: { status: "sent" },
        isError: false,
      });
      input.onStdout?.(`${JSON.stringify({ item: { type: "message", text: "done" } })}\n`);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const first = await executePreparedCliRun(context);
    const second = await executePreparedCliRun(context);

    expect(first.didSendViaMessagingTool).toBe(true);
    expect(second.didSendViaMessagingTool).toBe(true);
    expect(captureKeys).toHaveLength(2);
    expect(captureKeys[0]).not.toBe(captureKeys[1]);
    expect(activateCapture.mock.calls.map(([captureKey]) => captureKey)).toEqual(captureKeys);
    expect(deactivateCapture.mock.calls.map(([captureKey]) => captureKey)).toEqual(captureKeys);
    expect(deactivateCapture.mock.invocationCallOrder[0]).toBeLessThan(
      activateCapture.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
  });
});
