/**
 * Exec runtime tests.
 * Covers cursor mode tracking, exit outcome classification, system events,
 * sandbox finalization, and process lifecycle behavior.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticExecProcessCompletedEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatRaw: requestHeartbeatMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
  }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let getActiveBackgroundExecSessionCount: typeof import("./bash-process-registry.js").getActiveBackgroundExecSessionCount;
let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let prepareGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").prepareGatewaySuspend;
let resetGatewaySuspendCoordinatorForLifecycleRestart: typeof import("../infra/gateway-suspend-coordinator.js").resetGatewaySuspendCoordinatorForLifecycleRestart;
let resumeGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").resumeGatewaySuspend;

beforeAll(async () => {
  ({ getActiveBackgroundExecSessionCount, listRunningSessions, markBackgrounded } =
    await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
  ({
    prepareGatewaySuspend,
    resetGatewaySuspendCoordinatorForLifecycleRestart,
    resumeGatewaySuspend,
  } = await import("../infra/gateway-suspend-coordinator.js"));
});

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockClear();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

async function runExecWithExit(params: {
  exit: RunExit;
  stdout?: string;
  timeoutSec?: number | null;
  usePty?: boolean;
}) {
  supervisorMock.spawn.mockImplementationOnce(
    async (input: { onStdout?: (chunk: string) => void }) => {
      if (params.stdout) {
        input.onStdout?.(params.stdout);
      }
      return {
        runId: "run-exit",
        startedAtMs: Date.now(),
        pid: 123,
        wait: async () => params.exit,
        cancel: vi.fn(),
      };
    },
  );
  const run = await runExecProcess({
    command: "test-command",
    workdir: "/tmp",
    env: {},
    usePty: params.usePty ?? false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: params.timeoutSec ?? null,
  });
  return { run, outcome: await run.promise };
}

function runtimeManagedRun(input: SpawnInput, stdout = ""): ManagedRun {
  if (stdout) {
    input.onStdout?.(stdout);
  }
  return {
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
  };
}

function prepareSuspension(requestId: string) {
  // This test owns only the background-exec registry. Other process-global
  // activity counters may legitimately stay busy in the non-isolated suite.
  const inspect: GatewayActiveWorkInspectors = {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    inspect,
  });
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventWithReceiptMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

describe("runExecProcess cursor tracking", () => {
  it.each([
    { raw: "hello world", expected: "unknown" },
    { raw: "\x1b[?1h", expected: "application" },
    { raw: "\x1b[?1h\x1b[?1l", expected: "normal" },
    { raw: "\x1b[?1l\x1b[?1h", expected: "application" },
  ])("tracks the last cursor-mode toggle as $expected", async ({ raw, expected }) => {
    const { run } = await runExecWithExit({
      stdout: raw,
      usePty: true,
      exit: {
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
    });

    expect(run.session.cursorKeyMode).toBe(expected);
  });
});

describe("sandbox exec preparation failures", () => {
  it("settles the registered session once when buildExecSpec rejects", async () => {
    const registry = await import("./bash-process-registry.js");
    const sessionSlugs = await import("./session-slug.js");
    const sessionId = "sandbox-preparation-failure";
    const sessionSlug = vi.spyOn(sessionSlugs, "createSessionSlug").mockReturnValue(sessionId);
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const onSettledBeforeNotify = vi.fn();
    const completionEvents: DiagnosticExecProcessCompletedEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (
        event.type === "exec.process.completed" &&
        event.sessionKey === "agent:main:sandbox-preparation"
      ) {
        completionEvents.push(event);
      }
    });
    const failure = new Error("sandbox preparation failed");

    try {
      const pending = runExecProcess({
        command: "sandbox-command",
        workdir: "/tmp",
        env: {},
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => await preparation.promise,
          finalizeExec,
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        sessionKey: "agent:main:sandbox-preparation",
        timeoutSec: null,
        onSettledBeforeNotify,
      });

      expect(registry.getSession(sessionId)).toMatchObject({ exited: false });
      preparation.reject(failure);
      await expect(pending).rejects.toBe(failure);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(finalizeExec).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).not.toHaveBeenCalled();
      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(onSettledBeforeNotify).toHaveBeenCalledOnce();
      expect(onSettledBeforeNotify).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", failureKind: "runtime-error" }),
      );
      expect(completionEvents).toEqual([
        expect.objectContaining({
          type: "exec.process.completed",
          target: "sandbox",
          mode: "child",
          outcome: "failed",
          failureKind: "runtime-error",
          timedOut: false,
          sessionKey: "agent:main:sandbox-preparation",
        }),
      ]);
    } finally {
      unsubscribe();
      sessionSlug.mockRestore();
    }
  });
});

describe("sandbox exec finalization suspension", () => {
  it.each([
    {
      scenario: "successful cleanup",
      finalizeRejects: false,
      processTimesOut: false,
      expectedStatus: "completed" as const,
      expectedFailureKind: undefined,
    },
    {
      scenario: "failed cleanup",
      finalizeRejects: true,
      processTimesOut: false,
      expectedStatus: "failed" as const,
      expectedFailureKind: "runtime-error" as const,
    },
    {
      scenario: "failed cleanup after a process timeout",
      finalizeRejects: true,
      processTimesOut: true,
      expectedStatus: "failed" as const,
      expectedFailureKind: "overall-timeout" as const,
    },
  ])(
    "keeps suspension busy until asynchronous finalization settles after $scenario",
    async ({ finalizeRejects, processTimesOut, expectedFailureKind, expectedStatus }) => {
      const exit = createDeferred<RunExit>();
      const finalization = createDeferred();
      const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(
        async () => await finalization.promise,
      );
      supervisorMock.spawn.mockImplementationOnce(
        async (input: { onStdout?: (chunk: string) => void }) => {
          input.onStdout?.("sandbox output\n");
          return {
            runId: "sandbox-run",
            startedAtMs: Date.now(),
            pid: 123,
            wait: async () => await exit.promise,
            cancel: vi.fn(),
          };
        },
      );

      const run = await runExecProcess({
        command: "sandbox-command",
        workdir: "/tmp",
        env: {},
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => ({
            argv: ["sandbox-command"],
            env: {},
            stdinMode: "pipe-closed",
            finalizeToken: "sandbox-token",
          }),
          finalizeExec,
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: true,
        sessionKey: "agent:main:main",
        timeoutSec: null,
      });
      markBackgrounded(run.session);
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      exit.resolve({
        reason: processTimesOut ? "overall-timeout" : "exit",
        exitCode: processTimesOut ? null : 0,
        exitSignal: processTimesOut ? "SIGKILL" : null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: processTimesOut,
        noOutputTimedOut: false,
      });
      await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
      expect(run.session.finalizing).toBe(true);

      const busy = prepareSuspension(`before-finalize-${expectedFailureKind ?? "success"}`);
      expect(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect(busy.blockers).toContainEqual(
          expect.objectContaining({ kind: "background-exec", count: 1 }),
        );
      }
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      if (finalizeRejects) {
        finalization.reject(new Error("sandbox finalize failed"));
      } else {
        finalization.resolve();
      }
      const outcome = await run.promise;

      expect(outcome.status).toBe(expectedStatus);
      if (outcome.status === "failed") {
        expect(outcome.failureKind).toBe(expectedFailureKind);
        expect(outcome.reason).toContain(
          expectedFailureKind === "runtime-error" ? "sandbox finalize failed" : "timed out",
        );
      }
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
      expect(run.session.finalizing).toBe(false);
      expect(enqueueSystemEventWithReceiptMock).toHaveBeenCalledTimes(1);
      expect(requireSystemEventCall()[0]).toContain(
        expectedStatus === "failed" ? "Exec failed" : "Exec completed",
      );

      const ready = prepareSuspension(`after-finalize-${expectedFailureKind ?? "success"}`);
      expect(ready.status).toBe("ready");
      if (ready.status === "ready") {
        expect(resumeGatewaySuspend(ready.suspensionId)).toMatchObject({ ok: true });
      }
    },
  );
});

describe("runExecProcess exit outcomes", () => {
  it("keeps non-zero normal exits in the completed path", async () => {
    const { outcome } = await runExecWithExit({
      stdout: "done",
      exit: {
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error(`Expected completed outcome, got ${outcome.status}`);
    }
    expect(outcome.exitCode).toBe(1);
    expect(outcome.aggregated).toBe("done\n\n(Command exited with code 1)");
  });

  it("classifies timed out exits with registered-background guidance", async () => {
    const { outcome } = await runExecWithExit({
      exit: {
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      },
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error(`Expected timeout to fail, got ${outcome.status}`);
    }
    expect(outcome.failureKind).toBe("overall-timeout");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.reason).toContain("30 seconds");
    expect(outcome.reason).toContain("external side effects may already have completed");
    expect(outcome.reason).toContain("Verify the resulting state before retrying");
    expect(outcome.reason).toContain("Do not automatically rerun non-idempotent commands");
    expect(outcome.reason).toContain("known to be safe to retry");
    expect(outcome.reason).toContain("background=true");
    expect(outcome.reason).toContain("yieldMs");
    expect(outcome.reason).toContain("Do not rely on shell backgrounding");
  });

  it("classifies missing shell commands without timeout guidance", async () => {
    const { outcome } = await runExecWithExit({
      exit: {
        reason: "exit",
        exitCode: 127,
        exitSignal: null,
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
      timeoutSec: 30,
    });

    if (outcome.status !== "failed") {
      throw new Error(`Expected shell failure, got ${outcome.status}`);
    }
    expect(outcome.failureKind).toBe("shell-command-not-found");
    expect(outcome.reason).toBe("Command not found");
  });
});

describe("runExecProcess PTY fallback", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  function runPtyFallback(warnings: string[] = []) {
    return runExecProcess({
      command: "printf ok",
      workdir: process.cwd(),
      env: {},
      usePty: true,
      warnings,
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      notifyOnExit: false,
      timeoutSec: 5,
    });
  }

  function spawnInput(index: number): SpawnInput {
    const call = supervisorMock.spawn.mock.calls[index] as [SpawnInput] | undefined;
    if (!call) {
      throw new Error(`expected supervisor spawn call ${index}`);
    }
    return call[0];
  }

  it("visibly falls back when the portable worker rejects PTY", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("PTY is unavailable in the portable worker runtime"))
      .mockImplementationOnce(async (input: SpawnInput) => runtimeManagedRun(input, "ok"));

    const warnings: string[] = [];
    const handle = await runPtyFallback(warnings);
    const outcome = await handle.promise;

    expect(outcome.status).toBe("completed");
    expect(outcome.aggregated).toContain("ok");
    expect(warnings.join("\n")).toContain("PTY is unavailable in the portable worker runtime");
    expect(spawnInput(0).mode).toBe("pty");
    expect(spawnInput(1).mode).toBe("child");
  });

  it("cleans session state when PTY fallback spawn also fails", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("pty spawn failed"))
      .mockRejectedValueOnce(new Error("child fallback failed"));

    await expect(runPtyFallback()).rejects.toThrow("child fallback failed");

    expect(listRunningSessions()).toHaveLength(0);
  });

  it("emits bounded process diagnostics without command text", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input, "ok"),
    );
    const events: DiagnosticEventPayload[] = [];
    const metadataByEvent = new Map<DiagnosticEventPayload, DiagnosticEventMetadata>();
    const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
      events.push(event);
      metadataByEvent.set(event, metadata);
    });
    try {
      const command = "printf super-secret-value";
      const handle = await runExecProcess({
        command,
        workdir: process.cwd(),
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 20_000,
        pendingMaxOutput: 20_000,
        notifyOnExit: false,
        sessionKey: "session-1",
        timeoutSec: 5,
      });

      await handle.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const event = events.find(
        (item): item is DiagnosticExecProcessCompletedEvent =>
          item.type === "exec.process.completed",
      );
      if (!event) {
        throw new Error("Expected exec process completed event");
      }
      expect(event.type).toBe("exec.process.completed");
      // The payload stays untrusted, but exporters need the ambient trace context marked
      // OpenClaw-owned or the exec span cannot be nested under the run that spawned it.
      expect(metadataByEvent.get(event)?.trusted).toBe(false);
      expect(metadataByEvent.get(event)?.trustedTraceContext).toBe(true);
      expect(event.target).toBe("host");
      expect(event.mode).toBe("child");
      expect(event.outcome).toBe("completed");
      expect(typeof event.durationMs).toBe("number");
      expect(event.commandLength).toBe(command.length);
      expect(event.exitCode).toBe(0);
      expect(event.sessionKey).toBe("session-1");
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("printf");
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain(process.cwd());
    } finally {
      unsubscribe();
    }
  });
});
