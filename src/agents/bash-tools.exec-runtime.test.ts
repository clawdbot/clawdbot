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
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  getFinishedSession,
  acknowledgeNotifyOnExit,
  waitForExecScope,
} from "./bash-process-registry.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
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
  requestHeartbeatMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

function createRunExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

async function runExecWithExit(params: {
  exit: RunExit;
  stdout?: string | string[];
  timeoutSec?: number | null;
  usePty?: boolean;
}) {
  supervisorMock.spawn.mockImplementationOnce(
    async (input: { onStdout?: (chunk: string) => void }) => {
      if (params.stdout) {
        for (const chunk of typeof params.stdout === "string" ? [params.stdout] : params.stdout) {
          input.onStdout?.(chunk);
        }
      }
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
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
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => createRunExit()),
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
    { raw: ["\x1b[?1l\x1b", "[?1", "h"], expected: "application" },
    { raw: ["\x1b[?1h\x1b[?", "1", "l"], expected: "normal" },
    { raw: ["\x1b]0;\x1b[?1h", "\x07"], expected: "unknown" },
    { raw: "\x1b[?1h", expected: "application" },
    { raw: "\x1b[?1h\x1b[?1l", expected: "normal" },
    { raw: "\x1b[?1l\x1b[?1h", expected: "application" },
  ])("tracks the last cursor-mode toggle as $expected", async ({ raw, expected }) => {
    const { run } = await runExecWithExit({
      stdout: raw,
      usePty: true,
      exit: createRunExit(),
    });

    expect(run.session.cursorKeyMode).toBe(expected);
  });
});

