// execCommand tests cover child-process output retention, limits, and timeout
// termination semantics used by agent sessions.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, waitForChildProcessMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  waitForChildProcessMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../utils/child-process.js", () => ({
  waitForChildProcess: waitForChildProcessMock,
}));

type StubChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdout: EventEmitter;
};

function createStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
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
    spawnMock.mockReset();
    waitForChildProcessMock.mockReset();
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
    waitForChildProcessMock.mockReturnValue(wait.promise);
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

  it("honors caller-supplied small output caps", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 3 });
    child.stdout.emit("data", Buffer.from("abcdef"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("def");
    expect(result.stdoutTruncatedChars).toBe(3);
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
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
    waitForChildProcessMock.mockReturnValue(wait.promise);
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
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("data", Buffer.from("x".repeat(16 * 1024 * 1024 + 1)));
    wait.resolve(0);

    const result = await resultPromise;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
    expect(result.stdout.length).toBe(16 * 1024 * 1024);
    expect(result.stdoutTruncatedChars).toBe(1);
    expect(result.stderr).toContain("exec stdout exceeded output limit");
  });

  it("escalates timed-out commands to SIGKILL after the grace period", async () => {
    // SIGTERM gives child processes a chance to clean up; SIGKILL is the
    // bounded fallback so an ignored signal cannot hang the session.
    vi.useFakeTimers();
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    wait.resolve(null);
    const result = await resultPromise;
    expect(result.killed).toBe(true);
  });
});
