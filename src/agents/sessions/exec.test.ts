// execCommand tests cover child-process output retention, limits, and timeout
// termination semantics used by agent sessions.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completionMock, killProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  completionMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("../../process/child-process.js", () => ({
  releaseChildProcessOutputAfterExit: vi.fn(() => vi.fn()),
}));

vi.mock("../../process/exec.js", () => ({
  spawnCommand: (...args: unknown[]) => {
    const child = spawnMock(...args) as StubChild;
    const completion = completionMock(child).then((code: number | null) => ({
      exitCode: code,
      failed: false,
    }));
    // oxlint-disable-next-line unicorn/no-thenable -- Execa subprocesses are event emitters and promises.
    child.then = completion.then.bind(completion);
    return child;
  },
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

type StubChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  stderr: EventEmitter;
  stdout: EventEmitter;
  then: Promise<unknown>["then"];
};

function createStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // oxlint-disable-next-line unicorn/no-thenable -- Stub matches Execa's event-emitting promise shape.
  child.then = vi.fn() as unknown as Promise<unknown>["then"];
  return child;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("execCommand", () => {
  beforeEach(() => {
    killProcessTreeMock.mockReset();
    spawnMock.mockReset();
    completionMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds retained stdout and stderr independently", async () => {
    // stdout and stderr are separate buffers; a noisy stream must not evict the
    // diagnostic tail from the other stream.
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 256 });
    child.stdout.emit("data", Buffer.from(`${"a".repeat(300)}stdout-tail`));
    child.stderr.emit("data", Buffer.from(`${"b".repeat(300)}stderr-tail`));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(256);
    expect(result.stderr.length).toBeLessThanOrEqual(256);
    expect(result.stdout.endsWith("stdout-tail")).toBe(true);
    expect(result.stderr.endsWith("stderr-tail")).toBe(true);
    expect(result.stdoutTruncatedChars).toBeGreaterThan(0);
    expect(result.stderrTruncatedChars).toBeGreaterThan(0);
  });

  it("spawns commands with process-tree cleanup options", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", ["arg"], "/tmp");
    wait.resolve(0);
    await resultPromise;

    expect(spawnMock).toHaveBeenCalledWith(["cmd", "arg"], {
      buffer: false,
      cwd: "/tmp",
      detached: process.platform !== "win32",
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("honors caller-supplied small output caps", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 3 });
    child.stdout.emit("data", Buffer.from("abcdef"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("def");
    expect(result.stdoutTruncatedChars).toBe(3);
  });

  it("keeps caller-capped retained output UTF-16 safe", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 2 });
    child.stdout.emit("data", Buffer.from("A😀B"));
    child.stderr.emit("data", Buffer.from("C😀D"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("B");
    expect(result.stderr).toBe("D");
    expect(result.stdoutTruncatedChars).toBe(3);
    expect(result.stderrTruncatedChars).toBe(3);
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    const stdout = Buffer.from("stdout-😀-complete", "utf8");
    const stderr = Buffer.from("stderr-😀-complete", "utf8");
    child.stdout.emit("data", stdout.subarray(0, 9));
    child.stderr.emit("data", stderr.subarray(0, 9));
    child.stdout.emit("data", stdout.subarray(9));
    child.stderr.emit("data", stderr.subarray(9));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("stdout-😀-complete");
    expect(result.stderr).toBe("stderr-😀-complete");
  });

  it("flushes incomplete UTF-8 sequences when the process exits", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("data", Buffer.from([0xe2, 0x82]));
    child.stderr.emit("data", Buffer.from([0xf0, 0x9f, 0x98]));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("�");
    expect(result.stderr).toBe("�");
  });

  it("fails instead of silently truncating default exec output", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("data", Buffer.from(`${"x".repeat(16 * 1024 * 1024 - 1)}😀`));
    wait.resolve(0);

    const result = await resultPromise;
    expect(killProcessTreeMock).toHaveBeenCalledWith(1234, {
      detached: process.platform !== "win32",
      graceMs: 5000,
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
    expect(result.stdout.length).toBe(16 * 1024 * 1024 - 1);
    expect(result.stdout.endsWith("x")).toBe(true);
    expect(result.stdoutTruncatedChars).toBe(2);
    expect(result.stderr).toContain("exec stdout exceeded output limit");
  });

  it("terminates timed-out commands through the process-tree killer", async () => {
    // Extension exec uses the same tree-kill boundary as the built-in shell so
    // timed-out wrappers do not leave descendant processes running.
    vi.useFakeTimers();
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(killProcessTreeMock).toHaveBeenCalledWith(1234, {
      detached: process.platform !== "win32",
      graceMs: 5000,
    });
    expect(child.kill).not.toHaveBeenCalled();

    wait.resolve(null);
    const result = await resultPromise;
    expect(result.killed).toBe(true);
  });

  it("does not crash when stdout or stderr emit an error event", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("error", new Error("EPIPE"));
    child.stderr.emit("error", new Error("EIO"));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });
});