describe("sandbox exec preparation failures", () => {
  it.each(["preparation", "supervisor"] as const)(
    "rechecks the admitting repair authority after deferred %s work",
    async (boundary) => {
      let current = true;
      const controller = new AbortController();
      const budget = createAgentToolExecutionBudget({
        signal: controller.signal,
        abort: (error) => controller.abort(error),
        isCurrent: () => current,
      });
      const childEffect = vi.fn();
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        await Promise.resolve();
        current = false;
        input.assertCurrent?.();
        childEffect();
        return runtimeManagedRun(input);
      });
      await expect(
        budget.run(() =>
          runExecProcess({
            command: "echo forbidden",
            workdir: "/tmp",
            env: {},
            usePty: false,
            warnings: [],
            maxOutput: 1000,
            pendingMaxOutput: 1000,
            notifyOnExit: false,
            timeoutSec: null,
            beforeSpawn: async () => {
              await Promise.resolve();
              if (boundary === "preparation") {
                current = false;
              }
              return undefined;
            },
          }),
        ),
      ).rejects.toThrow("execution scope is no longer active");
      expect(childEffect).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).toHaveBeenCalledTimes(boundary === "preparation" ? 0 : 1);
    },
  );

  it.each([
    { mode: "child", usePty: false, cancelCheck: 1, expectedSpawns: 0 },
    { mode: "PTY", usePty: true, cancelCheck: 1, expectedSpawns: 0 },
    { mode: "PTY fallback", usePty: true, cancelCheck: 2, expectedSpawns: 1 },
  ])(
    "does not start $mode after cancellation during final admission",
    async ({ usePty, cancelCheck, expectedSpawns }) => {
      const controller = new AbortController();
      let checks = 0;
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });

      await expect(
        runExecProcess({
          command: "echo should-not-run",
          workdir: process.cwd(),
          env: {},
          usePty,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          notifyOnExit: false,
          timeoutSec: null,
          startupSignal: controller.signal,
          beforeSpawn: async () => {
            if (++checks === cancelCheck) {
              controller.abort(new Error("cancelled during admission"));
            }
            return undefined;
          },
        }),
      ).rejects.toThrow("cancelled during admission");

      expect(supervisorMock.spawn.mock.calls.length).toBe(expectedSpawns);
      expect(checks).toBe(cancelCheck);
    },
  );

  it.each([
    { mode: "child", usePty: false, loseAt: 1, authority: "revoked", spawns: 0 },
    { mode: "PTY", usePty: true, loseAt: 1, authority: "replaced", spawns: 0 },
    { mode: "PTY fallback", usePty: true, loseAt: 2, authority: "revoked", spawns: 1 },
    { mode: "child construction", usePty: false, loseAt: -1, authority: "revoked", spawns: 1 },
    { mode: "PTY construction", usePty: true, loseAt: -1, authority: "revoked", spawns: 1 },
    { mode: "child control", usePty: false, loseAt: 0, authority: "active", spawns: 1 },
    { mode: "PTY fallback control", usePty: true, loseAt: 0, authority: "active", spawns: 2 },
  ])(
    "checks $authority source authority before $mode admission without polling",
    async ({ usePty, loseAt, authority, spawns }) => {
      const originalClaim = {};
      let currentClaim: object | undefined = originalClaim;
      let checks = 0;
      const generation = new AbortController();
      const warnings: string[] = [];
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        // The real supervisor preserves this callback across queued construction.
        await Promise.resolve();
        if (loseAt === -1) {
          currentClaim = undefined;
        }
        input.assertCurrent?.();
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:source-exec-authority",
          receiptAuthority: () => currentClaim === originalClaim,
        },
        () =>
          runExecProcess({
            command: "source-authority-command",
            workdir: process.cwd(),
            env: {},
            usePty,
            warnings,
            maxOutput: 1000,
            pendingMaxOutput: 1000,
            notifyOnExit: false,
            timeoutSec: null,
            startupSignal: generation.signal,
            beforeSpawn: async () => {
              if (++checks === loseAt) {
                currentClaim = authority === "replaced" ? {} : undefined;
              }
              return undefined;
            },
          }),
      );
      if (authority === "active") {
        const handle = await pending;
        await expect(handle.promise).resolves.toMatchObject({ status: "completed" });
      } else {
        await expect(pending).rejects.toThrow("authority is no longer active");
      }
      expect(generation.signal.aborted).toBe(false);
      expect(supervisorMock.spawn).toHaveBeenCalledTimes(spawns);
      expect(warnings).toEqual(
        usePty && loseAt !== -1 && spawns > 0
          ? [expect.stringContaining("retrying without PTY")]
          : [],
      );
      expect(listRunningSessions()).toHaveLength(0);
    },
  );

  it("keeps turn authority out of process lifetime while preserving foreground updates", async () => {
    const exit = createDeferred<RunExit>();
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:exec-lifetime",
      signedAgentRuntimeIdentityToken: "synthetic-turn-identity",
    };
    const spawnIdentity = vi.fn();
    const updateIdentity = vi.fn();
    const settledIdentity = vi.fn();
    const beforeSpawn = vi.fn(async () => {
      expect(getGatewayToolCallerIdentity()).toMatchObject(identity);
      return undefined;
    });
    let stdout: SpawnInput["onStdout"];
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      spawnIdentity(getGatewayToolCallerIdentity());
      stdout = input.onStdout;
      stdout?.("foreground output\n");
      return { ...runtimeManagedRun(input), wait: () => exit.promise };
    });

    const run = await withGatewayToolCallerIdentity(identity, () =>
      runExecProcess({
        command: "test-command",
        workdir: "/tmp",
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: null,
        beforeSpawn,
        onUpdate: () => updateIdentity(getGatewayToolCallerIdentity()),
        onSettledBeforeNotify: () => settledIdentity(getGatewayToolCallerIdentity()),
      }),
    );
    run.disableUpdates();
    stdout?.("background output\n");
    exit.resolve(createRunExit());
    const outcome = await run.promise;

    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(updateIdentity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(identity));
    expect(outcome.aggregated).toBe("foreground output\nbackground output");
    expect(spawnIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(settledIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("runs the final authorization check after async preparation and before spawn", async () => {
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const denied = new Error("approval directory changed");
    const beforeSpawn = vi.fn(async () => {
      throw denied;
    });
    const pending = runExecProcess({
      command: "sandbox-command",
      workdir: "/tmp",
      env: {},
      sandbox: {
        containerName: "sandbox",
        workspaceDir: "/workspace",
        containerWorkdir: "/workspace",
        buildExecSpec: async () => await preparation.promise,
      },
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
      beforeSpawn,
    });

    expect(beforeSpawn).not.toHaveBeenCalled();
    preparation.resolve({
      argv: ["sandbox-command"],
      env: {},
      stdinMode: "pipe-closed",
    });
    await expect(pending).rejects.toBe(denied);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("rejects a sandbox without a backend-owned exec specification", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input),
    );

    await expect(
      runExecProcess({
        command: "sandbox-command",
        workdir: "/tmp",
        env: { EXAMPLE_VALUE: "synthetic-runtime-sandbox-value" },
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: null,
      }),
    ).rejects.toThrow("sandbox backend does not provide buildExecSpec");

    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

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
      let producer: SpawnInput | undefined;
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        producer = input;
        input.onStdout?.("sandbox output\n");
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "sandbox-run",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            try {
              return await exit.promise;
            } finally {
              activity.resultSettled = true;
            }
          },
          cancel: vi.fn(),
        };
      });

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

      exit.resolve(
        createRunExit({
          reason: processTimesOut ? "overall-timeout" : "exit",
          exitCode: processTimesOut ? null : 0,
          exitSignal: processTimesOut ? "SIGKILL" : null,
          timedOut: processTimesOut,
        }),
      );
      await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
      expect(run.session.finalizing).toBe(true);
      producer?.onStderr?.("during cleanup\n");
      expect(getFinishedSession(run.session.id)).toBeUndefined();

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
      expect(requireSystemEventCall()[0]).toContain("during cleanup");
      const retained = getFinishedSession(run.session.id);
      const outputBeforeLateCallback = {
        aggregated: retained?.aggregated,
        tail: retained?.tail,
        totalOutputChars: retained?.totalOutputChars,
        truncated: retained?.truncated,
      };
      expect(outputBeforeLateCallback.aggregated).toContain("sandbox output\nduring cleanup\n");
      if (finalizeRejects && !processTimesOut) {
        expect(outputBeforeLateCallback.aggregated).toContain("sandbox finalize failed");
      }
      producer?.onStdout?.("late output".repeat(1_000));
      expect(getFinishedSession(run.session.id)).toMatchObject(outputBeforeLateCallback);

      const ready = prepareSuspension(`after-finalize-${expectedFailureKind ?? "success"}`);
      expect(ready.status).toBe("ready");
      if (ready.status === "ready") {
        expect(resumeGatewaySuspend(ready.suspensionId)).toMatchObject({ ok: true });
      }
    },
  );
});

