import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import {
  exitCliAfterOutput,
  requestExitAfterOneShotOutput,
  runCliWithExitFinalization,
} from "./one-shot-exit.js";

const successfulRun = async () => {};
const ignoreError = () => {};

function spyOnExit(onExit?: (code: number) => void) {
  const exited = createDeferred();
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    onExit?.(code);
    exited.resolve();
  });
  return {
    exit,
    waitForExit: async (code: number) => {
      await withTestTimeout(exited.promise, 1_000, "one-shot CLI did not exit");
      expect(exit).toHaveBeenCalledWith(code);
    },
  };
}

describe("one-shot CLI exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["default", "injected"])(
    "unwinds the %s runtime synchronously with the requested exit code",
    (kind) => {
      const exit = vi.fn();
      const runtime = kind === "default" ? defaultRuntime : { ...defaultRuntime, exit };
      const defaultExit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
      let thrown: unknown;
      try {
        exitCliAfterOutput(runtime, 7);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ExitError);
      expect(thrown).toMatchObject({ code: 7 });
      expect(defaultExit).not.toHaveBeenCalled();
      if (kind === "injected") {
        expect(exit).toHaveBeenCalledExactlyOnceWith(7);
      }
    },
  );

  it("preserves errors thrown by an injected runtime exit", () => {
    const failure = new Error("embedded runtime stopped");
    const exit = vi.fn(() => {
      throw failure;
    });
    const runtime = { ...defaultRuntime, exit };

    expect(() => exitCliAfterOutput(runtime, 7)).toThrow(failure);
    expect(exit).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("leaves a deferred exit owned by the injected runtime without reporting it again", async () => {
    const failure = new ExitError(7);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const onError = vi.fn();

    await expect(
      runCliWithExitFinalization({
        run: async () => {
          throw failure;
        },
        onError,
        runtime,
      }),
    ).rejects.toBe(failure);

    expect(onError).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    ["NODE_USE_SYSTEM_CA", { NODE_USE_SYSTEM_CA: "1" }, []],
    ["execArgv", {}, ["--use-system-ca"]],
    ["underscored execArgv", {}, ["--use_system_ca"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "'--use-system-ca'" }, []],
    ["underscored NODE_OPTIONS", { NODE_OPTIONS: "--use_system_ca" }, []],
  ] as const)(
    "exits after macOS system CA command completion from %s",
    async (_label, env, execArgv) => {
      const previousExitCode = process.exitCode;
      const { waitForExit } = spyOnExit();
      try {
        process.exitCode = 3;
        await runCliWithExitFinalization({
          run: successfulRun,
          onError: ignoreError,
          env: env as NodeJS.ProcessEnv,
          execArgv,
          platform: "darwin",
          markers: {},
        });
        await waitForExit(3);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it.each([
    ["non-macOS", "linux" as const, { NODE_USE_SYSTEM_CA: "1" }, []],
    ["system CA disabled", "darwin" as const, { NODE_USE_SYSTEM_CA: "0" }, []],
  ])("does not exit after completion when %s", async (_label, platform, env, execArgv) => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: env as NodeJS.ProcessEnv,
      execArgv: execArgv as string[],
      platform,
      markers: {},
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(exit).not.toHaveBeenCalled();
  });

  it("does not finalize a long-lived command until its run promise settles", async () => {
    const { exit, waitForExit } = spyOnExit();
    let finishRun: (() => void) | undefined;
    const runPromise = runCliWithExitFinalization({
      run: async () =>
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).not.toHaveBeenCalled();

    finishRun?.();
    await runPromise;
    await waitForExit(0);
  });

  it("reports failures and replaces a pending successful exit before draining", async () => {
    const previousExitCode = process.exitCode;
    const order: string[] = [];
    const { waitForExit } = spyOnExit((code) => {
      order.push(`exit:${String(code)}`);
    });

    try {
      process.exitCode = undefined;
      requestExitAfterOneShotOutput(defaultRuntime, 0);
      await runCliWithExitFinalization({
        run: async () => {
          throw new Error("command failed");
        },
        onError: async () => {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          order.push("reported");
          process.exitCode = 6;
        },
        env: { NODE_USE_SYSTEM_CA: "1" },
        execArgv: [],
        platform: "darwin",
        markers: {},
      });

      await waitForExit(6);
      expect(order).toEqual(["reported", "exit:6"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    { name: "successful completion", processExitCode: undefined, expectedExitCode: 0 },
    { name: "recorded command failure", processExitCode: 1, expectedExitCode: 1 },
    { name: "integer-string command failure", processExitCode: "9", expectedExitCode: 9 },
  ])(
    "preserves the final process outcome for $name",
    async ({ processExitCode, expectedExitCode }) => {
      const previousExitCode = process.exitCode;
      const { waitForExit } = spyOnExit();

      try {
        process.exitCode = undefined;
        await runCliWithExitFinalization({
          run: async () => {
            requestExitAfterOneShotOutput(defaultRuntime);
            process.exitCode = processExitCode;
          },
          onError: ignoreError,
          env: {},
          execArgv: [],
          platform: "linux",
          markers: {},
        });

        await waitForExit(expectedExitCode);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it.each([0, 7])("preserves an explicit exit override of %i", async (requestedExitCode) => {
    const previousExitCode = process.exitCode;
    const { waitForExit } = spyOnExit();

    try {
      process.exitCode = 9;
      requestExitAfterOneShotOutput(defaultRuntime, requestedExitCode);
      await runCliWithExitFinalization({
        run: successfulRun,
        onError: ignoreError,
        env: {},
        execArgv: [],
        platform: "linux",
        markers: {},
      });

      await waitForExit(requestedExitCode);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("normalizes a Node integer-string process exit code", async () => {
    const previousExitCode = process.exitCode;
    const { waitForExit } = spyOnExit();

    try {
      process.exitCode = "9";
      await runCliWithExitFinalization({
        run: successfulRun,
        onError: ignoreError,
        env: { NODE_USE_SYSTEM_CA: "1" },
        execArgv: [],
        platform: "darwin",
        markers: {},
      });
      await waitForExit(9);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves a command-specific exit code when system CA completion also requests exit", async () => {
    const { waitForExit } = spyOnExit();

    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    await waitForExit(7);
  });

  it("defers a requested exit until the outer finalizer", async () => {
    const { exit, waitForExit } = spyOnExit();

    expect(requestExitAfterOneShotOutput(defaultRuntime, 2)).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).not.toHaveBeenCalled();

    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: {},
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    await waitForExit(2);
  });

  it("does not request exits for embedded custom runtimes", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    expect(requestExitAfterOneShotOutput(runtime)).toBe(false);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      runtime,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("suppresses exits inside Vitest workers but not spawned CLI children", async () => {
    const { exit, waitForExit } = spyOnExit();
    const inheritedTestEnv = { VITEST: "1", VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv;

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: { tinypoolState: {} },
    });
    expect(exit).not.toHaveBeenCalled();

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    await waitForExit(0);
  });

  it("waits for stream callbacks even when writableLength is zero", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(0);
    vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(0);

    let flushStdout: (() => void) | undefined;
    let flushStderr: (() => void) | undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
      flushStdout = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((...args: unknown[]) => {
      flushStderr = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stderr.write);

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: {},
      execArgv: [],
      platform: "linux",
      markers: {},
    });

    expect(exit).not.toHaveBeenCalled();
    flushStdout?.();
    expect(exit).not.toHaveBeenCalled();
    flushStderr?.();
    expect(exit).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("falls back when stream drain callbacks never settle", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (() => true) as typeof process.stderr.write,
    );

    try {
      requestExitAfterOneShotOutput(defaultRuntime, 5);
      await runCliWithExitFinalization({
        run: successfulRun,
        onError: ignoreError,
        env: {},
        execArgv: [],
        platform: "linux",
        markers: {},
      });

      expect(exit).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(exit).toHaveBeenCalledWith(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["requested nonzero exit", "deferred ExitError"])(
    "drains large piped JSON before a %s without reporting another error",
    (exitMode) => {
      const env = { ...process.env };
      delete env.VITEST;
      delete env.VITEST_POOL_ID;
      delete env.VITEST_WORKER_ID;
      const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
      const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
      const payloadBytes = 1024 * 1024;
      const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime, ExitError } from ${JSON.stringify(runtimeUrl)};
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeJson({ ok: false, payload: "x".repeat(${payloadBytes}) });
          ${exitMode === "deferred ExitError" ? "throw new ExitError(7);" : "requestExitAfterOneShotOutput(defaultRuntime, 7);"}
        },
        onError: (error) => {
          process.stderr.write("unexpected error: " + String(error));
          process.exitCode = 1;
        },
      });
    `;

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        {
          encoding: "utf8",
          env,
          maxBuffer: 2 * payloadBytes,
          timeout: 30_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `${JSON.stringify({ ok: false, payload: "x".repeat(payloadBytes) }, null, 2)}\n`,
      );
    },
  );

  it.each([
    {
      name: "long help spelling consumed as a proxy URL",
      args: ["--proxy-url", "--help", "--json"],
      exitCode: 1,
      failure: true,
    },
    {
      name: "short help spelling consumed as a proxy URL",
      args: ["--proxy-url", "-h", "--json"],
      exitCode: 1,
      failure: true,
    },
    {
      name: "ordinary invalid proxy URL",
      args: ["--proxy-url", "invalid", "--json"],
      exitCode: 1,
      failure: true,
    },
    {
      name: "genuine command help after a boolean option",
      args: ["--json", "--help"],
      exitCode: 0,
      failure: false,
    },
  ])("keeps the real proxy command exit truthful for $name", ({ args, exitCode, failure }) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: "/dev/null",
      OPENCLAW_CONFIG_PATH: "/dev/null",
      TSX_DISABLE_CACHE: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeSnapshotUrl = new URL("../config/runtime-snapshot.ts", import.meta.url).href;
    const argvInvocationUrl = new URL("./argv-invocation.ts", import.meta.url).href;
    const proxyCliUrl = new URL("./proxy-cli.ts", import.meta.url).href;
    const script = `
      import { Command, CommanderError } from "commander";
      import { setRuntimeConfigSnapshot } from ${JSON.stringify(runtimeSnapshotUrl)};
      import { resolveCliArgvInvocation } from ${JSON.stringify(argvInvocationUrl)};
      import { registerProxyCli } from ${JSON.stringify(proxyCliUrl)};
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};

      setRuntimeConfigSnapshot({});
      const argv = ["node", "openclaw", "proxy", "validate", ...${JSON.stringify(args)}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().enablePositionalOptions().exitOverride();
          registerProxyCli(program);
          try {
            await program.parseAsync(argv);
          } catch (error) {
            if (!(error instanceof CommanderError) || error.exitCode !== 0) {
              throw error;
            }
            process.exitCode = error.exitCode;
          }
          if (resolveCliArgvInvocation(argv).hasHelpOrVersion) {
            requestExitAfterOneShotOutput();
          }
        },
        onError: (error) => { throw error; },
      });
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", env, timeout: 30_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(exitCode);
    if (failure) {
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          config: expect.objectContaining({
            errors: ["proxyUrl must use http:// or https://"],
          }),
        }),
      );
    } else {
      expect(result.stdout).toContain("Usage: openclaw proxy validate");
    }
  });

  it.each([
    { name: "deferred hooks success", exitCode: 0, explicitRequest: true },
    { name: "deferred hooks failure", exitCode: 1, explicitRequest: true },
    { name: "automatic macOS system-CA success", exitCode: 0, explicitRequest: false },
  ])("keeps real dual-TTY JSON clean for $name", ({ exitCode, explicitRequest }) => {
    const env = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeStdout(JSON.stringify({ ok: ${exitCode === 0} }));
          ${explicitRequest ? `requestExitAfterOneShotOutput(defaultRuntime, ${exitCode});` : ""}
        },
        onError: (error) => { throw error; },
        ${explicitRequest ? "" : 'env: { NODE_USE_SYSTEM_CA: "1" }, execArgv: [], platform: "darwin", markers: {},'}
      });
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", env, timeout: 30_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: exitCode === 0 });
    expect(result.stderr).toContain("\x1b[?25h");
  });

  it.each([
    { name: "fatal unhandled rejection", errorCode: "ERR_OUT_OF_MEMORY", exitCode: 1 },
    { name: "invalid configuration rejection", errorCode: "INVALID_CONFIG", exitCode: 78 },
  ])("keeps real dual-TTY JSON clean after $name", ({ errorCode, exitCode }) => {
    const env = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const unhandledRejectionsUrl = new URL("../infra/unhandled-rejections.ts", import.meta.url)
      .href;
    const script = `
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      import { installUnhandledRejectionHandler } from ${JSON.stringify(unhandledRejectionsUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      installUnhandledRejectionHandler();
      defaultRuntime.writeJson({ ok: false });
      const error = Object.assign(new Error("expected fatal test"), {
        code: ${JSON.stringify(errorCode)},
      });
      process.emit("unhandledRejection", error, Promise.resolve());
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", env, timeout: 30_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: false });
    expect(result.stderr).toContain("\x1b[?25h");
  });
});
