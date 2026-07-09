// Agent Core tests cover nodejs behavior.
import { EventEmitter } from "node:events";
import { parse } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "./nodejs.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function mockSpawnChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawnMock.mockReturnValue(child);
  return child as typeof child & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
}

function createMockExecEnv(): NodeExecutionEnv {
  return new NodeExecutionEnv({ cwd: process.cwd(), shellPath: process.execPath });
}

async function waitForSpawnCall(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (spawnMock.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("expected spawn to be called");
}

describe("NodeExecutionEnv file metadata", () => {
  let env: NodeExecutionEnv;
  let tempDir: string;

  beforeEach(async () => {
    const rootEnv = new NodeExecutionEnv({ cwd: process.cwd() });
    const created = await rootEnv.createTempDir("agent-core-nodejs-");
    if (!created.ok) {
      throw created.error;
    }
    tempDir = created.value;
    env = new NodeExecutionEnv({ cwd: tempDir });
  });

  afterEach(async () => {
    const removed = await env.remove(tempDir, { recursive: true, force: true });
    if (!removed.ok) {
      throw removed.error;
    }
  });

  it("reports basenames consistently from fileInfo and listDir", async () => {
    const written = await env.writeFile("notes/todo.txt", "hello");
    expect(written.ok).toBe(true);

    const info = await env.fileInfo("notes/todo.txt");
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.name).toBe("todo.txt");
    }

    const entries = await env.listDir("notes");
    expect(entries.ok).toBe(true);
    if (entries.ok) {
      expect(entries.value.map((entry) => entry.name)).toEqual(["todo.txt"]);
    }
  });

  it("reports an empty basename for the filesystem root", async () => {
    const info = await env.fileInfo(parse(tempDir).root);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.name).toBe("");
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves backslashes in POSIX filenames",
    async () => {
      const fileName = "notes\\todo.txt";
      const written = await env.writeFile(fileName, "hello");
      expect(written.ok).toBe(true);

      const info = await env.fileInfo(fileName);
      expect(info.ok).toBe(true);
      if (info.ok) {
        expect(info.value.name).toBe(fileName);
      }
    },
  );
});

describe("NodeExecutionEnv timeout handling", () => {
  let env: NodeExecutionEnv;

  beforeEach(() => {
    env = createMockExecEnv();
  });

  it.each([
    { timeout: 1, expectedDelayMs: 1_000 },
    { timeout: 1.5, expectedDelayMs: 1_500 },
    { timeout: 0.0005, expectedDelayMs: 1 },
    { timeout: Number.MAX_SAFE_INTEGER, expectedDelayMs: 2_147_000_000 },
  ])("schedules timeout $timeout as $expectedDelayMs ms", async ({ timeout, expectedDelayMs }) => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const child = mockSpawnChild();

    const resultPromise = env.exec("echo hello", { timeout });
    await waitForSpawnCall();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), expectedDelayMs);
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });

  it.each([undefined, Number.NaN, 0, -1])(
    "does not schedule an invalid timeout value %s",
    async (timeout) => {
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const child = mockSpawnChild();

      const resultPromise = env.exec("echo hello", { timeout });
      await waitForSpawnCall();

      expect(timeoutSpy).not.toHaveBeenCalled();
      child.emit("close", 0);
      await expect(resultPromise).resolves.toMatchObject({ ok: true });
    },
  );
});

describe("NodeExecutionEnv exec stream errors", () => {
  let env: NodeExecutionEnv;

  beforeEach(() => {
    env = createMockExecEnv();
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects with spawn_error when %s stream emits an error",
    async (streamName) => {
      const child = mockSpawnChild();

      const resultPromise = env.exec("echo hello");
      await waitForSpawnCall();

      child[streamName].emit("error", new Error(`${streamName} EPIPE`));

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("spawn_error");
        expect(result.error.message).toContain(`${streamName} read error`);
        expect(result.error.message).toContain("EPIPE");
      }
    },
  );

  it("keeps the other stream guarded after a stdout error", async () => {
    const child = mockSpawnChild();

    const resultPromise = env.exec("echo hello");
    await waitForSpawnCall();

    child.stdout.emit("error", new Error("stdout EPIPE"));

    // stderr error after stdout already failed must not throw
    expect(() => {
      child.stderr.emit("error", new Error("stderr later"));
    }).not.toThrow();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stdout read error");
    }
  });

  it("completes normally when no stream errors occur", async () => {
    const child = mockSpawnChild();

    const resultPromise = env.exec("echo hello");
    await waitForSpawnCall();
    child.emit("close", 0);

    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });

  it("contains stdout errors during Windows shell discovery", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // Force PATH discovery even on Windows hosts with Git Bash in Program Files.
    vi.stubEnv("ProgramFiles", "");
    vi.stubEnv("ProgramFiles(x86)", "");
    try {
      const child = mockSpawnChild();
      const resultPromise = new NodeExecutionEnv({ cwd: process.cwd() }).exec("echo hello");
      await waitForSpawnCall();
      expect(spawnMock.mock.calls[0]?.[0]).toBe("where");
      expect(spawnMock.mock.calls[0]?.[1]).toEqual(["bash.exe"]);

      child.stdout.emit("error", new Error("where stdout failed"));

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("shell_unavailable");
      }
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });
});
