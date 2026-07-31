import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from "./one-shot-exit.js";

const successfulRun = async () => {};
const ignoreError = () => {};

describe("one-shot CLI exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
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
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
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
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
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
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("reports failures and replaces a pending successful exit before draining", async () => {
    const previousExitCode = process.exitCode;
    const order: string[] = [];
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
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

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(6));
      expect(order).toEqual(["reported", "exit:6"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("normalizes a Node integer-string process exit code", async () => {
    const previousExitCode = process.exitCode;
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

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
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(9));
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves a command-specific exit code when system CA completion also requests exit", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(7));
  });

  it("defers a requested exit until the outer finalizer", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

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
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
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
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
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
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
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

  it("drains large piped stdout before a requested nonzero exit", () => {
    const env = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const payloadBytes = 1024 * 1024;
    const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      await runCliWithExitFinalization({
        run: async () => {
          process.stdout.write("x".repeat(${payloadBytes}));
          requestExitAfterOneShotOutput(defaultRuntime, 7);
        },
        onError: (error) => { throw error; },
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
    expect(result.stdout).toHaveLength(payloadBytes);
  });
});
