import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
} from "./test-support.js";

const { spawnMock, ptyKillMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  ptyKillMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

function createStubPty(pid = 1234) {
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const disposeData = vi.fn();
  const disposeExit = vi.fn();
  return {
    pid,
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: disposeData })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return { dispose: disposeExit };
    }),
    kill: (signal?: string) => ptyKillMock(signal),
    emitExit: (event: { exitCode: number; signal?: number }) => {
      exitListener?.(event);
    },
    disposeData,
    disposeExit,
  };
}

function expectSpawnEnv() {
  const options = firstSpawnCall()[2];
  if (options === undefined) {
    return undefined;
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("expected spawn options to be an object");
  }
  return (options as { env?: Record<string, string> }).env;
}

function expectSpawnCommand() {
  return firstSpawnCall()[0] as string;
}

function expectSpawnArgs() {
  return firstSpawnCall()[1] as string[];
}

function firstSpawnCall(): unknown[] {
  const [call] = spawnMock.mock.calls;
  if (!call) {
    throw new Error("expected spawn call");
  }
  return call;
}

describe("createPtyAdapter", () => {
  let createPtyAdapter: typeof import("./pty.js").createPtyAdapter;

  beforeAll(async () => {
    ({ createPtyAdapter } = await import("./pty.js"));
  });

  beforeEach(() => {
    spawnMock.mockClear();
    ptyKillMock.mockClear();
    killProcessTreeMock.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("forwards explicit signals to node-pty kill on non-Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty());

      const adapter = await createPtyAdapter({
        shell: "bash",
        args: ["-lc", "sleep 10"],
      });

      adapter.kill("SIGTERM");
      expect(ptyKillMock).toHaveBeenCalledWith("SIGTERM");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("uses process-tree kill for SIGKILL by default", async () => {
    spawnMock.mockReturnValue(createStubPty());

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    adapter.kill();
    expect(killProcessTreeMock).toHaveBeenCalledWith(1234);
    expect(ptyKillMock).not.toHaveBeenCalled();
  });

  it("wait does not settle immediately on SIGKILL", async () => {
    vi.useFakeTimers();
    spawnMock.mockReturnValue(createStubPty());

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    await expectWaitStaysPendingUntilSigkillFallback(adapter.wait(), () => {
      adapter.kill();
    });
  });

  it("prefers real PTY exit over SIGKILL fallback settle", async () => {
    vi.useFakeTimers();
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    await expectRealExitWinsOverSigkillFallback({
      waitPromise: adapter.wait(),
      triggerKill: () => {
        adapter.kill();
      },
      emitExit: () => {
        stub.emitExit({ exitCode: 0, signal: 9 });
      },
      expected: { code: 0, signal: 9 },
    });
  });

  it("resolves wait when exit fires before wait is called", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "exit 3"],
    });

    expect(stub.onExit).toHaveBeenCalledTimes(1);
    stub.emitExit({ exitCode: 3, signal: 0 });
    await expect(adapter.wait()).resolves.toEqual({ code: 3, signal: null });
    expect(adapter.stdin?.destroyed).toBe(true);
    expect(adapter.stdin?.writable).toBe(false);
  });

  it("reports stdin as non-writable after EOF or dispose", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "cat"],
    });

    expect(adapter.stdin?.writable).toBe(true);
    expect(adapter.stdin?.writableEnded).toBe(false);

    adapter.stdin?.end();
    expect(stub.write).toHaveBeenCalledWith(process.platform === "win32" ? "\x1a" : "\x04");
    expect(adapter.stdin?.writable).toBe(false);
    expect(adapter.stdin?.writableEnded).toBe(true);

    adapter.dispose();
    expect(adapter.stdin?.destroyed).toBe(true);
  });

  it("disposes PTY listeners", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "echo ok"],
    });
    adapter.onStdout(() => undefined);

    adapter.dispose();

    expect(stub.disposeData).toHaveBeenCalledTimes(1);
    expect(stub.disposeExit).toHaveBeenCalledTimes(1);
  });

  it("keeps inherited env when no override env is provided on non-Linux", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const stub = createStubPty();
      spawnMock.mockReturnValue(stub);

      await createPtyAdapter({
        shell: "bash",
        args: ["-lc", "env"],
      });

      expect(expectSpawnCommand()).toBe("bash");
      expect(expectSpawnArgs()).toEqual(["-lc", "env"]);
      expect(expectSpawnEnv()).toBeUndefined();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("wraps Linux PTY spawns so shell children inherit higher OOM score", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const stub = createStubPty();
      spawnMock.mockReturnValue(stub);

      await createPtyAdapter({
        shell: "bash",
        args: ["-lc", "env"],
        env: { PATH: "/usr/bin", BASH_ENV: "/tmp/bashenv" },
      });
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    expect(expectSpawnCommand()).toBe("/bin/sh");
    expect(expectSpawnArgs()).toEqual([
      "-c",
      'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      "bash",
      "-lc",
      "env",
    ]);
    expect(expectSpawnEnv()).toEqual({ PATH: "/usr/bin" });
  });

  it("passes explicit env overrides as strings", async () => {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);

    await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "env"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    expect(expectSpawnEnv()).toEqual({ FOO: "bar", COUNT: "12" });
  });

  it("does not pass a signal to node-pty on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty());

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGTERM");
      expect(ptyKillMock).toHaveBeenCalledWith(undefined);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("uses process-tree kill for SIGKILL on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty(4567));

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGKILL");
      expect(killProcessTreeMock).toHaveBeenCalledWith(4567);
      expect(ptyKillMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
