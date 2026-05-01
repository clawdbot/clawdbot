import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";

const spawnMock = vi.hoisted(() => vi.fn());

let attachChildProcessBridge: typeof import("./child-process-bridge.js").attachChildProcessBridge;
let resolveCommandEnv: typeof import("./exec.js").resolveCommandEnv;
let resolveProcessExitCode: typeof import("./exec.js").resolveProcessExitCode;
let runCommandWithTimeout: typeof import("./exec.js").runCommandWithTimeout;
let shouldSpawnWithShell: typeof import("./exec.js").shouldSpawnWithShell;

async function loadExecModules(options?: { mockSpawn?: boolean }) {
  vi.resetModules();
  if (options?.mockSpawn) {
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: spawnMock,
      };
    });
  } else {
    vi.doUnmock("node:child_process");
  }
  ({ attachChildProcessBridge } = await import("./child-process-bridge.js"));
  ({ resolveCommandEnv, resolveProcessExitCode, runCommandWithTimeout, shouldSpawnWithShell } =
    await import("./exec.js"));
}

describe("runCommandWithTimeout", () => {
  function createSilentIdleArgv(): string[] {
    return [process.execPath, "-e", "setInterval(() => {}, 1_000)"];
  }

  function createKilledChild(signal: NodeJS.Signals = "SIGKILL"): ChildProcess {
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    child.stdout = new EventEmitter() as EventEmitter & NonNullable<ChildProcess["stdout"]>;
    child.stderr = new EventEmitter() as EventEmitter & NonNullable<ChildProcess["stderr"]>;
    child.stdin = new EventEmitter() as EventEmitter & NonNullable<ChildProcess["stdin"]>;
    child.stdin.write = vi.fn(() => true) as NonNullable<ChildProcess["stdin"]>["write"];
    child.stdin.end = vi.fn() as NonNullable<ChildProcess["stdin"]>["end"];
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    Object.defineProperties(child, {
      pid: {
        configurable: true,
        enumerable: true,
        get: () => 1234,
      },
      killed: {
        configurable: true,
        enumerable: true,
        get: () => killed,
      },
      exitCode: {
        configurable: true,
        enumerable: true,
        get: () => exitCode,
      },
      signalCode: {
        configurable: true,
        enumerable: true,
        get: () => signalCode,
      },
    });
    child.kill = vi.fn((receivedSignal?: NodeJS.Signals) => {
      const resolvedSignal = receivedSignal ?? signal;
      killed = true;
      exitCode = null;
      signalCode = resolvedSignal;
      child.emit("exit", null, resolvedSignal);
      child.emit("close", null, resolvedSignal);
      return true;
    }) as ChildProcess["kill"];
    return child;
  }

  beforeEach(async () => {
    vi.useRealTimers();
    spawnMock.mockReset();
    await loadExecModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:child_process");
  });

  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with base env and drops undefined values", async () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      baseEnv: {
        OPENCLAW_BASE_ENV: "base",
        OPENCLAW_TO_REMOVE: undefined,
      },
      env: {
        OPENCLAW_TEST_ENV: "ok",
      },
    });

    expect(resolved.OPENCLAW_BASE_ENV).toBe("base");
    expect(resolved.OPENCLAW_TEST_ENV).toBe("ok");
    expect(resolved.OPENCLAW_TO_REMOVE).toBeUndefined();
    expect(resolved.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("suppresses npm fund prompts for npm argv", async () => {
    const resolved = resolveCommandEnv({
      argv: ["npm", "--version"],
      baseEnv: {},
    });

    expect(resolved.NPM_CONFIG_FUND).toBe("false");
    expect(resolved.npm_config_fund).toBe("false");
  });

  it("infers success for shimmed Windows commands when exit codes are missing", () => {
    expect(
      resolveProcessExitCode({
        explicitCode: null,
        childExitCode: null,
        resolvedSignal: null,
        usesWindowsExitCodeShim: true,
        timedOut: false,
        noOutputTimedOut: false,
        killIssuedByTimeout: false,
      }),
    ).toBe(0);
  });

  it("does not infer success when this process already issued a timeout kill", () => {
    expect(
      resolveProcessExitCode({
        explicitCode: null,
        childExitCode: null,
        resolvedSignal: null,
        usesWindowsExitCodeShim: true,
        timedOut: true,
        noOutputTimedOut: false,
        killIssuedByTimeout: true,
      }),
    ).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "kills command when no output timeout elapses",
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      const child = createKilledChild();
      spawnMock.mockReturnValue(child);
      await loadExecModules({ mockSpawn: true });
      const resultPromise = runCommandWithTimeout(createSilentIdleArgv(), {
        timeoutMs: 2_000,
        noOutputTimeoutMs: 200,
      });

      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.termination).toBe("no-output-timeout");
      expect(result.noOutputTimedOut).toBe(true);
      expect(result.code).not.toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports global timeout termination when overall timeout elapses",
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      const child = createKilledChild();
      spawnMock.mockReturnValue(child);
      await loadExecModules({ mockSpawn: true });
      const resultPromise = runCommandWithTimeout(createSilentIdleArgv(), {
        timeoutMs: 200,
      });

      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.termination).toBe("timeout");
      expect(result.noOutputTimedOut).toBe(false);
      expect(result.code).not.toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "swallows stdin EPIPE when child exits before input is consumed (#75438)",
    { timeout: 5_000 },
    async () => {
      await loadExecModules();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", "process.exit(0)"],
        {
          timeoutMs: 3_000,
          input: "this input will EPIPE because the child ignores stdin\n",
        },
      );
      expect(result.code).toBe(0);
    },
  );
});

describe("attachChildProcessBridge", () => {
  function createFakeChild() {
    const emitter = new EventEmitter() as EventEmitter & ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    emitter.kill = kill as ChildProcess["kill"];
    return { child: emitter, kill };
  }

  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const { child, kill } = createFakeChild();
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });

    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);

    // Detached already via exit; should remain a safe no-op.
    detach();
  });
});
