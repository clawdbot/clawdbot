import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signalProcessTree: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("./kill-tree.js", () => ({ signalProcessTree: mocks.signalProcessTree }));
vi.mock("@lydell/node-pty", () => ({ spawn: mocks.spawn }));

const { spawnTerminalPty } = await import("./terminal-pty.js");

function fakePty(pid = 4321) {
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
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

  afterEach(() => {
    vi.restoreAllMocks();
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

describe("terminal PTY invocation", () => {
  const nonInteractiveEnvironments: Array<Record<string, string>> = [
    {},
    { TERM: "" },
    { TERM: "dumb" },
    { TERM: "DUMB" },
    { TERM: " dumb " },
  ];

  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(nonInteractiveEnvironments)(
    "upgrades non-interactive TERM for a real PTY: %o",
    async (env) => {
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnTerminalPty({
        file: "/usr/bin/codex",
        args: ["resume", "thread"],
        env,
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledWith(
        "/usr/bin/codex",
        ["resume", "thread"],
        expect.objectContaining({
          name: "xterm-256color",
          env: expect.objectContaining({ TERM: "xterm-256color" }),
        }),
      );
    },
  );

  it("preserves an interactive TERM", async () => {
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnTerminalPty({
      file: "/usr/bin/codex",
      args: [],
      env: { TERM: "screen-256color" },
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/bin/codex",
      [],
      expect.objectContaining({
        name: "screen-256color",
        env: expect.objectContaining({ TERM: "screen-256color" }),
      }),
    );
  });

  it.each([".cmd", ".bat"])("wraps Windows %s shims through ComSpec", async (extension) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnTerminalPty({
      file: `C:\\Program Files\\Codex\\codex${extension}`,
      args: ["resume", "thread title"],
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `""C:\\Program Files\\Codex\\codex${extension}" resume "thread title""`],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
  });

  it("keeps executables and non-Windows commands direct", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());
    await spawnTerminalPty({
      file: "C:\\tools\\codex.exe",
      args: ["resume", "thread"],
      env: {},
      cols: 80,
      rows: 24,
    });

    platform.mockReturnValue("linux");
    mocks.spawn.mockReturnValueOnce(fakePty());
    await spawnTerminalPty({
      file: "/tmp/codex.cmd",
      args: [],
      env: {},
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      "C:\\tools\\codex.exe",
      ["resume", "thread"],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      "/tmp/codex.cmd",
      [],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
  });
});
