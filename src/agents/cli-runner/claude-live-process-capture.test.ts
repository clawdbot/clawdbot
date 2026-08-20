import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { markMcpLoopbackRequestStarted } from "../../gateway/mcp-http.loopback-runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  createCancelableLiveRunLifecycle,
  createClaudeInputStartedEvent,
  mockClaudeLiveRun,
} from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { cliBackendLog } from "./log.js";

// Gateway coverage owns quiet-admission timing; these cases preserve real capture draining.
vi.mock("../../gateway/mcp-http.loopback-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../gateway/mcp-http.loopback-runtime.js")>();
  return {
    ...actual,
    waitForMcpLoopbackToolCallCaptureIdle: (
      captureKey: string,
      options: Parameters<typeof actual.waitForMcpLoopbackToolCallCaptureIdle>[1],
    ) =>
      actual.waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
        ...options,
        admissionGraceMs: 0,
      }),
  };
});

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
}

function createCapturedLiveTurnRunner(options: {
  results: string[];
  cleanup?: (runId: string) => Promise<void>;
}) {
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  const captureKeys: string[] = [];
  let turnIndex = 0;
  supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
    const spawnIndex = supervisorSpawnMock.mock.calls.length;
    const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
    const lifecycle = createCancelableLiveRunLifecycle();
    cancels.push(lifecycle.cancel);
    return {
      runId: `live-run-${spawnIndex}`,
      pid: 2345 + spawnIndex,
      startedAtMs: Date.now(),
      stdin: {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          emitClaudeInputStarted(input.onStdout, dataValue);
          const result = options.results[turnIndex] ?? "ok";
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
      ...lifecycle,
    };
  });
  const runTurn = async (
    runId: string,
    args: string[],
    env: Record<string, string>,
    mcpHashes?: { config: string; resume: string },
  ) => {
    const context = buildClaudeLiveRunContext({
      runId,
      backend: {
        resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
      },
      mcpDeliveryCapture: true,
      mcpConfigHash: mcpHashes?.config,
      mcpResumeHash: mcpHashes?.resume,
    });
    const result = await runClaudeTurn({
      context,
      args,
      env,
      prompt: "hi",
      useResume: args.some((entry) => entry.startsWith("--resume")),
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: () => ({
        spawn: (spawnArgs: Parameters<SupervisorSpawnFn>[0]) =>
          supervisorSpawnMock(spawnArgs) as ReturnType<SupervisorSpawnFn>,
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        getRecord: vi.fn(),
      }),
      onAssistantDelta: () => {},
      onMcpCaptureReady: (captureKey) => captureKeys.push(captureKey),
      cleanup: async () => {
        await options.cleanup?.(runId);
      },
    });
    return result.output.text;
  };
  return { cancels, captureKeys, runTurn };
}

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClaudeLiveSessionsForTest();
});

