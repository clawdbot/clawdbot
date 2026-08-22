import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  collectVitestProcessDiagnostics,
  writeVitestProcessDiagnostics,
} from "../../scripts/lib/vitest-process-diagnostics.mjs";

function result(stdout: string): SpawnSyncReturns<string> {
  return {
    error: undefined,
    output: [null, stdout, ""],
    pid: 1,
    signal: null,
    status: 0,
    stderr: "",
    stdout,
  };
}

describe("vitest process diagnostics", () => {
  it("collects bounded process, process-group, and fd evidence on macOS", () => {
    const spawnSyncImpl = vi.fn((command: string, args: readonly string[]) => {
      if (command === "ps" && args.at(-1) === "42") {
        return result("42 7 42 01:02 S 87.5 204800 - node vitest.mjs\n");
      }
      if (command === "pgrep") {
        return result("42\n43\n");
      }
      if (command === "ps") {
        return result(
          [
            "42 7 42 01:02 S 87.5 204800 - node vitest.mjs",
            "43 42 42 01:01 D 12.5 102400 wait worker.js",
          ].join("\n"),
        );
      }
      return result(
        [
          "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
          ...Array.from(
            { length: 30 },
            (_, index) => `node 42 user ${index}u REG 1,1 0 1 fd-${index}`,
          ),
        ].join("\n"),
      );
    });

    const lines = collectVitestProcessDiagnostics({
      pid: 42,
      platform: "darwin",
      spawnSyncImpl,
      fsImpl: { existsSync: () => false },
    });

    expect(lines).toContain(
      "[vitest] process: PID PPID PGID ELAPSED STATE CPU% RSS_KB WCHAN COMMAND",
    );
    expect(lines).toContain("[vitest] process: 42 7 42 01:02 S 87.5 204800 - node vitest.mjs");
    expect(lines).toContain("[vitest] process tree: PGID 42 (2 process(es))");
    expect(lines.some((line) => line.includes("43 42 42 01:01 D"))).toBe(true);
    expect(lines.some((line) => line.includes("unrelated"))).toBe(false);
    expect(lines).toContain("[vitest] fd summary: ... 7 more line(s) omitted");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "lsof",
      ["-nP", "-a", "-p", "42", "-d", "0-64"],
      expect.objectContaining({ maxBuffer: 131072, timeout: 1000 }),
    );
  });

  it("uses procfs for Linux fd evidence", () => {
    const spawnSyncImpl = vi.fn((command: string, args: readonly string[]) => {
      if (command === "ps" && args.at(-1) === "42") {
        return result("42 7 42 01:02 D 0.0 100 futex node vitest.mjs\n");
      }
      if (command === "pgrep") {
        return result("42\n");
      }
      if (command === "ps") {
        return result("42 7 42 01:02 D 0.0 100 futex node vitest.mjs\n");
      }
      return result("total 0\n1 -> pipe:[123]\n");
    });

    const lines = collectVitestProcessDiagnostics({
      pid: 42,
      platform: "linux",
      spawnSyncImpl,
      fsImpl: { existsSync: () => true },
    });

    expect(lines).toContain("[vitest] fd summary: 1 -> pipe:[123]");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "ls",
      ["-l", "/proc/42/fd"],
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("guards unsupported process-group and fd surfaces on Windows", () => {
    const spawnSyncImpl = vi.fn(() => result("Image Name: node.exe\nPID: 42\n"));

    const lines = collectVitestProcessDiagnostics({
      pid: 42,
      platform: "win32",
      spawnSyncImpl,
    });

    expect(lines).toContain(
      "[vitest] process: PID 42; PGID and wait channel are unavailable on win32",
    );
    expect(lines).toContain("[vitest] process tree unavailable on win32");
    expect(lines).toContain("[vitest] fd summary unavailable on win32");
  });

  it("logs diagnostics in collection order without throwing", () => {
    const log = vi.fn();
    writeVitestProcessDiagnostics({ pid: undefined, log });

    expect(log).toHaveBeenCalledWith(
      "[vitest] process diagnostics unavailable: child PID is missing",
    );
  });
});
