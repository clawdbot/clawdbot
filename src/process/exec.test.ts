// Exec tests cover command execution, output capture, and cancellation behavior.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import {
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandBuffered,
  runCommandWithTimeout,
  runExec,
  shouldSpawnWithShell,
} from "./exec.js";

const OPENCLAW_CLI_ENV_VALUE = "1";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with base env and drops undefined values", () => {
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

  it("collapses case-insensitive duplicate env keys on Windows", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      platform: "win32",
      baseEnv: {
        Path: "C:\\base\\bin",
        OPENCLAW_BASE_ENV: "base",
      },
      env: {
        PATH: "C:\\override\\bin",
        OPENCLAW_TEST_ENV: "ok",
      },
    });

    expect(resolved.Path).toBeUndefined();
    expect(resolved.PATH).toBe("C:\\override\\bin");
    expect(resolved.OPENCLAW_BASE_ENV).toBe("base");
    expect(resolved.OPENCLAW_TEST_ENV).toBe("ok");
  });

  it("preserves case-distinct env keys outside Windows", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      platform: "linux",
      baseEnv: { Path: "/base/bin" },
      env: { PATH: "/override/bin" },
    });

    expect(resolved.Path).toBe("/base/bin");
    expect(resolved.PATH).toBe("/override/bin");
  });

  it("does not restore parent variables excluded from the child environment", async () => {
    const key = "OPENCLAW_EXECA_PARENT_ONLY_TEST";
    const previous = process.env[key];
    process.env[key] = "parent-value";
    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", `process.stdout.write(process.env.${key} ?? "missing")`],
        {
          timeoutMs: 2_000,
          baseEnv: {},
        },
      );

      expect(result.stdout).toBe("missing");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("suppresses npm fund prompts for npm argv", () => {
    const resolved = resolveCommandEnv({ argv: ["npm", "--version"], baseEnv: {} });

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

  it("does not infer success after this process issued a timeout kill", () => {
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

  it("returns without spawning when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCommandWithTimeout([process.execPath, "-e", "process.exit(99)"], {
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      code: null,
      killed: false,
      noOutputTimedOut: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "signal",
    });
  });

  it.runIf(process.platform !== "win32")(
    "normalizes a child-requested signal as command termination",
    async () => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
        { timeoutMs: 2_000 },
      );

      expect(result).toMatchObject({
        code: null,
        signal: "SIGTERM",
        termination: "signal",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses the requested kill signal when a command times out",
    async () => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
        { timeoutMs: 20, killSignal: "SIGKILL" },
      );

      expect(result).toMatchObject({
        signal: "SIGKILL",
        termination: "timeout",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects unresolved commands before Execa can fall through to ambient ComSpec",
    async () => {
      const command = `openclaw-missing-${process.pid}\r\ncalc.exe`;
      const previousComspec = process.env.comspec;
      process.env.comspec = process.execPath;
      try {
        await expect(runCommandWithTimeout([command], { timeoutMs: 2_000 })).rejects.toMatchObject({
          code: "ENOENT",
          path: command,
          syscall: `spawn ${command}`,
        });
      } finally {
        if (previousComspec === undefined) {
          delete process.env.comspec;
        } else {
          process.env.comspec = previousComspec;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "swallows stdin EPIPE when the child exits before input is consumed (#75438)",
    { timeout: 5_000 },
    async () => {
      const result = await runCommandWithTimeout([process.execPath, "-e", "process.exit(0)"], {
        timeoutMs: 3_000,
        input: "this input will EPIPE because the child ignores stdin\n",
      });
      expect(result.code).toBe(0);
    },
  );

  it("preserves matching output lines even when tail capture truncates them", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        [
          "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
          "process.stdout.write('x'.repeat(200))",
        ].join(";"),
      ],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: (line) => line.includes("enter code"),
      },
    );

    expect(result.stdout).toBe("x".repeat(24));
    expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
    expect(result.preservedStdoutLines).toEqual([
      "Visit https://example.com/device and enter code ABCD-EFGH",
    ]);
  });

  it("bounds preserved matching output for long lines without newlines", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(10_000))"],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: () => true,
      },
    );

    expect(result.stdout).toBe("x".repeat(24));
    expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
    expect(result.preservedStdoutLines).toEqual(["x".repeat(24)]);
  });

  it("keeps preserved line tails on a UTF-8 boundary", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('😀' + 'x'.repeat(22))"],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: () => true,
      },
    );

    expect(result.preservedStdoutLines).toEqual(["x".repeat(22)]);
  });

  it("supports independent stdout head and stderr tail caps", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write('abcdefgh'); process.stderr.write('12345678')",
      ],
      {
        maxOutputBytes: { stdout: 4, stderr: 4 },
        outputCapture: { stdout: "head", stderr: "tail" },
        timeoutMs: 3_000,
      },
    );

    expect(result.stdout).toBe("abcd");
    expect(result.stderr).toBe("5678");
    expect(result.stdoutTruncatedBytes).toBe(4);
    expect(result.stderrTruncatedBytes).toBe(4);
  });

  it("caps combined output in arrival order", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write('abcd'); setImmediate(() => process.stderr.write('efgh'))",
      ],
      {
        maxCombinedOutputBytes: 6,
        maxOutputBytes: 16,
        outputCapture: "head",
        timeoutMs: 3_000,
      },
    );

    expect(`${result.stdout}${result.stderr}`).toBe("abcdef");
    expect((result.stdoutTruncatedBytes ?? 0) + (result.stderrTruncatedBytes ?? 0)).toBe(2);
  });

  it("keeps the combined output tail when tail capture is selected", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('abcdefgh')"],
      {
        maxCombinedOutputBytes: 4,
        maxOutputBytes: 16,
        outputCapture: "tail",
        timeoutMs: 3_000,
      },
    );

    expect(result.stdout).toBe("efgh");
    expect(result.stdoutTruncatedBytes).toBe(4);
  });

  it("does not treat combined overflow as a selected stream overflow", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stderr.write('abcdefgh'); setImmediate(() => process.stdout.write('x'))",
      ],
      {
        maxCombinedOutputBytes: 8,
        maxOutputBytes: 16,
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 3_000,
      },
    );

    expect(result.termination).toBe("exit");
    expect(result.outputLimitExceeded).toBeUndefined();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("abcdefgh");
  });

  it("terminates commands that exceed a selected stream cap", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(100)); setInterval(() => {}, 1000)",
      ],
      {
        maxOutputBytes: { stdout: 16, stderr: 16 },
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 3_000,
      },
    );

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.termination).toBe("signal");
    expect(result.stdout).toBe("x".repeat(16));
  });

  it("rejects mixed capture modes under a combined cap", async () => {
    await expect(
      runCommandWithTimeout([process.execPath, "-e", "process.exit(0)"], {
        maxCombinedOutputBytes: 16,
        outputCapture: { stdout: "head", stderr: "tail" },
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow("maxCombinedOutputBytes requires matching stdout and stderr capture modes");
  });

  it("observes discarded output and stops without retaining it", async () => {
    let observedBytes = 0;
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)",
      ],
      {
        onOutputChunk: (chunk, stream) => {
          if (stream !== "stdout") {
            return true;
          }
          observedBytes += chunk.byteLength;
          return observedBytes < 32 * 1024;
        },
        outputCapture: { stdout: "discard", stderr: "tail" },
        timeoutMs: 3_000,
      },
    );

    expect(observedBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(result.stdout).toBe("");
    expect(result.stdoutTruncatedBytes).toBeGreaterThanOrEqual(observedBytes);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.termination).toBe("signal");
  });

  it("keeps truncated UTF-8 output on code point boundaries", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('a😀z')"],
      {
        maxOutputBytes: 3,
        timeoutMs: 3_000,
      },
    );

    expect(result.stdout).toBe("z");
    expect(result.stdout).not.toContain("�");
    expect(result.stdoutTruncatedBytes).toBe(5);
  });

  it("discards an entirely partial UTF-8 head", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('😀')"],
      {
        maxOutputBytes: 3,
        outputCapture: "head",
        timeoutMs: 3_000,
      },
    );

    expect(result.stdout).toBe("");
    expect(result.stdoutTruncatedBytes).toBe(4);
  });

  it("keeps argv values out of transport errors", async () => {
    const privateArg = "private-command-argument";
    const error = await runCommandWithTimeout(
      [`openclaw-missing-${process.pid}-${Date.now()}`, "--token", privateArg],
      { timeoutMs: 3_000 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateArg);
    expect(error).toMatchObject({ code: "ENOENT" });
  });
});

