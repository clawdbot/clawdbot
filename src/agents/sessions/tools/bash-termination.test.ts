import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

const {
  completionMock,
  createTerminationControllerMock,
  settleTerminationMock,
  spawnMock,
  terminateMock,
} = vi.hoisted(() => ({
  completionMock: vi.fn(),
  createTerminationControllerMock: vi.fn(),
  settleTerminationMock: vi.fn(),
  spawnMock: vi.fn(),
  terminateMock: vi.fn(),
}));

vi.mock("../../../process/child-process.js", () => ({
  releaseChildProcessOutputAfterExit: vi.fn(() => vi.fn()),
}));

vi.mock("../../../process/exec.js", () => ({
  spawnCommand: (...args: unknown[]) => {
    const child = spawnMock(...args) as StubChild;
    const completion = completionMock(child).then((exitCode: number | null) => ({
      exitCode,
      failed: false,
    }));
    // oxlint-disable-next-line unicorn/no-thenable -- Execa subprocesses are event emitters and promises.
    child.then = completion.then.bind(completion);
    child.catch = completion.catch.bind(completion);
    child.finally = completion.finally.bind(completion);
    return child;
  },
}));

vi.mock("../../../process/exec-termination.js", () => ({
  createCommandTerminationController: createTerminationControllerMock,
}));

type StubChild = EventEmitter & {
  nodeChildProcess: StubChild;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  then: Promise<unknown>["then"];
  catch: Promise<unknown>["catch"];
  finally: Promise<unknown>["finally"];
};

function createStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.nodeChildProcess = child;
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe("local bash process-tree termination", () => {
  beforeEach(() => {
    vi.useRealTimers();
    completionMock.mockReset();
    settleTerminationMock.mockReset();
    settleTerminationMock.mockResolvedValue(undefined);
    terminateMock.mockReset();
    terminateMock.mockReturnValue(false);
    createTerminationControllerMock.mockReset();
    createTerminationControllerMock.mockReturnValue({
      terminate: terminateMock,
      settle: settleTerminationMock,
    });
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report a timeout until forced tree cleanup settles", async () => {
    vi.useFakeTimers();
    const child = createStubChild();
    const completion = createDeferred<number | null>();
    const cleanup = createDeferred();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(completion.promise);
    settleTerminationMock.mockReturnValue(cleanup.promise);
    const { createLocalBashOperations } = await import("./bash.js");

    const resultPromise = createLocalBashOperations().exec("echo late", process.cwd(), {
      onData: () => {},
      timeout: 0.01,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(createTerminationControllerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child,
        processTree: { mode: "force" },
        killGraceMs: 300,
      }),
    );
    expect(terminateMock).toHaveBeenCalledOnce();
    completion.resolve(null);
    let rejected = false;
    void resultPromise.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(rejected).toBe(false);
    cleanup.resolve();
    await expect(resultPromise).rejects.toThrow("timeout:0.01");
  });
});
