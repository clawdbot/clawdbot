import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  buildClaudeControlRequestEvents,
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  createClaudeInputStartedEvent,
  expectClaudeControlDecision,
  expectPathMissing,
  expectRejectsWithFields,
  mockClaudeLiveRun,
  requireArgAfter,
  withTempExecApprovalsState,
  withTempOpenClawHome,
  type PreparedCliRunContextOverrides,
} from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { callGatewayTool } from "../tools/gateway.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("../../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
}

type ClaudeControlPolicyTestCase = {
  name: string;
  requestId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  expected: {
    behavior: "allow" | "deny";
    messageIncludes?: string;
    updatedInput?: Record<string, unknown>;
  };
  context?: PreparedCliRunContextOverrides;
  approvals?: Record<string, unknown>;
  expectedPermissionMode?: string;
};

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
  mockCallGatewayTool.mockReset();
  mockCallGatewayTool.mockResolvedValue({ id: "claude-native-approval", decision: "deny" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClaudeLiveSessionsForTest();
});

describe("Claude live configured exec policy", () => {
  it("uses the configured default agent for an unscoped legacy session key", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        if (data.includes('"control_response"')) {
          return;
        }
        emit(
          buildClaudeControlRequestEvents({
            requestId: "req-default-agent",
            toolUseId: "tool-default-agent",
            toolName: "Bash",
            input: { command: "pwd" },
            sessionId: "live-default-agent",
          }),
        );
      },
    });
    const context = buildClaudeLiveRunContext({
      sessionKey: "main",
      config: {
        tools: { exec: { security: "full", ask: "off" } },
        agents: {
          entries: {
            main: {},
            ops: { default: true, tools: { exec: { security: "deny", ask: "always" } } },
          },
        },
      } as unknown as PreparedCliRunContext["params"]["config"],
    });

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-default-agent",
      messageIncludes: "security=deny",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});