describe("Claude live MCP capture lifetime", () => {
  it("reuses a captured Claude live process and capture key across resume turns", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    const { cancels, captureKeys, runTurn } = createCapturedLiveTurnRunner({
      results: ["first-ok", "resume-ok"],
    });
    const env = { ANTHROPIC_BASE_URL: "https://one.example" };
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(runTurn("run-live-fresh", freshArgs, env)).resolves.toBe("first-ok");
    await expect(runTurn("run-live-resume", resumeArgs, env)).resolves.toBe("resume-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    expect(cancels[0]).not.toHaveBeenCalled();
    expect(captureKeys[0]).toEqual(expect.any(String));
    expect(captureKeys).toEqual([captureKeys[0], captureKeys[0]]);
    expect(
      logInfoSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => typeof message === "string" && message.includes("reason=restart")),
    ).toEqual([]);
  });

  it("reuses a captured process when only turn-local MCP config changes", async () => {
    const { cancels, runTurn } = createCapturedLiveTurnRunner({
      results: ["first-ok", "resume-ok"],
    });
    const env = { ANTHROPIC_BASE_URL: "https://one.example" };
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(
      runTurn("run-live-fresh", freshArgs, env, {
        config: "turn-config-one",
        resume: "stable-resume-config",
      }),
    ).resolves.toBe("first-ok");
    await expect(
      runTurn("run-live-resume", resumeArgs, env, {
        config: "turn-config-two",
        resume: "stable-resume-config",
      }),
    ).resolves.toBe("resume-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    expect(cancels[0]).not.toHaveBeenCalled();
  });

  it("still restarts a captured Claude live process when resume identity changes", async () => {
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const { cancels, captureKeys, runTurn } = createCapturedLiveTurnRunner({
      results: ["first-ok", "env-ok", "fresh-ok"],
      cleanup: async (runId) => {
        if (runId === "run-live-fresh") {
          throw new Error("captured cleanup failed");
        }
      },
    });
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(
      runTurn("run-live-fresh", freshArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("first-ok");
    await expect(
      runTurn("run-live-env-change", resumeArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("env-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[1]).not.toBe(captureKeys[0]);

    await expect(
      runTurn("run-live-fresh-retry", freshArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("fresh-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(cancels[1]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[2]).not.toBe(captureKeys[1]);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Claude live session cleanup failed: captured cleanup failed"),
    );
  });

  it("fences a reused Claude live capture key between execute turns", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ data, emit, writeIndex }) => {
        if ((JSON.parse(data) as { type?: string }).type !== "user") {
          return;
        }
        emit([
          { type: "system", subtype: "init", session_id: "captured-live" },
          {
            type: "result",
            session_id: "captured-live",
            result: writeIndex === 0 ? "one" : "two",
          },
        ]);
      },
    });
    const activateCapture = vi.fn<(captureKey: string) => void>();
    const deactivateCapture = vi.fn<(captureKey: string) => void>();
    const revokeProcessToken = vi.fn<() => void>();
    const adoptedProcessTokens: string[] = [];
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };
    const buildContext = (prompt: string, transportToken: string) => {
      const context = buildPreparedCliRunContext({
        backend,
        prompt,
        mcpDeliveryCapture: true,
        preparedEnv: { OPENCLAW_MCP_TOKEN: transportToken },
      });
      context.preparedBackend.mcpClientGrantCapture = {
        transportToken,
        adoptProcessToken: (processToken) => adoptedProcessTokens.push(processToken),
        revokeProcessToken,
        activate: activateCapture,
        deactivate: deactivateCapture,
      };
      return context;
    };

    const first = await executePreparedCliRun(buildContext("first", "turn-token-one"));
    const second = await executePreparedCliRun(
      buildContext("second", "turn-token-two"),
      "captured-live",
    );

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    expect(adoptedProcessTokens).toEqual(["turn-token-one"]);
    expect(live.lifecycle.cancel).not.toHaveBeenCalled();
    const captureKey = activateCapture.mock.calls[0]?.[0];
    expect(typeof captureKey).toBe("string");
    expect(captureKey?.length).toBeGreaterThan(0);
    expect(activateCapture.mock.calls.map(([key]) => key)).toEqual([captureKey, captureKey]);
    expect(deactivateCapture.mock.calls.map(([key]) => key)).toEqual([captureKey, captureKey]);
    expect(deactivateCapture.mock.invocationCallOrder[0]).toBeLessThan(
      activateCapture.mock.invocationCallOrder[1]!,
    );
    expect(revokeProcessToken).not.toHaveBeenCalled();
    resetClaudeLiveSessionsForTest();
    expect(revokeProcessToken).toHaveBeenCalledOnce();
  });

  it("reuses a captured process only while its thinking launch environment matches", async () => {
    const firstLive = mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ data, emit, writeIndex }) => {
        if ((JSON.parse(data) as { type?: string }).type !== "user") {
          return;
        }
        emit([
          { type: "system", subtype: "init", session_id: "captured-thinking" },
          {
            type: "result",
            session_id: "captured-thinking",
            result: writeIndex === 0 ? "one" : "two",
          },
        ]);
      },
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ emit, writeIndex }) => {
        emit([
          { type: "system", subtype: "init", session_id: "captured-thinking" },
          {
            type: "result",
            session_id: "captured-thinking",
            result: writeIndex === 0 ? "three" : "four",
          },
        ]);
      },
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };
    const buildContext = (prompt: string, maxThinkingTokens: string) =>
      buildPreparedCliRunContext({
        backend,
        prompt,
        mcpDeliveryCapture: true,
        preparedEnv: { MAX_THINKING_TOKENS: maxThinkingTokens },
      });

    const first = await executePreparedCliRun(buildContext("first", "2048"));
    const sameLevel = await executePreparedCliRun(
      buildContext("second", "2048"),
      "captured-thinking",
    );
    const changedLevel = await executePreparedCliRun(
      buildContext("third", "16384"),
      "captured-thinking",
    );
    const sameChangedLevel = await executePreparedCliRun(
      buildContext("fourth", "16384"),
      "captured-thinking",
    );

    expect([first.text, sameLevel.text, changedLevel.text, sameChangedLevel.text]).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(firstLive.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("closes a captured Claude live process when MCP delivery capture cannot drain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    const requestStarted = createDeferred();
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ data, emit }) => {
        if ((JSON.parse(data) as { type?: string }).type !== "user") {
          return;
        }
        markMcpLoopbackRequestStarted(live.spawnInput.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
        requestStarted.resolve();
        emit([
          { type: "system", subtype: "init", session_id: "captured-drain" },
          { type: "result", session_id: "captured-drain", result: "ok" },
        ]);
      },
    });
    const context = buildClaudeLiveRunContext({
      backend: {
        resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      },
      mcpDeliveryCapture: true,
    });

    const pending = executePreparedCliRun(context);
    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(0);
    const rejection = expect(pending).rejects.toThrow(
      "CLI message tool call remained in flight after exit",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(live.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
    expect(
      logInfoSpy.mock.calls
        .map(([message]) => message)
        .some(
          (message) =>
            typeof message === "string" && message.includes("reason=mcp-capture-rotation"),
        ),
    ).toBe(true);
  }, 15_000);
});
