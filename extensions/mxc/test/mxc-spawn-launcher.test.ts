import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/mxc-spawn-launcher.mjs",
);

const loadLauncher = () =>
  require(launcherPath) as {
    decodePayload: (argv: string[]) => unknown;
    exitOnChildProcessClose: (
      child: {
        on: (event: string, listener: (exitCode: number | null, signal?: string) => void) => void;
      },
      options?: { exit?: (code: number) => void },
    ) => void;
    forwardSignals: (
      spawned: { kill: (signal: string) => void },
      options?: {
        exit?: (code: number) => void;
        exitGraceMs?: number;
        setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
      },
    ) => void;
    signalExitCode: (signal: number | string | undefined) => number;
  };

describe("mxc-spawn-launcher", () => {
  it("decodes a JSON --payload-file and removes it before spawning", () => {
    const { decodePayload } = loadLauncher();
    const dir = mkdtempSync(path.join(tmpdir(), "mxc-launcher-test-"));
    const payloadFile = path.join(dir, "payload.json");
    const body = { config: { process: { env: ["SECRET=value"] } }, options: {} };
    try {
      writeFileSync(payloadFile, JSON.stringify(body), "utf-8");

      expect(decodePayload(["--payload-file", payloadFile])).toEqual(body);
      expect(existsSync(payloadFile)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("throws when --payload is missing", () => {
    const { decodePayload } = loadLauncher();

    expect(() => decodePayload([])).toThrow(/Missing --payload-file/);
  });

  it("maps PTY signal exits to process exit codes", () => {
    const { signalExitCode } = loadLauncher();

    expect(signalExitCode(15)).toBe(143);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGUNKNOWN")).toBe(1);
    expect(signalExitCode(undefined)).toBe(1);
  });

  it("forwards process termination signals to spawned sandbox children", () => {
    const { forwardSignals } = loadLauncher();
    const listeners = new Map<string, () => void>();
    const processOn = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (typeof event === "string" && typeof listener === "function") {
        listeners.set(event, listener as () => void);
      }
      return process;
    });
    const spawned = { kill: vi.fn() };
    const exit = vi.fn();
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const setTimeoutMock = vi.fn((callback: () => void, ms: number) => {
      const timer = { callback, ms, unref: vi.fn() };
      timers.push(timer);
      return timer;
    });
    try {
      forwardSignals(spawned, { exit, exitGraceMs: 25, setTimeout: setTimeoutMock });

      listeners.get("SIGTERM")?.();
      listeners.get("SIGINT")?.();

      expect(spawned.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawned.kill).toHaveBeenCalledWith("SIGINT");
      expect(setTimeoutMock).toHaveBeenCalledTimes(1);
      expect(timers[0]?.ms).toBe(25);
      expect(timers[0]?.unref).toHaveBeenCalledTimes(1);

      timers[0]?.callback();

      expect(exit).toHaveBeenCalledWith(143);
    } finally {
      processOn.mockRestore();
    }
  });

  it("exits non-PTY child processes after stdio close", () => {
    const { exitOnChildProcessClose } = loadLauncher();
    const listeners = new Map<string, (exitCode: number | null, signal?: string) => void>();
    const child = {
      on: vi.fn((event: string, listener: (exitCode: number | null, signal?: string) => void) => {
        listeners.set(event, listener);
      }),
    };
    const exit = vi.fn();

    exitOnChildProcessClose(child, { exit });

    expect(child.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(child.on).not.toHaveBeenCalledWith("exit", expect.any(Function));

    listeners.get("close")?.(null, "SIGTERM");

    expect(exit).toHaveBeenCalledWith(143);
  });
});
