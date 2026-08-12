import fs from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { RunExit } from "../../process/supervisor/types.js";
import {
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  createClaudeInputStartedEvent,
  mockCallArg,
  mockClaudeLiveRun,
} from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import {
  buildClaudeOwnerKey,
  closeClaudeSession,
  getClaudeGeneration,
} from "./claude-live-registry.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { setCliRunnerExecuteTestDeps } from "./execute.test-support.js";
import { writeCliSystemPromptFile } from "./helpers.js";
import { cliBackendLog } from "./log.js";

vi.mock("../../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetAgentEventsForTest();
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
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

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
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

describe("buildClaudeOwnerKey", () => {
  it("is deterministic and distinguishes session keys", () => {
    const base = {
      agentAccountId: "acct-1",
      agentId: "agent-main",
      authProfileId: "profile-a",
      sessionId: "sess-1",
      sessionKey: "key-a",
    };
    const a1 = buildClaudeOwnerKey(base);
    const a2 = buildClaudeOwnerKey(base);
    expect(a1).toBe(a2);
    expect(buildClaudeOwnerKey({ ...base, sessionKey: "key-b" })).not.toBe(a1);
  });

  it("keeps queue and live-session owner hashes byte-identical", () => {
    expect(
      buildClaudeOwnerKey({
        agentAccountId: "acct-1",
        agentId: "agent-main",
        authProfileId: "profile-a",
        sessionId: "sess-1",
        sessionKey: "key-a",
      }),
    ).toBe("718b9a6cf473526c3c357883dfc8f1da1cf90b709d9ed38d675b52314abe6800");
  });
});

describe("Claude live registry lifecycle", () => {
  it("reuses a Claude live session process across turns", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    const agentEvents: unknown[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.stream === "assistant") {
        agentEvents.push(evt.data);
      }
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        const prompt = (JSON.parse(data) as { message: { content: string } }).message.content;
        const text = prompt === "first" ? "one" : "two";
        emit([
          { type: "system", subtype: "init", session_id: "live-session-1" },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            },
          },
          { type: "result", session_id: "live-session-1", result: text },
        ]);
      },
    });

    try {
      const firstContext = buildClaudeLiveRunContext({
        prompt: "first",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-one.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-one.json",
          ],
        },
        mcpConfigHash: "same-mcp-config",
      });
      const first = await executePreparedCliRun(firstContext);
      const liveGeneration = getClaudeGeneration({
        backendId: "claude-cli",
        sessionId: "s1",
      });
      expect(liveGeneration).toBeDefined();
      const secondContext = buildClaudeLiveRunContext({
        prompt: "second",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-two.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-two.json",
          ],
        },
        mcpConfigHash: "same-mcp-config",
      });
      secondContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      const second = await executePreparedCliRun(secondContext, "live-session-1");

      const changedContext = buildClaudeLiveRunContext({
        model: "opus",
        prompt: "changed",
        backend: {
          args: ["-p"],
          resumeArgs: ["-p", "--resume", "{sessionId}"],
        },
        mcpConfigHash: "same-mcp-config",
      });
      changedContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      await expect(executePreparedCliRun(changedContext, "live-session-1")).rejects.toMatchObject({
        reason: "session_expired",
        code: "cli_live_session_changed",
      });

      const spawnInput = mockCallArg(supervisorSpawnMock) as {
        argv?: string[];
        stdinMode?: string;
      };
      expect(first.text).toBe("one");
      expect(second.text).toBe("two");
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      expect(spawnInput.stdinMode).toBe("pipe-open");
      expect(spawnInput.argv).toContain("--input-format");
      expect(spawnInput.argv).toContain("--output-format");
      expect(spawnInput.argv).toContain("stream-json");
      expect(spawnInput.argv).toContain("--replay-user-messages");
      expect(spawnInput.argv).not.toContain("--session-id");
      expect(spawnInput.argv).toContain("/tmp/mcp-one.json");
      expect(
        live.writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["first", "second"]);
      expect(agentEvents).toEqual([
        { text: "one", delta: "one" },
        { text: "two", delta: "two" },
      ]);
      const turnLogs = logInfoSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith("claude live session turn:"));
      expect(turnLogs).toHaveLength(2);
      expect(turnLogs[0]).toContain("outBytes=3 outHash=7692c3ad3540");
      expect(turnLogs[1]).toContain("outBytes=3 outHash=3fc4ccfe7458");
      expect(turnLogs.join("\n")).not.toContain("one");
      expect(turnLogs.join("\n")).not.toContain("two");
    } finally {
      logInfoSpy.mockRestore();
      stop();
    }
  });

  it("requires the exact warm Claude process even without native resume args", async () => {
    const liveRuns = Array.from({ length: 3 }, () =>
      mockClaudeLiveRun(supervisorSpawnMock, {
        pid: 2346,
        events: [
          { type: "system", subtype: "init", session_id: "live-session-1" },
          { type: "result", session_id: "live-session-1", result: "one" },
        ],
      }),
    );

    const firstContext = buildPreparedCliRunContext({
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(firstContext)).text).toBe("one");
    const liveGeneration = getClaudeGeneration({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(liveGeneration).toBeDefined();

    resetClaudeLiveSessionsForTest();
    const missingContext = buildPreparedCliRunContext({
      prompt: "second",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    missingContext.requiredClaudeLiveSessionGeneration = liveGeneration;

    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });

    const replacementContext = buildPreparedCliRunContext({
      prompt: "replacement",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(replacementContext)).text).toBe("one");
    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    missingContext.openClawHistoryPrompt = "bounded OpenClaw history\n\nsecond";
    expect((await executePreparedCliRun(missingContext)).text).toBe("one");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(
      (JSON.parse(liveRuns[2]?.writes.at(-1) ?? "") as { message: { content: string } }).message
        .content,
    ).toBe("bounded OpenClaw history\n\nsecond");
  });

  it("serializes concurrent Claude live session creation for the same key", async () => {
    let releaseSpawn: (() => void) | undefined;
    let turn = 0;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      beforeSpawn: () => spawnReady,
      onWrite: ({ emit }) => {
        turn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-concurrent" },
          {
            type: "result",
            session_id: "live-concurrent",
            result: turn === 1 ? "one" : "two",
          },
        ]);
      },
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const first = executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "first",
        backend,
      }),
    );
    const second = executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "second",
        backend,
      }),
    );
    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledOnce());
    releaseSpawn?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.text).toSorted()).toEqual(["one", "two"]);
    expect(live.stdin.write).toHaveBeenCalledTimes(2);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("does not register a process whose pending spawn was closed", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnBlocked = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancel = vi.fn();
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      await spawnBlocked;
      return {
        pid: 2349,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((data: string, callback?: (error?: Error | null) => void) => {
            emitClaudeInputStarted(stdoutListener, data);
            stdoutListener?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "closed-spawn" }),
                JSON.stringify({ type: "result", session_id: "closed-spawn", result: "late" }),
              ].join("\n") + "\n",
            );
            callback?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    const context = buildPreparedCliRunContext({
      runId: "run-close-pending-spawn",
      sessionId: "session-close-pending-spawn",
      backend: { liveSession: "claude-stdio" },
    });
    const run = runClaudeTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "hello",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {},
    });

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledOnce());
    expect(
      getClaudeGeneration({ backendId: "claude-cli", sessionId: "session-close-pending-spawn" }),
    ).toBeDefined();
    await closeClaudeSession(context, "restart");
    releaseSpawn?.();

    await expect(run).rejects.toThrow("closed before handling the turn");
    expect(
      getClaudeGeneration({ backendId: "claude-cli", sessionId: "session-close-pending-spawn" }),
    ).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("does not close a replacement spawned while the previous process exits", async () => {
    let resolveOldExit: ((exit: RunExit) => void) | undefined;
    const oldExit = new Promise<RunExit>((resolve) => {
      resolveOldExit = resolve;
    });
    const old = mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "old-session" },
        { type: "result", session_id: "old-session", result: "old" },
      ],
    });
    old.lifecycle.wait.mockImplementation(() => oldExit);

    const context = buildPreparedCliRunContext({
      prompt: "old",
      backend: { liveSession: "claude-stdio" },
    });
    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "old" });

    let releaseReplacementSpawn: (() => void) | undefined;
    const replacementSpawnBlocked = new Promise<void>((resolve) => {
      releaseReplacementSpawn = resolve;
    });
    const replacement = mockClaudeLiveRun(supervisorSpawnMock, {
      beforeSpawn: () => replacementSpawnBlocked,
      events: [
        { type: "system", subtype: "init", session_id: "replacement-session" },
        { type: "result", session_id: "replacement-session", result: "replacement" },
      ],
    });

    const closing = closeClaudeSession(context, "restart");
    await vi.waitFor(() => expect(old.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel"));
    const replacementRun = executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "replacement",
        backend: { liveSession: "claude-stdio" },
      }),
    );
    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(2));

    resolveOldExit?.({
      reason: "manual-cancel",
      exitCode: null,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
    await closing;
    releaseReplacementSpawn?.();

    await expect(replacementRun).resolves.toMatchObject({ text: "replacement" });
    expect(replacement.lifecycle.cancel).not.toHaveBeenCalled();
  });

  it("recovers when a required warm Claude process exits during reuse cleanup", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    let turn = 0;
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        emitClaudeInputStarted(stdoutListener, data);
        turn += 1;
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-race" }),
            JSON.stringify({ type: "result", session_id: "live-race", result: `turn-${turn}` }),
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
        pid: 2350,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => exited),
        cancel: vi.fn(),
      };
    });
    const context = buildPreparedCliRunContext({
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    const first = await runClaudeTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "first",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {},
    });
    expect(first.output.text).toBe("turn-1");
    const generation = getClaudeGeneration({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(generation).toBeDefined();

    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const reuse = runClaudeTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "second",
      useResume: false,
      requiredSessionGeneration: generation,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {
        markCleanupStarted?.();
        await cleanupReleased;
      },
    });
    await cleanupStarted;
    resolveExit?.({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
    await vi.waitFor(() =>
      expect(getClaudeGeneration({ backendId: "claude-cli", sessionId: "s1" })).toBeUndefined(),
    );
    releaseCleanup?.();

    await expect(reuse).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });
    expect(stdin.write).toHaveBeenCalledOnce();
  });

  it("counts pending Claude live session creates against the session cap", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      await spawnReady;
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          emitClaudeInputStarted(input.onStdout, dataValue);
          input.onStdout?.(
            [
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: `live-cap-${spawnIndex}`,
              }),
              JSON.stringify({
                type: "result",
                session_id: `live-cap-${spawnIndex}`,
                result: `ok-${spawnIndex}`,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2300 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const runs = Array.from({ length: 17 }, (_, index) =>
      (() => {
        const context = buildPreparedCliRunContext({
          runId: `run-live-cap-${index}`,
          prompt: `prompt ${index}`,
          sessionId: `session-${index}`,
          backend,
        });
        return runClaudeTurn({
          context,
          args: context.preparedBackend.backend.args ?? [],
          env: {},
          prompt: `prompt ${index}`,
          useResume: false,
          noOutputTimeoutMs: 1_000,
          getProcessSupervisor: getProcessSupervisorForTest,
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });
      })(),
    );
    const rejectedRun = runs[16];
    const rejectedRunExpectation = expect(rejectedRun).rejects.toThrow(
      "Too many Claude CLI live sessions are active.",
    );

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(16));
    await rejectedRunExpectation;
    releaseSpawn?.();
    await expect(Promise.all(runs.slice(0, 16))).resolves.toHaveLength(16);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(16);
  });

  it("reuses the same credential generation and restarts when it rotates", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancel = vi.fn();
    const userInputUuids: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        const parsed = JSON.parse(data) as { type?: string; uuid?: string };
        if (parsed.type === "user" && typeof parsed.uuid === "string") {
          userInputUuids.push(parsed.uuid);
          stdoutListener?.(
            `${JSON.stringify({
              type: "command_lifecycle",
              command_uuid: parsed.uuid,
              state: "started",
            })}\n`,
          );
        }
        stdoutListener?.(
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "live-credential-rotation",
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: "live-credential-rotation",
              result: "done",
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
        runId: `live-credential-${supervisorSpawnMock.mock.calls.length}`,
        pid: 4242,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });
    const runTurn = (runId: string, credentialFingerprint: string) => {
      const context = buildPreparedCliRunContext({
        runId,
        backend: { liveSession: "claude-stdio" },
      });
      context.preparedBackend.secretInput = {
        fd: 3,
        fingerprint: credentialFingerprint,
        createData: () => Buffer.from("secret"),
      };
      return runClaudeTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt: "hi",
        useResume: false,
        noOutputTimeoutMs: 5_000,
        getProcessSupervisor: getProcessSupervisorForTest,
        onAssistantDelta: () => {},
        cleanup: async () => {},
      });
    };

    await runTurn("run-credential-a-first", "credential-a");
    await runTurn("run-credential-a-second", "credential-a");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);

    await runTurn("run-credential-b", "credential-b");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(new Set(userInputUuids).size).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("restarts Claude live sessions when selected skills change", async () => {
    const workspaceDir = tempDirs.make("openclaw-live-skills-");
    const weatherDir = path.join(workspaceDir, "skills", "weather");
    const gitDir = path.join(workspaceDir, "skills", "git");
    await fs.mkdir(weatherDir, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(weatherDir, "SKILL.md"), "weather instructions\n", "utf-8");
    await fs.writeFile(path.join(gitDir, "SKILL.md"), "git instructions\n", "utf-8");

    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          emitClaudeInputStarted(input.onStdout, dataValue);
          const text = spawnIndex === 1 ? "weather-ok" : "git-ok";
          input.onStdout?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: `live-${spawnIndex}` }),
              JSON.stringify({
                type: "result",
                session_id: `live-${spawnIndex}`,
                result: text,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    try {
      const first = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "first",
          workspaceDir,
          skillsSnapshot: {
            prompt: "weather",
            skills: [{ name: "weather" }],
            resolvedSkills: [
              {
                name: "weather",
                description: "Weather instructions.",
                filePath: path.join(weatherDir, "SKILL.md"),
                baseDir: weatherDir,
                source: "test",
                sourceInfo: {
                  path: weatherDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: weatherDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );
      const second = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "second",
          workspaceDir,
          skillsSnapshot: {
            prompt: "git",
            skills: [{ name: "git" }],
            resolvedSkills: [
              {
                name: "git",
                description: "Git instructions.",
                filePath: path.join(gitDir, "SKILL.md"),
                baseDir: gitDir,
                source: "test",
                sourceInfo: {
                  path: gitDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: gitDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );

      expect(first.text).toBe("weather-ok");
      expect(second.text).toBe("git-ok");
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
      expect(cancels[1]).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("closes idle Claude live sessions after ten minutes", async () => {
    vi.useFakeTimers();
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-session-idle" },
        { type: "result", session_id: "live-session-idle", result: "idle-ok" },
      ],
    });

    try {
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "idle",
        }),
      );

      expect(result.text).toBe("idle-ok");
      expect(live.lifecycle.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 - 1);
      expect(live.lifecycle.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(live.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
      expect(
        live.writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("serializes direct live turns before refreshing their system prompts", async () => {
    let userTurn = 0;
    let releaseCapabilityProbe: (() => void) | undefined;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        const parsed = JSON.parse(data) as {
          type: string;
          request_id?: string;
          request?: { system_prompt?: string };
        };
        if (parsed.type === "control_request") {
          if (parsed.request?.system_prompt === "") {
            releaseCapabilityProbe = () => {
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
            };
            return;
          }
          emit([
            {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: parsed.request_id,
              },
            },
          ]);
          return;
        }
        userTurn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-serialized-refresh" },
          {
            type: "result",
            session_id: "live-serialized-refresh",
            result: `turn-${userTurn}`,
          },
        ]);
      },
    });
    const backend = {
      args: ["-p", "--output-format", "stream-json"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "always" as const,
    };
    const getSerializedProcessSupervisor = () => ({
      spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
        supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    });
    const runTurn = (
      systemPrompt: string,
      prompt: string,
      useResume: boolean,
      abortSignal?: AbortSignal,
      cleanup: () => Promise<void> = async () => {},
    ) => {
      const context = buildPreparedCliRunContext({ backend, prompt, systemPrompt });
      context.params.abortSignal = abortSignal;
      return runClaudeTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt,
        useResume,
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: getSerializedProcessSupervisor,
        onAssistantDelta: () => {},
        cleanup,
      });
    };

    await expect(
      runTurn(`Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}First metadata`, "first", false),
    ).resolves.toMatchObject({ output: { text: "turn-1" } });

    const second = runTurn(
      `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Second metadata`,
      "second",
      true,
    );
    await vi.waitFor(() => expect(releaseCapabilityProbe).toBeTypeOf("function"));
    const queuedAbort = new AbortController();
    const abortedCleanup = vi.fn(async () => {});
    const third = runTurn(
      `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Third metadata`,
      "third",
      true,
      queuedAbort.signal,
      abortedCleanup,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(live.writes.map((entry) => JSON.parse(entry).type)).toEqual(["user", "control_request"]);
    queuedAbort.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedCleanup).toHaveBeenCalledOnce();
    expect(live.writes.map((entry) => JSON.parse(entry).type)).toEqual(["user", "control_request"]);
    releaseCapabilityProbe?.();

    await expect(second).resolves.toMatchObject({ output: { text: "turn-2" } });
    await expect(
      runTurn(`Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Fourth metadata`, "fourth", true),
    ).resolves.toMatchObject({ output: { text: "turn-3" } });
    expect(live.writes.map((entry) => JSON.parse(entry).type)).toEqual([
      "user",
      "control_request",
      "control_request",
      "user",
      "control_request",
      "user",
    ]);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });
});