describe("terminal execution-context release", () => {
  it.each([
    { path: "notify", trace: ["task", "enqueue", "wake"] },
    { path: "quiet", trace: ["task"] },
    { path: "unrouted", trace: ["task"] },
    { path: "observed", trace: ["task"] },
    { path: "task failure", trace: ["task", "task"] },
    { path: "enqueue failure", trace: ["task", "enqueue", "task"] },
    { path: "wake failure", trace: ["task", "enqueue", "wake", "task"] },
  ])(
    "releases routing after $path without changing notification order",
    async ({ path, trace }) => {
      const exit = createDeferred<RunExit>();
      const observed: string[] = [];
      const removal = vi.fn(() => true);
      const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
      const failure = new Error("notification boundary failed");
      enqueueSystemEventWithReceiptMock.mockImplementation((_text, options) => {
        observed.push("enqueue");
        expect(options.deliveryContext).toEqual(deliveryContext);
        if (path === "enqueue failure") {
          throw failure;
        }
        return removal;
      });
      requestHeartbeatMock.mockImplementation(() => {
        observed.push("wake");
        if (path === "wake failure") {
          throw failure;
        }
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, path === "quiet" ? "" : "retained output\n"),
        wait: () => exit.promise,
      }));
      const run = await runExecProcess({
        command: "context-release",
        workdir: "/tmp",
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 1_000,
        pendingMaxOutput: 1_000,
        scopeKey: "process-scope",
        sessionKey: path === "unrouted" ? undefined : "agent:main:main",
        agentId: "main",
        eventRouting: { mainKey: "main", sessionScope: "per-sender" },
        notifyDeliveryContext: deliveryContext,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        timeoutSec: null,
        onSettledBeforeNotify: () => {
          observed.push("task");
          if (path === "task failure" && observed.length === 1) {
            throw failure;
          }
        },
      });
      markBackgrounded(run.session);
      if (path === "observed") {
        acknowledgeNotifyOnExit(run.session);
      }
      exit.resolve(createRunExit());
      const outcome = await run.promise;
      expect(observed).toEqual(trace);
      expect(outcome.status).toBe(path.endsWith("failure") ? "failed" : "completed");
      const retained = getFinishedSession(run.session.id);
      expect(retained).toMatchObject({ scopeKey: "process-scope", terminalStatus: "completed" });
      for (const field of [
        "sessionKey",
        "agentId",
        "eventRouting",
        "notifyDeliveryContext",
        "notifyOnExit",
        "notifyOnExitEmptySuccess",
        "stdin",
      ] as const) {
        expect(retained?.[field], field).toBeUndefined();
      }
      expect(retained?.notifyOnExitRemoval).toBe(trace.includes("wake") ? removal : undefined);
      expect(removal).not.toHaveBeenCalled();
    },
  );
});

