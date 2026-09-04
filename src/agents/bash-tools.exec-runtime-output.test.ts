import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";

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
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

beforeAll(async () => {
  ({ markBackgrounded } = await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockClear();
  enqueueSystemEventWithReceiptMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReturnValue(vi.fn(() => true));
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

function successfulSupervisorRun() {
  return {
    runId: "mock-run",
    startedAtMs: Date.now(),
    wait: async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
    cancel: vi.fn(),
  };
}

function runtimeManagedRun(input: SpawnInput): ManagedRun {
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

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventWithReceiptMock.mock.calls[0];
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
    expect(enqueueSystemEventWithReceiptMock).not.toHaveBeenCalled();
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
    expect(message).toContain("external side effects may already have completed");
    expect(message).toContain("Verify the resulting state before retrying");
    expect(message).toContain("Do not automatically rerun non-idempotent commands");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("keeps background exec exit-notification snippets on a UTF-16 boundary", async () => {
    const head = "a".repeat(178);
    const overflowingOutput = `${head}🎉${"b".repeat(30)}`;
    await runBackgroundedExit({ reason: "manual-cancel", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).toContain("…");
    expect(message).toContain(head);
  });

  it("keeps the notify tail source on a UTF-16 boundary", async () => {
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

describe("runExecProcess POSIX command wrapper", () => {
  it("normalizes non-finite and oversized exec timeouts before spawning", async () => {
    supervisorMock.spawn.mockResolvedValue(successfulSupervisorRun());

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

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());

    await runExecProcess({
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

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    expect(spawnCall.argv.join(" ")).toContain(
      'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; echo test',
    );
  });

  it("does not wrap command on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());
    await runExecProcess({
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

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    const commandStr = spawnCall.argv.join(" ");
    expect(commandStr).not.toContain("export PATH=");
    expect(commandStr).toContain("echo test");
  });
});

describe("runExecProcess stream sanitization", () => {
  function runStyledExec() {
    return runExecProcess({
      command: "printf styled",
      workdir: process.cwd(),
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      notifyOnExit: false,
      timeoutSec: 5,
    });
  }

  it("sanitizes ANSI and OSC sequences split across stdout chunks", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      for (const chunk of [
        "A\u001B]0;title",
        "\u0007B",
        "C\u001B[31",
        "mD",
        "E\u009D0;title",
        "\u001B\\F",
        "G\u009B31",
        "mH",
      ]) {
        input.onStdout?.(chunk);
      }
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toContain("ABCDEFGH");
    expect(outcome.aggregated).not.toContain("\\x1b");
  });

  it("sanitizes escape sequences split across stderr chunks", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      input.onStderr?.("warn: \u001B[");
      input.onStderr?.("31mred");
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toContain("warn: red");
    expect(outcome.aggregated).not.toContain("\\x1b");
  });

  it("keeps stdout and stderr parser state independent", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      input.onStdout?.("out\u001B[");
      input.onStderr?.("err\u001B[");
      input.onStdout?.("32mOUT");
      input.onStderr?.("31mERR");
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toBe("outerrOUTERR");
  });
});
