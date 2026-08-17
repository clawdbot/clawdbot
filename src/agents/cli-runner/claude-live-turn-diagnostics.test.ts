/** Claude live turn progress reporting and diagnostic correlation tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  buildClaudeLiveRunContext,
  createClaudeInputStartedEvent,
  expectRejectsWithFields,
  mockClaudeLiveRun,
  type PreparedCliRunContextOverrides,
} from "../cli-runner.test-helpers.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
  resetClaudeLiveSessionsForTest();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
});

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

function startLiveTurn(
  runId: string,
  useResume: boolean,
  options: {
    context?: PreparedCliRunContextOverrides;
    abortSignal?: AbortSignal;
    noOutputTimeoutMs?: number;
    resolveToolResultTerminalOutcome?: (
      delta: import("../cli-output-contracts.js").CliToolResultDelta,
    ) => import("./claude-live-turn.js").ClaudeLiveToolTerminalOutcome | undefined;
  } = {},
) {
  const context = buildClaudeLiveRunContext({
    ...options.context,
    runId,
    timeoutMs: options.context?.timeoutMs ?? 60_000,
    backend: { resumeArgs: ["-p", "--resume", "{sessionId}"] },
  });
  context.params.abortSignal = options.abortSignal;
  return runClaudeTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume,
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    resolveToolResultTerminalOutcome: options.resolveToolResultTerminalOutcome,
    cleanup: async () => {},
  });
}

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
}

describe("Claude live turn progress and diagnostic correlation", () => {
  it("reports Claude live stream progress without timer heartbeats", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    const diagnosticEvents: string[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress" || event.type.startsWith("tool.execution.")) {
        diagnosticEvents.push(event.type);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        emitClaudeInputStarted(stdoutListener, data);
        stdoutListener?.(
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "live-diagnostics",
            }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-diagnostics",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-1",
                    name: "mcp__team__lookup",
                    input: { query: "status" },
                  },
                  {
                    type: "server_tool_use",
                    id: "tool-live-2",
                    name: "web_search",
                    input: { query: "release status" },
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        pid: 3060,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      const resultPromise = startLiveTurn("run-live-diagnostics", false, {
        context: {
          sessionId: "session-live-diagnostics",
          sessionKey: "agent:main:diagnostics",
          prompt: "hello",
          timeoutMs: 120_000,
        },
        noOutputTimeoutMs: 120_000,
      });

      await waitForDiagnosticEventsDrained();
      await vi.waitFor(() =>
        expect(
          getDiagnosticSessionActivitySnapshot({
            sessionKey: "agent:main:diagnostics",
          }).activeToolName,
        ).toBe("mcp__team__lookup"),
      );
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");

      await vi.advanceTimersByTimeAsync(10_000);
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressAgeMs,
      ).toBeGreaterThanOrEqual(10_000);

      stdoutListener?.(
        [
          JSON.stringify({
            type: "user",
            session_id: "live-diagnostics",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-1",
                  content: "lookup failed",
                  is_error: true,
                },
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-2",
                  content: "done",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "live-diagnostics",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "live-diagnostics",
            result: "ok",
          }),
        ].join("\n") + "\n",
      );

      await expect(resultPromise).resolves.toMatchObject({ output: { text: "ok" } });
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .activeToolName,
      ).toBeUndefined();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:result");
      expect(diagnosticEvents.filter((event) => event === "tool.execution.started")).toHaveLength(
        2,
      );
      expect(diagnosticEvents).toContain("tool.execution.completed");
      expect(diagnosticEvents).toContain("tool.execution.error");
    } finally {
      stopDiagnostics();
    }
  });

  it("keeps identical parallel Claude live tool outcomes explicitly unknown", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        typeof event.toolCallId === "string" &&
        event.toolCallId.startsWith("tool-live-identical-")
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-identical" },
        {
          type: "assistant",
          session_id: "live-identical",
          message: {
            role: "assistant",
            content: [
              {
                type: "mcp_tool_use",
                id: "tool-live-identical-a",
                name: "mcp__openclaw__message",
                input: { action: "react", emoji: "same" },
              },
              {
                type: "mcp_tool_use",
                id: "tool-live-identical-b",
                name: "mcp__openclaw__message",
                input: { action: "react", emoji: "same" },
              },
            ],
          },
        },
        {
          type: "user",
          session_id: "live-identical",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-live-identical-a", content: "ok" },
              { type: "tool_result", tool_use_id: "tool-live-identical-b", content: "ok" },
            ],
          },
        },
        { type: "result", session_id: "live-identical", result: "ok" },
      ],
    });

    try {
      await expect(
        startLiveTurn("run-live-identical", false, {
          context: {
            sessionId: "session-live-identical",
            sessionKey: "agent:main:live-identical",
            prompt: "hello",
          },
          resolveToolResultTerminalOutcome: () => ({ outcome: "unknown" }),
        }),
      ).resolves.toMatchObject({ output: { text: "ok" } });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-identical-a" },
      { type: "tool.execution.started", toolCallId: "tool-live-identical-b" },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-a",
        errorCode: "tool_outcome_unknown",
      },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-b",
        errorCode: "tool_outcome_unknown",
      },
    ]);
  });

  it.each([
    [
      "client timeout",
      "tool_use",
      "Bash",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { terminalReason: "timed_out" },
    ],
    [
      "client cancellation",
      "tool_use",
      "Bash",
      new Error("operator cancelled"),
      "AbortError",
      { terminalReason: "cancelled" },
    ],
    [
      "server-native timeout",
      "server_tool_use",
      "web_search",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { errorCode: "tool_outcome_unknown" },
    ],
    [
      "server-native cancellation",
      "server_tool_use",
      "web_search",
      new Error("operator cancelled"),
      "AbortError",
      { errorCode: "tool_outcome_unknown" },
    ],
  ] as const)(
    "classifies active Claude live tools on %s",
    async (_, toolType, toolName, abortReason, expectedErrorName, expectedOutcome) => {
      const abortController = new AbortController();
      const diagnosticEvents: Array<Record<string, unknown>> = [];
      const stopDiagnostics = onInternalDiagnosticEvent((event) => {
        if (event.type === "tool.execution.error") {
          diagnosticEvents.push(event as unknown as Record<string, unknown>);
        }
      });
      let stdoutListener: ((chunk: string) => void) | undefined;
      const stdin = {
        write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
          emitClaudeInputStarted(stdoutListener, data);
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-timeout" }),
              JSON.stringify({
                type: "assistant",
                session_id: "live-timeout",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: toolType,
                      id: "tool-live-timeout",
                      name: toolName,
                      input: { query: "status" },
                    },
                  ],
                },
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
        const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
        stdoutListener = input.onStdout;
        return {
          pid: 3061,
          startedAtMs: Date.now(),
          stdin,
          wait: vi.fn(() => new Promise(() => {})),
          cancel: vi.fn(),
        };
      });

      try {
        const resultPromise = startLiveTurn("run-live-timeout", false, {
          context: {
            sessionId: "session-live-timeout",
            sessionKey: "agent:main:timeout",
          },
          abortSignal: abortController.signal,
          noOutputTimeoutMs: 120_000,
        });

        await vi.waitFor(() => expect(stdoutListener).toBeDefined());
        abortController.abort(abortReason);
        await expectRejectsWithFields(resultPromise, { name: expectedErrorName });
        await waitForDiagnosticEventsDrained();
        expect(diagnosticEvents).toContainEqual(
          expect.objectContaining({
            toolCallId: "tool-live-timeout",
            ...expectedOutcome,
          }),
        );
        if (toolType === "server_tool_use") {
          const terminal = diagnosticEvents.find(
            (event) => event.toolCallId === "tool-live-timeout",
          );
          expect(terminal).not.toHaveProperty("terminalReason");
        }
      } finally {
        stopDiagnostics();
      }
    },
  );
});

describe("Claude live turn progress timeout cleanup", () => {
  it("fails Claude live turns without unhandled rejection when stdin write is stuck", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const cancel = vi.fn();
    let pendingWriteCallback: ((err?: Error | null) => void) | undefined;
    const stdin = {
      write: vi.fn((_dataValue: string, cb?: (err?: Error | null) => void) => {
        pendingWriteCallback = cb;
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      pid: 2345,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn((reason: string) => {
        cancel(reason);
        pendingWriteCallback?.(new Error("stdin closed"));
      }),
    }));

    try {
      const run = startLiveTurn("run-live-stuck-write", false, {
        context: { timeoutMs: 10_000 },
        noOutputTimeoutMs: 1_000,
      });
      const runExpectation = expectRejectsWithFields(run, {
        name: "FailoverError",
        message: "CLI produced no output for 1s and was terminated.",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await runExpectation;
      await Promise.resolve();
      expect(unhandledRejections).toEqual([]);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(stdin.write).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
