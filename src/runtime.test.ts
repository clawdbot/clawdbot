// Tests for terminal runtime helpers.
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../packages/terminal-core/src/progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

vi.mock("../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

import { restoreTerminalState } from "../packages/terminal-core/src/restore.js";
import { loggingState } from "./logging/state.js";
import {
  createNonExitingRuntime,
  defaultRuntime,
  ExitError,
  writeRuntimeJson,
  writeRuntimeStdout,
} from "./runtime.js";

describe("createNonExitingRuntime", () => {
  it("returns runtime with exit function", () => {
    const runtime = createNonExitingRuntime();
    expect(typeof runtime.exit).toBe("function");
  });

  it("exit function throws ExitError", () => {
    const runtime = createNonExitingRuntime();
    expect(() => runtime.exit(1)).toThrow(ExitError);
  });

  it("ExitError includes exit code", () => {
    const runtime = createNonExitingRuntime();
    expect(() => runtime.exit(42)).toThrow("exit 42");
    expect(() => runtime.exit(42)).toThrow(ExitError);
  });

  it("ExitError is distinguishable from generic Error", () => {
    const runtime = createNonExitingRuntime();
    try {
      runtime.exit(1);
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});

describe("writeRuntimeJson", () => {
  it("writes JSON using writeJson when available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" });
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 2);
  });

  it("writes JSON using log when writeJson not available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" });
    expect(runtime.log).toHaveBeenCalled();
  });

  it("uses custom space parameter", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" }, 4);
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 4);
  });

  it("handles zero space parameter", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" }, 0);
    expect(runtime.log).toHaveBeenCalledWith('{"key":"value"}');
  });
});

describe("writeRuntimeStdout", () => {
  it("uses the direct stdout writer when available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.writeStdout).toHaveBeenCalledWith("plain output");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("falls back to the runtime logger when no stdout writer is available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.log).toHaveBeenCalledWith("plain output");
  });
});

describe("defaultRuntime terminal restoration", () => {
  const originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(restoreTerminalState).mockReset();
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    if (originalStderrIsTTY) {
      Object.defineProperty(process.stderr, "isTTY", originalStderrIsTTY);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  it.each([0, 1])("keeps machine-readable stdout clean on exit %i", async (exitCode) => {
    const actualRestore = await vi.importActual<
      typeof import("../packages/terminal-core/src/restore.js")
    >("../packages/terminal-core/src/restore.js");
    vi.mocked(restoreTerminalState).mockImplementation(actualRestore.restoreTerminalState);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as typeof process.exit);
    loggingState.forceConsoleToStderr = true;

    defaultRuntime.writeJson({ ok: exitCode === 0 });
    expect(() => defaultRuntime.exit(exitCode)).toThrow(ExitError);

    expect(JSON.parse(stdout.join(""))).toEqual({ ok: exitCode === 0 });
    expect(stderr.join("")).toContain("\x1b[?25h");
  });

  it("preserves stdout terminal restoration for human output", async () => {
    const actualRestore = await vi.importActual<
      typeof import("../packages/terminal-core/src/restore.js")
    >("../packages/terminal-core/src/restore.js");
    vi.mocked(restoreTerminalState).mockImplementation(actualRestore.restoreTerminalState);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError(1);
    }) as typeof process.exit);
    loggingState.forceConsoleToStderr = false;

    defaultRuntime.writeStdout("operator-visible output");
    expect(() => defaultRuntime.exit(1)).toThrow(ExitError);

    expect(stdout.join("")).toContain("operator-visible output\n");
    expect(stdout.join("")).toContain("\x1b[?25h");
    expect(stderr).toEqual([]);
  });

  it("honors an explicitly selected reset stream in machine-output mode", async () => {
    const actualRestore = await vi.importActual<
      typeof import("../packages/terminal-core/src/restore.js")
    >("../packages/terminal-core/src/restore.js");
    vi.mocked(restoreTerminalState).mockImplementation(actualRestore.restoreTerminalState);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const resetWrite = vi.fn(() => true);
    const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError(1);
    }) as typeof process.exit);
    loggingState.forceConsoleToStderr = true;

    expect(() => defaultRuntime.exit(1, { resetStream })).toThrow(ExitError);

    expect(resetWrite).toHaveBeenCalledWith(expect.stringContaining("\x1b[?25h"));
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