describe("exec settlement recovery", () => {
  it.each([
    { boundary: "task", trace: ["task:completed", "task:failed", "scope-released"] },
    {
      boundary: "enqueue",
      trace: ["task:completed", "enqueue", "task:failed", "scope-released"],
    },
    {
      boundary: "wake",
      trace: ["task:completed", "enqueue", "wake", "task:failed", "scope-released"],
    },
  ])("retries $boundary failure before releasing the exec scope", async ({ boundary, trace }) => {
    const exit = createDeferred<RunExit>();
    const observed: string[] = [];
    const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    const failure = new Error("process settlement failed");
    const scopeKey = `settlement-recovery:${boundary}`;
    enqueueSystemEventWithReceiptMock.mockImplementation(() => {
      observed.push("enqueue");
      if (boundary === "enqueue") {
        throw failure;
      }
      return vi.fn(() => true);
    });
    requestHeartbeatMock.mockImplementation(() => {
      observed.push("wake");
      if (boundary === "wake") {
        throw failure;
      }
    });
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      ...runtimeManagedRun(input, "process output\n"),
      wait: () => exit.promise,
    }));
    const run = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
      () =>
        runExecProcess({
          command: "settlement-recovery",
          workdir: "/tmp",
          env: {},
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          scopeKey,
          sessionKey: "agent:main:settlement-recovery",
          notifyOnExit: true,
          timeoutSec: null,
          onSettledBeforeNotify: (outcome) => {
            observed.push(`task:${outcome.status}`);
            identities.push(getGatewayToolCallerIdentity());
            if (boundary === "task" && observed.length === 1) {
              throw failure;
            }
          },
        }),
    );
    markBackgrounded(run.session);
    const joined = waitForExecScope(scopeKey).then(() => {
      observed.push("scope-released");
    });
    exit.resolve(createRunExit());

    const outcome = await run.promise;
    await joined;
    expect(outcome.status).toBe("failed");
    expect(observed).toEqual(trace);
    expect(identities).toEqual([undefined, undefined]);
  });
});

describe("runExecProcess exit outcomes", () => {
  it("keeps non-zero normal exits in the completed path", async () => {
    const { outcome } = await runExecWithExit({
      stdout: "done",
      exit: createRunExit({ exitCode: 1, durationMs: 123 }),
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
      exit: createRunExit({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 123,
        timedOut: true,
      }),
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
      exit: createRunExit({ exitCode: 127, durationMs: 123 }),
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
