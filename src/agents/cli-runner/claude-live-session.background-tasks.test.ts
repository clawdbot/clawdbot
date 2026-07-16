/** Claude live session: interim result while native background subagents run. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { runClaudeLiveSessionTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { setCliRunnerExecuteTestDeps } from "./execute.test-support.js";
import { writeCliSystemPromptFile } from "./helpers.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("../../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
});

function buildPreparedCliRunContext(params: {
  runId: string;
  timeoutMs?: number;
  sessionId?: string;
  sessionKey?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always" as const,
    systemPromptFileArg: "--append-system-prompt-file",
    systemPromptWhen: "first" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
  };
  return {
    params: {
      sessionId: params.sessionId ?? "s-bg",
      sessionKey: params.sessionKey ?? "agent:main:bg",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: params.timeoutMs ?? 60_000,
      runId: params.runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: true,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

function installLiveStdoutDriver(params?: {
  onWrite?: (stdout: (chunk: string) => void) => void;
}): {
  cancel: ReturnType<typeof vi.fn>;
  stdout: { emit: (chunk: string) => void; waitReady: () => Promise<void> };
} {
  let stdoutListener: ((chunk: string) => void) | undefined;
  const cancel = vi.fn();
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const stdin = {
    write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
      if (stdoutListener && params?.onWrite) {
        params.onWrite(stdoutListener);
      }
      cb?.();
      markReady?.();
    }),
    end: vi.fn(),
  };
  supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
    const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
    stdoutListener = input.onStdout;
    return {
      runId: "live-bg-run",
      pid: 4242,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel,
    };
  });
  return {
    cancel,
    stdout: {
      emit: (chunk: string) => {
        stdoutListener?.(chunk);
      },
      waitReady: () => ready,
    },
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function startLiveTurn(params: { runId: string; timeoutMs?: number; noOutputTimeoutMs?: number }) {
  const context = buildPreparedCliRunContext({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
  });
  return runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume: false,
    noOutputTimeoutMs: params.noOutputTimeoutMs ?? 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    cleanup: async () => {},
  });
}

describe("claude live session background tasks", () => {
  it.each([
    { taskType: "local_agent", label: "subagent" },
    { taskType: "local_workflow", label: "workflow" },
  ] as const)(
    "defers the interim success result until $taskType ($label) tasks drain",
    async ({ taskType }) => {
      const driver = installLiveStdoutDriver();
      const resultPromise = startLiveTurn({ runId: `run-bg-interim-${taskType}` });
      await driver.stdout.waitReady();

      // Tool spawn + authoritative outstanding-task list + immediate tool_result.
      driver.stdout.emit(
        jsonl([
          { type: "system", subtype: "init", session_id: "live-bg" },
          {
            type: "assistant",
            session_id: "live-bg",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-agent-1",
                  name: "Agent",
                  input: { description: "research topic", prompt: "do work" },
                },
              ],
            },
          },
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "task-1", task_type: taskType, description: "research topic" }],
          },
          {
            type: "system",
            subtype: "task_started",
            task_id: "task-1",
            tool_use_id: "tool-agent-1",
            subagent_type: "general-purpose",
          },
          {
            type: "user",
            session_id: "live-bg",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-agent-1",
                  content: "Background agent started",
                },
              ],
            },
          },
          {
            type: "assistant",
            session_id: "live-bg",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Working on it in the background." }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "live-bg",
            result: "Working on it in the background.",
            stop_reason: "end_turn",
          },
        ]),
      );

      // Interim result must not resolve while a result-holding task is outstanding.
      let settled = false;
      void resultPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(driver.cancel).not.toHaveBeenCalled();
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:bg" }).lastProgressReason,
      ).toBe("cli_live:result_deferred_background_tasks");

      driver.stdout.emit(
        jsonl([
          {
            type: "system",
            subtype: "task_notification",
            task_id: "task-1",
            status: "completed",
            summary: "subagent final output",
          },
          { type: "system", subtype: "background_tasks_changed", tasks: [] },
          {
            type: "system",
            subtype: "task_updated",
            patch: { status: "completed" },
          },
          { type: "system", subtype: "init", session_id: "live-bg" },
          {
            type: "assistant",
            session_id: "live-bg",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Subagent finished: subagent final output" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "live-bg",
            result: "Subagent finished: subagent final output",
            origin: { kind: "task-notification" },
          },
        ]),
      );

      const result = await resultPromise;
      expect(result.output.text).toContain("Working on it in the background.");
      expect(result.output.text).toContain("Subagent finished: subagent final output");
      expect(driver.cancel).not.toHaveBeenCalled();
    },
  );

  it("does not defer a success result for local_bash background tasks", async () => {
    const driver = installLiveStdoutDriver({
      onWrite: (stdout) => {
        stdout(
          jsonl([
            { type: "system", subtype: "init", session_id: "live-bg-bash" },
            {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [
                {
                  task_id: "bash-1",
                  task_type: "local_bash",
                  description: "background shell",
                },
              ],
            },
            {
              type: "result",
              subtype: "success",
              session_id: "live-bg-bash",
              result: "started bash in background",
              stop_reason: "end_turn",
            },
          ]),
        );
      },
    });
    const result = await startLiveTurn({ runId: "run-bg-bash" });
    expect(result.output.text).toBe("started bash in background");
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("resolves a single success result immediately when no background tasks are outstanding", async () => {
    const driver = installLiveStdoutDriver({
      onWrite: (stdout) => {
        stdout(
          jsonl([
            { type: "system", subtype: "init", session_id: "live-bg-none" },
            {
              type: "assistant",
              session_id: "live-bg-none",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "plain answer" }],
              },
            },
            {
              type: "result",
              subtype: "success",
              session_id: "live-bg-none",
              result: "plain answer",
            },
          ]),
        );
      },
    });
    const result = await startLiveTurn({ runId: "run-bg-none" });
    expect(result.output.text).toBe("plain answer");
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("fails the turn on an error result even when background tasks are outstanding", async () => {
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn({ runId: "run-bg-error" });
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-bg-err" },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-err", task_type: "local_agent", description: "stuck" }],
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-bg-err",
          result: "agent crashed",
        },
      ]),
    );

    await expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      rawError: expect.stringMatching(/agent crashed/i),
    });
  });

  it("does not no-output-abort while a background task is outstanding within the blocked-tool floor", async () => {
    const driver = installLiveStdoutDriver();
    // Spawn with real timers so async supervisor setup settles, then fake the
    // watchdog clock the same way as the blocked-tool live-session tests.
    const resultPromise = startLiveTurn({
      runId: "run-bg-quiet",
      timeoutMs: 3_600_000,
      noOutputTimeoutMs: 1_000,
    });
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-bg-quiet" },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-quiet", task_type: "local_agent", description: "long work" }],
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-bg-quiet",
          result: "started",
          stop_reason: "end_turn",
        },
      ]),
    );

    await Promise.resolve();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Re-arm the no-output watchdog against the faked clock after the interim result.
    driver.stdout.emit(
      `${JSON.stringify({
        type: "system",
        subtype: "task_progress",
        task_id: "task-quiet",
        description: "still working",
      })}\n`,
    );

    // Past the base no-output window (1s) but inside the blocked-tool floor (15m).
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - 1_000);
    expect(driver.cancel).not.toHaveBeenCalled();

    // Drain tasks and finish while still inside the floor window.
    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "background_tasks_changed", tasks: [] },
        {
          type: "result",
          subtype: "success",
          session_id: "live-bg-quiet",
          result: "done after wait",
          origin: { kind: "task-notification" },
        },
      ]),
    );

    const result = await resultPromise;
    expect(result.output.text).toContain("done after wait");
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("still aborts on overall turn timeout while waiting for a never-finishing background task", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn({
      runId: "run-bg-turn-timeout",
      timeoutMs: 5_000,
      noOutputTimeoutMs: 60_000,
    });
    // Flush microtasks so the mocked supervisor spawn resolves under fake timers.
    await vi.advanceTimersByTimeAsync(0);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-bg-timeout" },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-hang", task_type: "local_agent", description: "never ends" }],
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-bg-timeout",
          result: "started hang",
          stop_reason: "end_turn",
        },
      ]),
    );

    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      message: expect.stringMatching(/exceeded timeout/i),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(driver.cancel).toHaveBeenCalledWith("manual-cancel");
  });
});
