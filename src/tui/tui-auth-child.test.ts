import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const killTreeMocks = vi.hoisted(() => ({ signalProcessTree: vi.fn() }));

vi.mock("../process/kill-tree.js", () => ({
  signalProcessTree: killTreeMocks.signalProcessTree,
}));

import { createTuiAuthChildOwner } from "./tui-auth-child.js";

function createChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(),
    pid,
    signalCode: null,
  }) as unknown as ChildProcess;
}

function emitExit(
  child: ChildProcess,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): void {
  Object.assign(child, { exitCode, signalCode: signal });
  child.emit("exit", exitCode, signal);
}

describe("TUI auth child owner", () => {
  afterEach(() => {
    vi.useRealTimers();
    killTreeMocks.signalProcessTree.mockReset();
  });

  it("does not spawn after terminal close", async () => {
    const owner = createTuiAuthChildOwner();
    const spawnChild = vi.fn(() => createChild(101));
    owner.close();

    await expect(owner.spawnAndWait(spawnChild)).rejects.toThrow("owner is closed");
    expect(spawnChild).not.toHaveBeenCalled();
    expect(owner.running).toBe(false);
  });

  it("waits for normal completion and releases the exact child", async () => {
    const owner = createTuiAuthChildOwner();
    const child = createChild(102);
    const result = owner.spawnAndWait(() => child);
    expect(owner.running).toBe(true);
    const secondSpawn = vi.fn(() => createChild(202));
    await expect(owner.spawnAndWait(secondSpawn)).rejects.toThrow("already running");
    expect(secondSpawn).not.toHaveBeenCalled();

    emitExit(child, 0, null);

    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(owner.running).toBe(false);
    expect(killTreeMocks.signalProcessTree).not.toHaveBeenCalled();
  });

  it("cancels gracefully, then force-kills only the still-active child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner = createTuiAuthChildOwner();
    const child = createChild(103);
    const result = owner.spawnAndWait(() => child);

    owner.close();
    owner.close();

    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledTimes(1);
    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledWith(103, "SIGTERM", {
      detached: false,
    });
    vi.advanceTimersByTime(999);
    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledTimes(1);
    expect(killTreeMocks.signalProcessTree).not.toHaveBeenCalledWith(103, "SIGKILL", {
      detached: false,
    });
    vi.advanceTimersByTime(1);
    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledTimes(2);
    expect(killTreeMocks.signalProcessTree).toHaveBeenNthCalledWith(2, 103, "SIGKILL", {
      detached: false,
    });

    emitExit(child, null, "SIGKILL");
    await expect(result).resolves.toEqual({ exitCode: null, signal: "SIGKILL" });
  });

  it("clears force escalation when the owned child exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner = createTuiAuthChildOwner();
    const child = createChild(104);
    const result = owner.spawnAndWait(() => child);
    owner.close();
    emitExit(child, null, "SIGTERM");

    await expect(result).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    vi.advanceTimersByTime(1_001);
    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledTimes(1);
    expect(killTreeMocks.signalProcessTree).toHaveBeenCalledWith(104, "SIGTERM", {
      detached: false,
    });
  });
});
