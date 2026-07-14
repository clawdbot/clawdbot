/**
 * Exec runtime tests.
 * Covers target resolution, cursor mode tracking, exit outcome classification,
 * system events, and process lifecycle behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { RunExit } from "../process/supervisor/types.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../utils/timer-delay.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
  }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let getActiveBackgroundExecSessionCount: typeof import("./bash-process-registry.js").getActiveBackgroundExecSessionCount;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let resolveExecTarget: typeof import("./bash-tools.exec-runtime.js").resolveExecTarget;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let prepareGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").prepareGatewaySuspend;
let resetGatewaySuspendCoordinatorForLifecycleRestart: typeof import("../infra/gateway-suspend-coordinator.js").resetGatewaySuspendCoordinatorForLifecycleRestart;
let resumeGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").resumeGatewaySuspend;

beforeAll(async () => {
  ({ getActiveBackgroundExecSessionCount, markBackgrounded, resetProcessRegistryForTests } =
    await import("./bash-process-registry.js"));
  ({ resolveExecTarget, runExecProcess } = await import("./bash-tools.exec-runtime.js"));
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
  enqueueSystemEventMock.mockClear();
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

function expectExecTarget(
  actual: ReturnType<typeof resolveExecTarget>,
  expected: {
    configuredTarget: string;
    requestedTarget: string | null;
    selectedTarget: string;
    effectiveHost: string;
  },
) {
  expect(actual.configuredTarget).toBe(expected.configuredTarget);
  expect(actual.requestedTarget).toBe(expected.requestedTarget);
  expect(actual.selectedTarget).toBe(expected.selectedTarget);
  expect(actual.effectiveHost).toBe(expected.effectiveHost);
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

function requireHeartbeatCall(): Record<string, unknown> {
  const call = requestHeartbeatMock.mock.calls[0];
  if (!call) {
    throw new Error("expected heartbeat call");
  }
  return call[0] as Record<string, unknown>;
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

describe("resolveExecTarget", () => {
  it("keeps implicit auto on sandbox when a sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("keeps implicit auto on gateway when no sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "gateway",
      },
    );
  });

  it("allows per-call host=node override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("allows per-call host=gateway override when configured host is auto and no sandbox", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "gateway",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("rejects per-call host=gateway override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
    );
  });

  it("rejects per-call host=node override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested node; configured host is auto; set tools.exec.host=node to allow this override).",
    );
  });

  it("allows per-call host=sandbox override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "sandbox",
        effectiveHost: "sandbox",
      },
    );
  });

  it("rejects cross-host override when configured target is a concrete host", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  it("allows explicit auto request when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "auto",
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("requires an exact match for non-auto configured targets", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "gateway",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested auto; configured host is gateway; set tools.exec.host=auto to allow this override).",
    );
  });

  it("allows exact node matches", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("forces elevated requests onto the gateway host when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: true,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("keeps explicit node override under elevated requests when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("honours node target for elevated requests when configured target is node", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("routes to node for elevated when configured=node and no per-call override", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: null,
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("rejects mismatched requestedTarget under elevated+node", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });
});

describe("exec notifyOnExit suppression", () => {
  async function runBackgroundedExit(params: {
    reason: "manual-cancel" | "overall-timeout";
    stdout?: string;
  }) {
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => {
        if (params.stdout) {
          input.onStdout?.(params.stdout);
        }
        return {
          runId: "run-1",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
            return {
              reason: params.reason,
              exitCode: null,
              exitSignal: "SIGKILL",
              durationMs: 10,
              stdout: "",
              stderr: "",
              timedOut: params.reason === "overall-timeout",
              noOutputTimedOut: false,
            };
          },
          cancel: vi.fn(),
        };
      },
    );

    const run = await runExecProcess({
      command: "sleep 999",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      sessionKey: "agent:main:main",
      timeoutSec: null,
    });
    markBackgrounded(run.session);
    return await run.promise;
  }

  it("keeps manual-cancelled no-output background execs silent", async () => {
    const outcome = await runBackgroundedExit({ reason: "manual-cancel" });

    expect(outcome.status).toBe("failed");
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("notifies for manual-cancelled background execs with output", async () => {
    await runBackgroundedExit({ reason: "manual-cancel", stdout: "partial output\n" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("partial output");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("still notifies for no-output background exec timeouts", async () => {
    await runBackgroundedExit({ reason: "overall-timeout" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("Exec failed");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("keeps background exec exit-notification snippets on a UTF-16 boundary", async () => {
    // A backgrounded command whose tail output overflows the 180-char snippet
    // cap with an emoji straddling the cut must not deliver a lone surrogate to
    // the user's channel. The emoji's high surrogate lands at index 178, so a
    // raw slice(0, 179) would keep the dangling half.
    const head = "a".repeat(178);
    const overflowingOutput = `${head}🎉${"b".repeat(30)}`;
    await runBackgroundedExit({ reason: "manual-cancel", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    // The snippet stays truncated (ellipsis) while keeping the readable head.
    expect(message).toContain("…");
    expect(message).toContain(head);
  });

  it("keeps the notify tail source on a UTF-16 boundary", async () => {
    // The notify path first takes a 400-char tail, then compacts that tail to a
    // 180-char snippet. If the 400-char tail starts inside an emoji, the final
    // compacted snippet must not preserve the dangling low surrogate.
    const prefix = "a".repeat(101);
    const tailHead = "b".repeat(179);
    const overflowingOutput = `${prefix}🎉${tailHead}${"c".repeat(220)}`;
    await runBackgroundedExit({ reason: "manual-cancel", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).not.toContain("�");
    expect(message).toContain(tailHead);
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
      const finalization = createDeferred<void>();
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
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
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

describe("runExecProcess POSIX command wrapper", () => {
  it("normalizes non-finite and oversized exec timeouts before spawning", async () => {
    supervisorMock.spawn.mockResolvedValue({
      runId: "mock-run",
      startedAtMs: Date.now(),
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      cancel: vi.fn(),
    });

    const baseParams = {
      command: "echo test",
      workdir: "/tmp",
      env: { PATH: "/usr/bin" },
      pathPrepend: [],
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
    };

    await runExecProcess({
      ...baseParams,
      timeoutSec: Number.POSITIVE_INFINITY,
    });
    await runExecProcess({
      ...baseParams,
      timeoutSec: 3_000_000,
    });

    expect(supervisorMock.spawn.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    expect(supervisorMock.spawn.mock.calls[1]?.[0].timeoutMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("wraps command with PATH export if OPENCLAW_PREPEND_PATH is present", async () => {
    if (process.platform === "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce({
      runId: "mock-run",
      startedAtMs: Date.now(),
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      cancel: vi.fn(),
    });

    const ignoredRun = await runExecProcess({
      command: "echo test",
      workdir: "/tmp",
      env: { PATH: "/usr/bin" },
      pathPrepend: ["/custom/bin", "/opt/bin"],
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    });
    void ignoredRun;

    expect(supervisorMock.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];

    const commandStr = spawnCall.argv.join(" ");
    expect(commandStr).toContain(
      'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; echo test',
    );
  });

  it("does not wrap command on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce({
      runId: "mock-run",
      startedAtMs: Date.now(),
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      cancel: vi.fn(),
    });

    const ignoredRun = await runExecProcess({
      command: "echo test",
      workdir: "C:\\tmp",
      env: { Path: "C:\\Windows\\System32" },
      pathPrepend: ["C:\\custom\\bin"],
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    });
    void ignoredRun;

    expect(supervisorMock.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];

    const commandStr = spawnCall.argv.join(" ");
    expect(commandStr).not.toContain("export PATH=");
    expect(commandStr).toContain("echo test");
  });
});
