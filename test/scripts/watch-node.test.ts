// Watch Node tests cover watch node script behavior.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWatchMain } from "../../scripts/watch-node.mjs";

class FakeProcess extends EventEmitter {
  execPath = process.execPath;
  pid = 12345;
  stderr = {
    write: () => true,
  };
}

class FakeChild extends EventEmitter {
  signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      this.emit("exit", null, "SIGKILL");
    }
    return true;
  }
}

describe("watch-node shutdown cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the child and escalates when interrupted children ignore SIGTERM", async () => {
    vi.useFakeTimers();
    const fakeProcess = new FakeProcess();
    const child = new FakeChild();
    let resolvedCode: number | undefined;

    const run = runWatchMain({
      args: ["gateway"],
      createWatcher: () => ({ close: async () => {}, on: () => {} }),
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => child as never,
    }).then((code) => {
      resolvedCode = code;
      return code;
    });

    fakeProcess.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolvedCode).toBeUndefined();
    expect(child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe(143);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("waits for the auto-doctor child when interrupted during repair", async () => {
    vi.useFakeTimers();
    const fakeProcess = new FakeProcess();
    const runner = new FakeChild();
    const doctor = new FakeChild();
    const children = [runner, doctor];
    let resolvedCode: number | undefined;

    const run = runWatchMain({
      args: ["gateway"],
      createWatcher: () => ({ close: async () => {}, on: () => {} }),
      env: {},
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => children.shift() as never,
    }).then((code) => {
      resolvedCode = code;
      return code;
    });

    runner.emit("exit", 1, null);
    expect(children).toHaveLength(0);

    fakeProcess.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolvedCode).toBeUndefined();
    expect(doctor.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe(143);
    expect(doctor.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
