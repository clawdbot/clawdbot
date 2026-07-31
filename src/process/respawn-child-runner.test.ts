// Respawn child runner tests cover signal forwarding and process-tree cleanup.
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalProcessTreeMock = vi.hoisted(() => vi.fn());

vi.mock("./kill-tree.js", () => ({
  signalProcessTree: signalProcessTreeMock,
}));

import { runRespawnChildWithSignalBridge } from "./respawn-child-runner.js";

function createChild(pid?: number): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill,
  }) as unknown as ChildProcess;
  return { child, kill };
}

describe("runRespawnChildWithSignalBridge", () => {
  beforeEach(() => {
    signalProcessTreeMock.mockReset();
  });

  it("spawns POSIX respawn children detached for process-group cleanup", () => {
    const { child } = createChild(1234);
    const spawnChild = vi.fn(() => child);

    runRespawnChildWithSignalBridge({
      command: "/usr/bin/node",
      args: ["/repo/openclaw/dist/entry.js"],
      env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
      detachForProcessTree: true,
      stdioIsTerminal: false,
      runtime: {
        spawn: spawnChild as unknown as typeof spawn,
        attachChildProcessBridge: vi.fn(),
        exit: vi.fn() as unknown as (code?: number) => never,
      },
      onError: vi.fn(),
    });

    expect(spawnChild).toHaveBeenCalledWith("/usr/bin/node", ["/repo/openclaw/dist/entry.js"], {
      stdio: "inherit",
      env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
      detached: process.platform !== "win32",
    });
  });

  it.each([
    { signal: "SIGINT" as const, laterSignal: "SIGTERM" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, laterSignal: "SIGINT" as const, exitCode: 143 },
  ])("exits $exitCode when the child exits by forwarded $signal", (testCase) => {
    const { child } = createChild(2345);
    const exit = vi.fn();
    let onSignal: ((signal: NodeJS.Signals) => void) | undefined;

    runRespawnChildWithSignalBridge({
      command: "/usr/bin/node",
      args: ["/repo/openclaw/dist/entry.js"],
      env: {},
      runtime: {
        spawn: vi.fn(() => child) as unknown as typeof spawn,
        attachChildProcessBridge: vi.fn((_child, options) => {
          onSignal = options?.onSignal;
          return { detach: vi.fn() };
        }),
        exit: exit as unknown as (code?: number) => never,
      },
      onError: vi.fn(),
    });

    onSignal?.(testCase.signal);
    onSignal?.(testCase.laterSignal);
    child.emit("exit", null, testCase.signal);

    expect(exit).toHaveBeenCalledWith(testCase.exitCode);
  });

  it("signals detached respawn process groups after forwarded signal grace", () => {
    vi.useFakeTimers();
    const { child, kill } = createChild(2468);
    const spawnChild = vi.fn(() => child);
    const exit = vi.fn();
    let onSignal: ((signal: NodeJS.Signals) => void) | undefined;

    try {
      runRespawnChildWithSignalBridge({
        command: "/usr/bin/node",
        args: ["/repo/openclaw/dist/entry.js"],
        env: {},
        detachForProcessTree: true,
        stdioIsTerminal: false,
        runtime: {
          spawn: spawnChild as unknown as typeof spawn,
          attachChildProcessBridge: vi.fn((_child, options) => {
            onSignal = options?.onSignal;
            return { detach: vi.fn() };
          }),
          exit: exit as unknown as (code?: number) => never,
        },
        onError: vi.fn(),
      });

      onSignal?.("SIGTERM");
      vi.advanceTimersByTime(1_000);

      if (process.platform === "win32") {
        expect(signalProcessTreeMock).not.toHaveBeenCalled();
        expect(kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(signalProcessTreeMock).toHaveBeenCalledWith(2468, "SIGTERM", {
          detached: true,
        });
        expect(kill).not.toHaveBeenCalled();
      }

      vi.advanceTimersByTime(1_000);

      if (process.platform === "win32") {
        expect(kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(signalProcessTreeMock).toHaveBeenCalledWith(2468, "SIGKILL", {
          detached: true,
        });
      }

      child.emit("exit", null, "SIGKILL");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-kills detached groups when the root child exits after a parent signal", () => {
    vi.useFakeTimers();
    const { child, kill } = createChild(3579);
    const spawnChild = vi.fn(() => child);
    const exit = vi.fn();
    let onSignal: ((signal: NodeJS.Signals) => void) | undefined;

    try {
      runRespawnChildWithSignalBridge({
        command: "/usr/bin/node",
        args: ["/repo/openclaw/dist/entry.js"],
        env: {},
        detachForProcessTree: true,
        stdioIsTerminal: false,
        runtime: {
          spawn: spawnChild as unknown as typeof spawn,
          attachChildProcessBridge: vi.fn((_child, options) => {
            onSignal = options?.onSignal;
            return { detach: vi.fn() };
          }),
          exit: exit as unknown as (code?: number) => never,
        },
        onError: vi.fn(),
      });

      onSignal?.("SIGTERM");
      child.emit("exit", 0, null);

      if (process.platform === "win32") {
        expect(signalProcessTreeMock).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
      } else {
        expect(signalProcessTreeMock).toHaveBeenCalledWith(3579, "SIGKILL", {
          detached: true,
        });
      }
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal stdio respawn children attached", () => {
    const { child } = createChild(4444);
    const spawnChild = vi.fn(() => child);

    runRespawnChildWithSignalBridge({
      command: "/usr/bin/node",
      args: ["/repo/openclaw/dist/entry.js", "configure"],
      env: {},
      detachForProcessTree: true,
      stdioIsTerminal: true,
      runtime: {
        spawn: spawnChild as unknown as typeof spawn,
        attachChildProcessBridge: vi.fn(),
        exit: vi.fn() as unknown as (code?: number) => never,
      },
      onError: vi.fn(),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/repo/openclaw/dist/entry.js", "configure"],
      {
        stdio: "inherit",
        env: {},
        detached: false,
      },
    );
  });
});
