// Oversized process deadlines must never wrap into immediate Node timers.
import { performance } from "node:perf_hooks";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

type TimeoutTestAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  emitStdout: (chunk: string) => void;
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
  settle: () => void;
};

function createTimeoutTestAdapter(): TimeoutTestAdapter {
  const completion = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let stdoutListener: ((chunk: string) => void) | undefined;
  const killMock = vi.fn((signal?: NodeJS.Signals) => {
    completion.resolve({ code: null, signal: signal ?? null });
  });
  const disposeMock = vi.fn();

  return {
    pid: 1234,
    onStdout: (listener) => {
      stdoutListener = listener;
    },
    onStderr: () => undefined,
    wait: async () => completion.promise,
    kill: killMock,
    dispose: disposeMock,
    emitStdout: (chunk) => stdoutListener?.(chunk),
    killMock,
    disposeMock,
    settle: () => completion.resolve({ code: 0, signal: null }),
  };
}

const oversizedTimeouts = [
  { durationName: "the first overflowing Node delay", durationMs: 2 ** 31 },
  { durationName: "the maximum safe integer", durationMs: Number.MAX_SAFE_INTEGER },
] as const;

const deadlineCases = [
  {
    deadlineName: "overall deadline",
    timeoutField: "timeoutMs",
    reason: "overall-timeout",
    refreshOutput: false,
  },
  {
    deadlineName: "silent-output deadline",
    timeoutField: "noOutputTimeoutMs",
    reason: "no-output-timeout",
    refreshOutput: false,
  },
  {
    deadlineName: "refreshed output deadline",
    timeoutField: "noOutputTimeoutMs",
    reason: "no-output-timeout",
    refreshOutput: true,
  },
] as const;

describe("process supervisor oversized timer deadlines", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const mode of ["child", "pty"] as const) {
    describe(`${mode} processes`, () => {
      for (const { durationName, durationMs } of oversizedTimeouts) {
        describe(durationName, () => {
          it.each(deadlineCases)(
            "bounds the $deadlineName",
            async ({ timeoutField, reason, refreshOutput }) => {
              const adapter = createTimeoutTestAdapter();
              const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
              const adapterMock = mode === "child" ? createChildAdapterMock : createPtyAdapterMock;
              adapterMock.mockResolvedValue(adapter);

              const supervisor = createProcessSupervisor();
              const commonInput = {
                backendId: "test",
                sessionId: `timeout-overflow-${mode}`,
                [timeoutField]: durationMs,
              };
              const run = await supervisor.spawn(
                mode === "child"
                  ? { ...commonInput, mode: "child", argv: [process.execPath, "-e", ""] }
                  : { ...commonInput, mode: "pty", ptyCommand: "printf running" },
              );

              try {
                expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([
                  MAX_TIMER_TIMEOUT_MS,
                ]);

                await vi.advanceTimersByTimeAsync(1);
                expect(adapter.killMock).not.toHaveBeenCalled();

                if (refreshOutput) {
                  adapter.emitStdout("still running");
                  expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([
                    MAX_TIMER_TIMEOUT_MS,
                    MAX_TIMER_TIMEOUT_MS,
                  ]);
                }

                await vi.advanceTimersByTimeAsync(
                  refreshOutput ? MAX_TIMER_TIMEOUT_MS - 1 : MAX_TIMER_TIMEOUT_MS - 2,
                );
                expect(adapter.killMock).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                expect(adapter.killMock).not.toHaveBeenCalled();

                const remainingIntervalMs = Math.min(
                  durationMs - MAX_TIMER_TIMEOUT_MS,
                  MAX_TIMER_TIMEOUT_MS,
                );
                expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual(
                  refreshOutput
                    ? [MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS, remainingIntervalMs]
                    : [MAX_TIMER_TIMEOUT_MS, remainingIntervalMs],
                );

                if (durationMs === Number.MAX_SAFE_INTEGER) {
                  adapter.settle();
                  await expect(run.wait()).resolves.toMatchObject({
                    reason: "exit",
                    timedOut: false,
                    noOutputTimedOut: false,
                  });
                  expect(adapter.killMock).not.toHaveBeenCalled();
                  expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
                  expect(vi.getTimerCount()).toBe(0);
                  return;
                }

                await vi.advanceTimersByTimeAsync(remainingIntervalMs - 1);
                expect(adapter.killMock).not.toHaveBeenCalled();
                await vi.advanceTimersByTimeAsync(1);
                await expect(run.wait()).resolves.toMatchObject({
                  reason,
                  timedOut: true,
                  noOutputTimedOut: reason === "no-output-timeout",
                });
                expect(adapter.killMock).toHaveBeenCalledTimes(1);
                expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(0);
              } finally {
                adapter.settle();
                await run.wait();
              }
            },
          );
        });
      }

      it.each(deadlineCases)(
        "preserves the $deadlineName when an intermediate timer fires late",
        async ({ timeoutField, reason, refreshOutput }) => {
          const initialNowMs = 1_000;
          const trailingDurationMs = 10 * 60_000;
          const callbackLatenessMs = 9 * 60_000;
          const nowSpy = vi.spyOn(performance, "now").mockReturnValue(initialNowMs);
          const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
          const adapter = createTimeoutTestAdapter();
          const adapterMock = mode === "child" ? createChildAdapterMock : createPtyAdapterMock;
          adapterMock.mockResolvedValue(adapter);

          const commonInput = {
            backendId: "test",
            sessionId: `late-timeout-${mode}`,
            [timeoutField]: MAX_TIMER_TIMEOUT_MS + trailingDurationMs,
          };
          const run = await createProcessSupervisor().spawn(
            mode === "child"
              ? { ...commonInput, mode: "child", argv: [process.execPath, "-e", ""] }
              : { ...commonInput, mode: "pty", ptyCommand: "printf running" },
          );

          try {
            if (refreshOutput) {
              adapter.emitStdout("still running");
            }

            nowSpy.mockReturnValue(initialNowMs + MAX_TIMER_TIMEOUT_MS + callbackLatenessMs);
            await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
            expect(adapter.killMock).not.toHaveBeenCalled();
            expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual(
              refreshOutput
                ? [MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS, 60_000]
                : [MAX_TIMER_TIMEOUT_MS, 60_000],
            );

            nowSpy.mockReturnValue(initialNowMs + MAX_TIMER_TIMEOUT_MS + trailingDurationMs);
            await vi.advanceTimersByTimeAsync(60_000);
            await expect(run.wait()).resolves.toMatchObject({
              reason,
              timedOut: true,
              noOutputTimedOut: reason === "no-output-timeout",
            });
            expect(adapter.killMock).toHaveBeenCalledTimes(1);
            expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
          } finally {
            adapter.settle();
            await run.wait();
          }
        },
      );
    });
  }
});