describe("runCommandBuffered", () => {
  it("preserves binary output and nonzero exit details", async () => {
    const result = await runCommandBuffered(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xff, 0, 0x61])); process.stderr.write('bad'); process.exit(7)",
      ],
      { timeoutMs: 3_000 },
    );

    expect(result).toMatchObject({ code: 7, termination: "exit" });
    expect(result.stdout).toEqual(Buffer.from([0xff, 0, 0x61]));
    expect(result.stderr).toEqual(Buffer.from("bad"));
  });

  it("reports the stream that exceeded its output cap", async () => {
    const result = await runCommandBuffered(
      [process.execPath, "-e", "void process.stderr; process.stdout.write('x'.repeat(100))"],
      { maxOutputBytes: { stdout: 16, stderr: 32 }, timeoutMs: 3_000 },
    );

    expect(result.termination).toBe("output-limit");
    expect(result.outputLimitStream).toBe("stdout");
    expect(result.stdout.byteLength).toBeLessThanOrEqual(16);
  });

  it("maps timeout and pre-aborted signals without throwing", async () => {
    const timedOut = await runCommandBuffered(
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      { timeoutMs: 20 },
    );
    expect(timedOut.termination).toBe("timeout");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runCommandBuffered([process.execPath, "-e", "process.exit(99)"], {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ code: null, termination: "signal", error: new Error("stop") });
  });

  it.runIf(process.platform !== "win32")(
    "force-kills inherited-pipe descendants after the direct child exits",
    { timeout: 5_000 },
    async () => {
      const descendantSource =
        "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('.'), 20)";
      const parentSource = [
        "const { spawn } = require('node:child_process')",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
        "child.unref()",
        "process.stdout.write(`PID:${child.pid}\\n`)",
      ].join(";");
      const result = await runCommandBuffered([process.execPath, "-e", parentSource], {
        timeoutMs: 50,
      });
      const pidMatch = result.stdout.toString().match(/PID:(\d+)/u);
      if (!pidMatch) {
        throw new Error(`missing descendant pid in ${result.stdout.toString()}`);
      }
      const descendantPid = Number(pidMatch[1]);

      try {
        expect(result).toMatchObject({ code: null, termination: "timeout" });
        let descendantExited = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            process.kill(descendantPid, 0);
          } catch {
            descendantExited = true;
            break;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        expect(descendantExited).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves a child-requested signal in buffered results",
    async () => {
      const result = await runCommandBuffered(
        [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
        { timeoutMs: 2_000 },
      );

      expect(result).toMatchObject({ code: null, signal: "SIGTERM", termination: "signal" });
      expect(result.error).toBeUndefined();
    },
  );

  it("can discard a diagnostic stream without applying its byte cap", async () => {
    const result = await runCommandBuffered(
      [
        process.execPath,
        "-e",
        "process.stderr.write('x'.repeat(1024)); process.stdout.write('ok')",
      ],
      {
        discardOutput: { stderr: true },
        maxOutputBytes: { stdout: 32, stderr: 8 },
        timeoutMs: 3_000,
      },
    );

    expect(result).toMatchObject({ code: 0, termination: "exit" });
    expect(result.stdout).toEqual(Buffer.from("ok"));
    expect(result.stderr).toEqual(Buffer.alloc(0));
  });

  it("keeps argv values out of buffered transport errors", async () => {
    const privateArg = "private-buffered-argument";
    const result = await runCommandBuffered(
      [`openclaw-missing-${process.pid}-${Date.now()}`, privateArg],
      { timeoutMs: 3_000 },
    );

    expect(result).toMatchObject({ code: null, termination: "error" });
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(result.error?.message).not.toContain(privateArg);
  });
});

describe("runExec", () => {
  it("captures stdout and stderr", async () => {
    await expect(
      runExec(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"]),
    ).resolves.toEqual({ stdout: "ok", stderr: "warn" });
  });

  it("preserves the numeric exit code on command failures", async () => {
    await expect(runExec(process.execPath, ["-e", "process.exit(7)"])).rejects.toMatchObject({
      code: 7,
      exitCode: 7,
    });
  });

  it("supports stdin and an explicit base environment", async () => {
    const { stdout, stderr } = await runExec(
      process.execPath,
      [
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write(process.env.OPENCLAW_RUN_EXEC_TEST ?? 'missing')",
      ],
      {
        baseEnv: { OPENCLAW_RUN_EXEC_TEST: "base" },
        input: Buffer.from("input"),
        timeoutMs: 3_000,
      },
    );
    expect(stdout).toBe("input");
    expect(stderr).toBe("base");
  });

  it("can keep sensitive output out of verbose logs", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(true);
    try {
      await runExec(
        process.execPath,
        ["-e", "process.stdout.write('private-out'); process.stderr.write('private-err')"],
        { logOutput: false },
      );
      await expect(
        runExec(
          process.execPath,
          ["-e", "process.stderr.write('private-failure'); process.exit(2)"],
          { logOutput: false },
        ),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      setVerbose(false);
    }

    expect(stdoutSpy.mock.calls.flat().join(" ")).not.toContain("private-out");
    expect(stderrSpy.mock.calls.flat().join(" ")).not.toMatch(/private-err|private-failure/u);
  });
});

describe("attachChildProcessBridge", () => {
  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    child.kill = kill as ChildProcess["kill"];
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });
    const addedSigterm = process
      .listeners("SIGTERM")
      .find((listener) => !beforeSigterm.has(listener));
    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);
    detach();
  });
});