describe("Claude live process", () => {
  it("refreshes a reused Claude live session when only dynamic prompt context changes", async () => {
    let userTurn = 0;
    let controlRequest = 0;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        const parsed = JSON.parse(data) as {
          type: string;
          request_id?: string;
          request?: { subtype?: string; model?: string; system_prompt?: string };
        };
        if (parsed.type === "control_request") {
          controlRequest += 1;
          if (controlRequest === 1) {
            expect(parsed.request).toEqual({
              subtype: "set_model",
              model: "sonnet",
              system_prompt: "",
            });
            emit([
              {
                type: "control_response",
                response: {
                  subtype: "error",
                  request_id: parsed.request_id,
                  error: "set_model: system_prompt must be a non-empty string when present",
                },
              },
            ]);
            return;
          }
          expect(parsed.request).toEqual({
            subtype: "set_model",
            model: "sonnet",
            system_prompt:
              "# OpenClaw\n\n## Stable Instructions\nKeep the operator informed.\nSecond-turn metadata",
          });
          emit([
            {
              type: "control_response",
              response: { subtype: "success", request_id: parsed.request_id },
            },
          ]);
          return;
        }
        userTurn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-dynamic-prompt" },
          {
            type: "result",
            session_id: "live-dynamic-prompt",
            result: userTurn === 1 ? "one" : "two",
          },
        ]);
      },
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "always" as const,
    };

    const first = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        prompt: "first",
        systemPrompt: `# OpenClaw\n\n## Stable Instructions\nKeep the operator informed.${SYSTEM_PROMPT_CACHE_BOUNDARY}First-turn metadata`,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        prompt: "second",
        systemPrompt: `# OpenClaw\n\n## Stable Instructions\nKeep the operator informed.${SYSTEM_PROMPT_CACHE_BOUNDARY}Second-turn metadata`,
      }),
      "live-dynamic-prompt",
    );

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    expect(live.writes.map((entry) => JSON.parse(entry).type)).toEqual([
      "user",
      "control_request",
      "control_request",
      "user",
    ]);
  });

  it("answers Claude live control_request can_use_tool with deny when the user rejects approval", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-deny-1"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    const controlEvents = buildClaudeControlRequestEvents({
      requestId: "req-deny",
      toolUseId: "tool-deny-1",
      input: { command: "rm -rf /" },
      sessionId: "live-control-deny",
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit, writeIndex }) => {
        if (writeIndex === 0) {
          emit(controlEvents.slice(0, 2));
          return;
        }
        if (!data.includes('"control_response"')) {
          return;
        }
        emit([
          {
            type: "assistant",
            session_id: "live-control-deny",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-deny-1",
                  name: "Bash",
                  input: { command: "rm -rf /" },
                },
              ],
            },
          },
          {
            type: "user",
            session_id: "live-control-deny",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-deny-1",
                  content: "denied",
                  is_error: true,
                },
              ],
            },
          },
          { type: "result", session_id: "live-control-deny", result: "ok" },
        ]);
      },
      pid: 3002,
    });

    let result;
    try {
      result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "hello",
          config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        }),
      );
      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }
    expect(result.text).toBe("ok");
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-deny",
      messageIncludes: "OpenClaw user denied Claude native tool use (Bash).",
    });
    expect(diagnosticEvents).toMatchObject([
      {
        type: "tool.execution.started",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        paramsSummary: { kind: "object" },
      },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        deniedReason: "cli_live_exec_policy",
      },
    ]);
    expect(diagnosticEvents).toHaveLength(2);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("rm -rf");
    expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe("default");
  });

  it("reuses a Claude native tool allow-always grant within the live process", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-allow-always",
      decision: "allow-always",
    });
    let promptCount = 0;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        if (data.includes('"control_response"')) {
          return;
        }
        promptCount += 1;
        emit(
          buildClaudeControlRequestEvents({
            requestId: `req-grant-${promptCount}`,
            toolUseId: `tool-grant-${promptCount}`,
            toolName: "Write",
            input: {
              file_path: `/tmp/grant-${promptCount}.txt`,
              content: `content ${promptCount}`,
            },
            sessionId: "live-control-allow-always",
          }),
        );
      },
      pid: 3012,
    });
    const buildContext = (runId: string, prompt: string) =>
      buildClaudeLiveRunContext({
        runId,
        prompt,
        sessionId: "session-allow-always",
        sessionKey: "agent:main:allow-always",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      });

    await expect(
      executePreparedCliRun(buildContext("run-grant-1", "first")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(1),
    );
    await expect(
      executePreparedCliRun(buildContext("run-grant-2", "second")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(2),
    );

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-grant-1",
      toolUseId: "tool-grant-1",
      updatedInput: { file_path: "/tmp/grant-1.txt", content: "content 1" },
    });
    const secondResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-grant-2"),
    );
    expect(secondResponse).toContain('"behavior":"allow"');
  });

  it("prompts on every Claude native tool request when exec ask is always", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-always-seed",
      decision: "allow-always",
    });
    let promptCount = 0;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        if (data.includes('"control_response"')) {
          return;
        }
        promptCount += 1;
        emit(
          buildClaudeControlRequestEvents({
            requestId: `req-always-${promptCount}`,
            toolUseId: `tool-always-${promptCount}`,
            toolName: "Write",
            input: {
              file_path: `/tmp/always-${promptCount}.txt`,
              content: `content ${promptCount}`,
            },
            sessionId: "live-control-ask-always",
          }),
        );
      },
      pid: 3015,
    });
    const buildContext = (runId: string, prompt: string, ask: "always" | "on-miss") =>
      buildClaudeLiveRunContext({
        runId,
        prompt,
        sessionId: "session-ask-always",
        sessionKey: "agent:main:ask-always",
        sessionEntry: { execAsk: ask } as PreparedCliRunContext["params"]["sessionEntry"],
        config: { tools: { exec: { security: "full", ask: "on-miss" } } },
      });

    await expect(
      executePreparedCliRun(buildContext("run-always-seed", "seed", "on-miss")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(1),
    );
    mockCallGatewayTool.mockClear();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "claude-native-always-1", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "claude-native-always-2", decision: "allow-once" });

    await expect(
      executePreparedCliRun(buildContext("run-always-1", "first", "always")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(2),
    );
    await expect(
      executePreparedCliRun(buildContext("run-always-2", "second", "always")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(3),
    );

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
    for (const call of mockCallGatewayTool.mock.calls) {
      expect(call[2]).toMatchObject({ allowedDecisions: ["allow-once", "deny"] });
    }
    const firstResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-always-2"),
    );
    const secondResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-always-3"),
    );
    expect(firstResponse).toContain('"behavior":"allow"');
    expect(secondResponse).toContain('"behavior":"allow"');
  });

  it("does not create exec approvals file while resolving Claude live policy", async () => {
    await withTempOpenClawHome(async (home) => {
      const approvalsPath = path.join(home, ".openclaw", "exec-approvals.json");
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: [
          { type: "system", subtype: "init", session_id: "live-no-approvals-file" },
          { type: "result", session_id: "live-no-approvals-file", result: "ok" },
        ],
        pid: 3009,
      });

      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "hello",
          config: {
            tools: { exec: { security: "allowlist", ask: "on-miss" } },
          } as PreparedCliRunContext["params"]["config"],
        }),
      );

      expect(result.text).toBe("ok");
      expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe("default");
      await expectPathMissing(approvalsPath);
    });
  });

  it.each<ClaudeControlPolicyTestCase>([
    {
      name: "allows tools when no exec policy is configured (default deployment)",
      requestId: "req-default-allow",
      toolUseId: "tool-default-allow-1",
      input: { command: "echo hi" },
      expected: { behavior: "allow", updatedInput: { command: "echo hi" } },
    },
    {
      name: "denies tools when approval defaults are restrictive",
      requestId: "req-approval-default-deny",
      toolUseId: "tool-approval-default-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "OpenClaw user denied" },
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when session exec ask is restrictive",
      requestId: "req-session-ask-deny",
      toolUseId: "tool-session-ask-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "OpenClaw user denied" },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        sessionEntry: { execAsk: "always" } as PreparedCliRunContext["params"]["sessionEntry"],
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when agent approvals are restrictive",
      requestId: "req-agent-approval-deny",
      toolUseId: "tool-agent-approval-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "security=deny" },
      approvals: { version: 1, agents: { reviewer: { security: "deny" } } },
      context: {
        agentId: "reviewer",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when session-key agent approvals are restrictive",
      requestId: "req-session-key-approval-deny",
      toolUseId: "tool-session-key-approval-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "security=deny" },
      approvals: { version: 1, agents: { reviewer: { security: "deny" } } },
      context: {
        sessionKey: "agent:reviewer:main",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "allows tools when OpenClaw exec is YOLO despite raw --permission-mode default",
      requestId: "req-permmode-allow",
      toolUseId: "tool-permmode-allow-1",
      input: { command: "ls" },
      expected: { behavior: "allow" },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "default"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
    },
  ])("answers Claude live control_request can_use_tool: $name", async (testCase) => {
    const run = async () => {
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: buildClaudeControlRequestEvents({
          requestId: testCase.requestId,
          toolUseId: testCase.toolUseId,
          input: testCase.input,
          sessionId: `live-control-${testCase.requestId}`,
        }),
      });
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({ ...testCase.context }),
      );

      expect(result.text).toBe("ok");
      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      expectClaudeControlDecision(live, {
        ...testCase.expected,
        requestId: testCase.requestId,
        ...(testCase.expected.behavior === "allow" ? { toolUseId: testCase.toolUseId } : {}),
      });
      if (testCase.expectedPermissionMode) {
        expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe(
          testCase.expectedPermissionMode,
        );
      }
    };

    if (testCase.approvals) {
      await withTempExecApprovalsState(testCase.approvals, run);
    } else {
      await run();
    }
  });

  it("cleans live-turn resources when capture activation fails before spawn", async () => {
    const cleanup = vi.fn(async () => undefined);
    const context = buildPreparedCliRunContext({ mcpDeliveryCapture: true });

    await expect(
      runClaudeTurn({
        context,
        args: [],
        env: {},
        prompt: "hi",
        useResume: false,
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        onMcpCaptureReady: () => {
          throw new Error("grant activation failed");
        },
        cleanup,
      }),
    ).rejects.toThrow("grant activation failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });

  it("uses a fresh Claude live process and capture key for every captured turn", async () => {
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const captureKeys: string[] = [];
    const turnResults = ["first-ok", "resume-ok", "env-ok", "fresh-ok"];
    let turnIndex = 0;
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      let resolveExit: (() => void) | undefined;
      const exited = new Promise<{
        reason: "manual-cancel";
        exitCode: null;
        exitSignal: null;
        durationMs: number;
        stdout: string;
        stderr: string;
        timedOut: false;
        noOutputTimedOut: false;
      }>((resolve) => {
        resolveExit = () =>
          resolve({
            reason: "manual-cancel",
            exitCode: null,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          });
      });
      cancel.mockImplementation(() => resolveExit?.());
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
            emitClaudeInputStarted(input.onStdout, dataValue);
            const result = turnResults[turnIndex] ?? "ok";
            turnIndex += 1;
            input.onStdout?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-session" }),
                JSON.stringify({ type: "result", session_id: "live-session", result }),
              ].join("\n") + "\n",
            );
            cb?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn(() => exited),
        cancel,
      };
    });
    const runTurn = async (runId: string, args: string[], env: Record<string, string>) => {
      const context = buildClaudeLiveRunContext({
        runId,
        backend: {
          resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
        },
        mcpDeliveryCapture: true,
      });
      const result = await runClaudeTurn({
        context,
        args,
        env,
        prompt: "hi",
        useResume: args.some((entry) => entry.startsWith("--resume")),
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        onMcpCaptureReady: (captureKey) => captureKeys.push(captureKey),
        cleanup: async () => {
          if (runId === "run-live-resume") {
            throw new Error("captured cleanup failed");
          }
        },
      });
      return result.output.text;
    };
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(
      runTurn("run-live-fresh", freshArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("first-ok");
    await expect(
      runTurn("run-live-resume", resumeArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("resume-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    expect(cancels[1]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[1]).not.toBe(captureKeys[0]);

    await expect(
      runTurn("run-live-env-change", resumeArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("env-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(cancels[2]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[2]).not.toBe(captureKeys[1]);

    await expect(
      runTurn("run-live-fresh-retry", freshArgs, {
        ANTHROPIC_BASE_URL: "https://two.example",
      }),
    ).resolves.toBe("fresh-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(4);
    expect(cancels[3]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[3]).not.toBe(captureKeys[2]);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Claude live session cleanup failed: captured cleanup failed"),
    );
  });

  it.each([
    {
      name: "marks Claude live stderr context overflows as retryable",
      exitCode: 1,
      stderr: "Prompt is too long",
      events: [{ type: "system", subtype: "init", session_id: "live-overflow" }],
      expected: {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
        status: 413,
      },
    },
    {
      name: "marks quiet Claude live exit-zero turns as retryable empty responses",
      exitCode: 0,
      stderr: "",
      events: [],
      expected: {
        name: "FailoverError",
        reason: "empty_response",
        code: "cli_unknown_empty_failure",
      },
    },
    {
      name: "preserves Claude live stderr classification on exit-zero failures",
      exitCode: 0,
      stderr: "Prompt is too long",
      events: [],
      expected: {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
      },
    },
  ])("$name", async (testCase) => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: testCase.events,
      inputLifecycle: testCase.events.length > 0,
      exitOnWrite: {
        reason: "exit",
        exitCode: testCase.exitCode,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: testCase.stderr,
        timedOut: false,
        noOutputTimedOut: false,
      },
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } }),
      ),
      testCase.expected,
    );
  });

  it("fails when Claude exits before a live turn starts", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      exitImmediately: {
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "startup failed",
        timedOut: false,
        noOutputTimedOut: false,
      },
    });

    await expect(executePreparedCliRun(buildClaudeLiveRunContext())).rejects.toThrow(
      "Claude CLI live session closed before handling the turn",
    );
  });

  it("does not surface stale stderr after a later Claude live exit", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let stderrListener: ((chunk: string) => void) | undefined;
    let resolveExit:
      | ((value: {
          reason: "exit";
          exitCode: number;
          exitSignal: null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: false;
          noOutputTimedOut: false;
        }) => void)
      | undefined;
    const wait = new Promise<{
      reason: "exit";
      exitCode: number;
      exitSignal: null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: false;
      noOutputTimedOut: false;
    }>((resolve) => {
      resolveExit = resolve;
    });
    let writeCount = 0;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        emitClaudeInputStarted(stdoutListener, dataValue);
        writeCount += 1;
        if (writeCount === 1) {
          stderrListener?.("stale stderr from first turn");
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-stderr" }),
              JSON.stringify({
                type: "result",
                session_id: "live-stderr",
                result: "first-ok",
              }),
            ].join("\n") + "\n",
          );
          cb?.();
          return;
        }
        cb?.();
        if (!resolveExit) {
          throw new Error("Expected Claude live exit resolver to be initialized");
        }
        resolveExit({
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 50,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      stderrListener = input.onStderr;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => wait),
        cancel: vi.fn(),
      };
    });

    const first = await executePreparedCliRun(buildClaudeLiveRunContext({ prompt: "first" }));
    const second = executePreparedCliRun(buildClaudeLiveRunContext({ prompt: "second" }));

    expect(first.text).toBe("first-ok");
    await expectRejectsWithFields(second, {
      name: "FailoverError",
      message: "Claude CLI failed.",
    });
  });
});
