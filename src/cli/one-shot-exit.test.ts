import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { flushExitAfterOneShotOutput, requestExitAfterOneShotOutput } from "./one-shot-exit.js";

describe("one-shot CLI exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers the requested exit code until the top-level flush", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    expect(requestExitAfterOneShotOutput(defaultRuntime, 2)).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(exit).not.toHaveBeenCalled();
    flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
  });

  it("does not request exits for embedded custom runtimes", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    expect(requestExitAfterOneShotOutput(runtime)).toBe(false);
    flushExitAfterOneShotOutput(runtime, {} as NodeJS.ProcessEnv, {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("suppresses exits inside Vitest workers but not spawned CLI children", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    const inheritedTestEnv = { VITEST: "1", VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv;

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, inheritedTestEnv, { tinypoolState: {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).not.toHaveBeenCalled();

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, inheritedTestEnv, {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("waits for stream callbacks even when writableLength is zero", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(0);
    vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(0);

    let flushStdout: (() => void) | undefined;
    let flushStderr: (() => void) | undefined;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      flushStdout = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stdout.write);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      flushStderr = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stderr.write);

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});

    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(stderrWrite).toHaveBeenCalledOnce();
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
});
