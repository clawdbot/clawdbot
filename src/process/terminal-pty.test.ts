import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";

const mocks = vi.hoisted(() => ({
  signalPtySessionTree: vi.fn(),
  signalProcessTree: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("./kill-tree.js", () => ({
  signalProcessTree: mocks.signalProcessTree,
  signalPtySessionTree: mocks.signalPtySessionTree,
}));
vi.mock("@lydell/node-pty", () => ({ spawn: mocks.spawn }));

const { spawnTerminalPty } = await import("./terminal-pty.js");

const tempDirs: string[] = [];

function createWindowsNpmShim(command: string) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-shim-"));
  tempDirs.push(binDir);
  const entrypoint = path.join(binDir, "node_modules", "@openai", command, "bin", `${command}.js`);
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "", "utf8");
  const relativeEntrypoint = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
  const shimPath = path.join(binDir, `${command}.cmd`);
  fs.writeFileSync(
    shimPath,
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n" +
      'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relativeEntrypoint}" %*\r\n`,
    "utf8",
  );
  return { entrypoint, shimPath };
}

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
    mocks.signalPtySessionTree.mockReset();
    mocks.signalProcessTree.mockReset();
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.each([undefined, "SIGTERM"] as const)("signals the process tree for %s", async (signal) => {
    const { handle, pty } = await spawnFakePty();
    handle.kill(signal);
    expect(mocks.signalPtySessionTree).toHaveBeenCalledWith(4321, signal ?? "SIGKILL");
    expect(mocks.signalProcessTree).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("uses the PTY handle for non-terminating signals", async () => {
    const { handle, pty } = await spawnFakePty();
    handle.kill("SIGHUP");
    expect(mocks.signalPtySessionTree).not.toHaveBeenCalled();
    if (process.platform === "win32") {
      expect(pty.kill).toHaveBeenCalledWith();
    } else {
      expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
    }
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

  it("canonicalizes a case-insensitive Windows TERM key", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnTerminalPty({
      file: "powershell.exe",
      args: [],
      env: { Term: "screen-256color" },
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      [],
      expect.objectContaining({
        name: "screen-256color",
        env: { TERM: "screen-256color" },
      }),
    );
  });

  it.each([
    [".cmd", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "C:\\Windows\\System32\\cmd.exe"],
    [".bat", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, "C:\\Windows\\System32\\cmd.exe"],
    [".cmd", { cOmSpEc: "C:\\tools\\custom-cmd.exe" }, "C:\\tools\\custom-cmd.exe"],
    [
      ".bat",
      {
        ComSpec: "C:\\Windows\\System32\\ambient-cmd.exe",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      "C:\\Windows\\System32\\cmd.exe",
    ],
  ])("wraps Windows %s shims through ComSpec", async (extension, env, expectedComSpec) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnTerminalPty({
      file: `C:\\Program Files\\Codex\\codex${extension}`,
      args: ["resume", "thread title"],
      env,
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      expectedComSpec,
      ["/d", "/s", "/c", `""C:\\Program Files\\Codex\\codex${extension}" resume "thread title""`],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
  });

  it.runIf(process.platform === "win32")(
    "passes arbitrary Codex initial-message text literally through an npm shim",
    async () => {
      const { entrypoint, shimPath } = createWindowsNpmShim("codex");
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnTerminalPty({
        file: shimPath,
        args: ["exec", "--", "Fix A&B and 100%"],
        env: { PATH: path.dirname(process.execPath), PATHEXT: ".EXE;.CMD" },
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        [entrypoint, "exec", "--", "Fix A&B and 100%"],
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "uses PATH node.exe instead of a packaged non-Node host for an npm shim",
    async () => {
      const { entrypoint, shimPath } = createWindowsNpmShim("codex");
      const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-node-"));
      tempDirs.push(nodeDir);
      const nodePath = path.join(nodeDir, "node.exe");
      fs.linkSync(process.execPath, nodePath);
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        "C:\\Program Files\\OpenClaw\\openclaw.exe",
      );
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnTerminalPty({
        file: shimPath,
        args: ["--", "literal"],
        env: { PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
        cols: 80,
        rows: 24,
      });

      const [command, argv] = mocks.spawn.mock.calls[0] ?? [];
      expect(String(command).toLowerCase()).toBe(nodePath.toLowerCase());
      expect(argv).toEqual([entrypoint, "--", "literal"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when an npm shim has no Node executable",
    async () => {
      const { shimPath } = createWindowsNpmShim("codex");
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        "C:\\Program Files\\OpenClaw\\openclaw.exe",
      );

      await expect(
        spawnTerminalPty({
          file: shimPath,
          args: ["--", "literal"],
          env: { PATH: path.dirname(shimPath), PATHEXT: ".EXE;.CMD" },
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow(/Node executable/);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps unknown batch wrappers on the guarded cmd path",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-custom-"));
      tempDirs.push(tempDir);
      const wrapperPath = path.join(tempDir, "custom.cmd");
      fs.writeFileSync(wrapperPath, "@ECHO off\r\necho custom\r\n", "utf8");

      await expect(
        spawnTerminalPty({
          file: wrapperPath,
          args: ["Fix A&B and 100%"],
          env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow("Unsafe Windows cmd.exe argument");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "passes a bare-only native host directly to the PTY spawn owner",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-bare-"));
      tempDirs.push(tempDir);
      const barePath = path.join(tempDir, "bare-host");
      fs.copyFileSync(process.execPath, barePath);
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnTerminalPty({
        file: barePath,
        args: ["--version"],
        env: {},
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledWith(
        barePath,
        ["--version"],
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    },
  );

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

describe.runIf(process.platform !== "win32")("terminal PTY process-session teardown", () => {
  it("kills a background job in a distinct process group within the PTY session", async () => {
    vi.resetModules();
    vi.doUnmock("@lydell/node-pty");
    vi.doUnmock("./kill-tree.js");
    const { spawnTerminalPty: spawnRealTerminalPty } = await import("./terminal-pty.js");
    const handle = await spawnRealTerminalPty({
      file: "/bin/bash",
      args: ["-l"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() },
      cols: 80,
      rows: 24,
    });
    let output = "";
    let shellPid: number | undefined;
    let childPid: number | undefined;
    handle.onData((chunk) => {
      output += chunk;
    });

    try {
      handle.write(
        'sleep 300 & child=$(jobs -p); printf \'__OPENCLAW_PIDS__ %s %s\\n\' "$$" "$child"\r',
      );
      await vi.waitFor(
        () => {
          const match = output.match(/__OPENCLAW_PIDS__\s+(\d+)\s+(\d+)/u);
          expect(match, output).toBeTruthy();
          shellPid = Number(match?.[1]);
          childPid = Number(match?.[2]);
        },
        { timeout: 3_000 },
      );
      if (!shellPid || !childPid) {
        throw new Error("missing PTY process ids");
      }
      const ps = spawnSync(
        "ps",
        [
          "-o",
          process.platform === "darwin" ? "pid=,pgid=,tty=" : "pid=,pgid=,sid=",
          "-p",
          `${shellPid},${childPid}`,
        ],
        { encoding: "utf8" },
      );
      const rows = ps.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, pgid, session] = line.trim().split(/\s+/u);
          return { pid: Number(pid), pgid: Number(pgid), session };
        });
      const shell = rows.find((row) => row.pid === shellPid);
      const child = rows.find((row) => row.pid === childPid);
      expect(shell).toMatchObject({ pid: shellPid, pgid: shellPid });
      expect(child?.pgid).not.toBe(shellPid);
      expect(child?.session).toBe(shell?.session);
      if (process.platform !== "darwin") {
        expect(Number(shell?.session)).toBe(shellPid);
      }

      handle.kill();
      expect(await waitForPidToExit(shellPid, 2_000)).toBe(true);
      expect(await waitForPidToExit(childPid, 2_000)).toBe(true);
    } finally {
      try {
        handle.kill();
      } catch {
        // Already gone.
      }
      killPidIfAlive(childPid);
      killPidIfAlive(shellPid);
    }
  });
});
