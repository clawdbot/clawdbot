import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signalProcessTree: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../process/kill-tree.js", () => ({ signalProcessTree: mocks.signalProcessTree }));
vi.mock("@lydell/node-pty", () => ({ spawn: mocks.spawn }));

const { spawnTerminalPty } = await import("./pty.js");

function fakePty(pid = 4321) {
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  };
}

async function spawnFakePty(pid = 4321) {
  const pty = fakePty(pid);
  mocks.spawn.mockReturnValueOnce(pty);
  const handle = await spawnTerminalPty({
    file: "/bin/sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
  });
  return { handle, pty };
}

describe("terminal PTY teardown", () => {
  beforeEach(() => {
    mocks.signalProcessTree.mockReset();
    mocks.spawn.mockReset();
  });

  it.each([undefined, "SIGTERM"] as const)("signals the process tree for %s", async (signal) => {
    const { handle, pty } = await spawnFakePty();
    handle.kill(signal);
    expect(mocks.signalProcessTree).toHaveBeenCalledWith(4321, signal ?? "SIGKILL");
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("uses the PTY handle for non-terminating signals", async () => {
    const { handle, pty } = await spawnFakePty();
    handle.kill("SIGHUP");
    expect(mocks.signalProcessTree).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
  });

  it("tolerates an already-exited process", async () => {
    const { handle } = await spawnFakePty(0);
    expect(() => handle.kill()).not.toThrow();
  });
});
