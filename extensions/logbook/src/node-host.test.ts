// Logbook node-host tests cover screenshot subprocess deadline behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readFileMock, rmMock, runExecMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => Buffer.from("jpeg")),
  rmMock: vi.fn(async () => undefined),
  runExecMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: readFileMock,
  rm: rmMock,
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => "/data/openclaw-tests",
}));

import { handleLogbookSnapshot } from "./node-host.js";

type RunExecOptions = { logOutput?: boolean; signal?: AbortSignal };

function runExecSignal(callIndex: number): AbortSignal {
  const options = runExecMock.mock.calls[callIndex]?.[2] as RunExecOptions | undefined;
  if (!options?.signal) {
    throw new Error(`missing runExec signal for call ${callIndex}`);
  }
  return options.signal;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("command aborted"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

describe("handleLogbookSnapshot", () => {
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("snapshot command timed out", "TimeoutError"));
      }, timeoutMs);
      return controller.signal;
    });
    runExecMock.mockReset();
    readFileMock.mockClear();
    rmMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a stalled capture before the node.invoke deadline and skips resize", async () => {
    runExecMock.mockImplementationOnce(
      async (_command: string, _args: string[], options: RunExecOptions) =>
        await rejectWhenAborted(options.signal as AbortSignal),
    );

    const snapshot = handleLogbookSnapshot({});
    await vi.advanceTimersByTimeAsync(0);

    expect(runExecMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(25_000);
    const signal = runExecSignal(0);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(24_999);
    expect(signal.aborted).toBe(false);
    expect(runExecMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(snapshot).resolves.toEqual({ error: "snapshot command timed out" });
    expect(signal.aborted).toBe(true);
    expect(runExecMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledOnce();
  });

  it("shares the capture deadline with the resize command", async () => {
    runExecMock.mockImplementation(
      async (command: string, _args: string[], options: RunExecOptions) => {
        if (command === "screencapture") {
          return await new Promise<{ stdout: string; stderr: string }>((resolve) => {
            setTimeout(() => resolve({ stdout: "", stderr: "" }), 20_000);
          });
        }
        return await rejectWhenAborted(options.signal as AbortSignal);
      },
    );

    const snapshot = handleLogbookSnapshot({});
    await vi.advanceTimersByTimeAsync(0);
    const captureSignal = runExecSignal(0);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(runExecMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runExecMock).toHaveBeenCalledTimes(2);
    const resizeSignal = runExecSignal(1);
    expect(resizeSignal).toBe(captureSignal);
    expect(resizeSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resizeSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(snapshot).resolves.toEqual({ error: "snapshot command timed out" });
    expect(resizeSignal.aborted).toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledOnce();
  });
});
