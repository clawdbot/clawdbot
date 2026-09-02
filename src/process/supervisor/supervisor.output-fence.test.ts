// Process supervisor output tests cover admission, detachment, and terminal fencing.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSilentIdleArgv,
  createStubChildAdapter,
  spawnChild,
  type StubChildAdapter,
} from "./supervisor.test-support.js";

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

let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

type OutputListenerKind = {
  name: string;
  stream: "stdout" | "stderr";
  spawnOptions: (record: (chunk: string) => void) => Partial<Parameters<typeof spawnChild>[1]>;
};

// One stream chunk reaches four supervisor-owned output paths. All four, plus the
// captured buffer and the run's output clock, close together on terminal
// settlement and on an explicit owner detach.
const OUTPUT_LISTENER_KINDS: OutputListenerKind[] = [
  {
    name: "decoded stdout",
    stream: "stdout",
    spawnOptions: (record) => ({ onStdout: record }),
  },
  {
    name: "decoded stderr",
    stream: "stderr",
    spawnOptions: (record) => ({ onStderr: record }),
  },
  {
    name: "raw stdout",
    stream: "stdout",
    spawnOptions: (record) => ({ onStdoutRaw: (raw) => record(raw.toString("utf8")) }),
  },
  {
    name: "raw stderr",
    stream: "stderr",
    spawnOptions: (record) => ({ onStderrRaw: (raw) => record(raw.toString("utf8")) }),
  },
];

function emitOutputChunk(adapter: StubChildAdapter, stream: "stdout" | "stderr", chunk: string) {
  if (stream === "stdout") {
    adapter.emitStdout(chunk);
    return;
  }
  adapter.emitStderr(chunk);
}

describe("process supervisor output fence", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
  });

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "refreshes the no-output deadline for raw-only UTF-8 output (raw observer=%s)",
    async (observeRaw) => {
      vi.useFakeTimers();
      const adapter = createStubChildAdapter({
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGKILL");
        },
      });
      createChildAdapterMock.mockResolvedValue(adapter);

      const supervisor = createProcessSupervisor();
      const runId = "raw-output-deadline";
      let callbackOutputAtMs: number | undefined;
      const run = await spawnChild(supervisor, {
        runId,
        sessionId: "s-raw-output-deadline",
        argv: createSilentIdleArgv(),
        noOutputTimeoutMs: 10,
        ...(observeRaw
          ? {
              onStdoutRaw: () => {
                callbackOutputAtMs = supervisor.getRecord(runId)?.lastOutputAtMs;
              },
            }
          : {}),
      });
      const startedAtMs = supervisor.getRecord(runId)?.startedAtMs;

      await vi.advanceTimersByTimeAsync(9);
      adapter.emitStdoutRaw(Buffer.from([0xe2]));

      expect(supervisor.getRecord(runId)?.lastOutputAtMs).toBeGreaterThan(
        startedAtMs ?? Number.POSITIVE_INFINITY,
      );
      if (observeRaw) {
        expect(callbackOutputAtMs).toBe(supervisor.getRecord(runId)?.lastOutputAtMs);
      }
      await vi.advanceTimersByTimeAsync(9);
      expect(adapter.killMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(run.wait()).resolves.toMatchObject({
        reason: "no-output-timeout",
        noOutputTimedOut: true,
      });
    },
  );

  it.each(OUTPUT_LISTENER_KINDS)(
    "stops $name, capture, and the output clock once the run result settles",
    async ({ stream, spawnOptions }) => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const adapter = createStubChildAdapter();
      const extinction = createDeferred();
      adapter.waitForExtinction = () => extinction.promise;
      createChildAdapterMock.mockResolvedValue(adapter);

      const supervisor = createProcessSupervisor();
      const delivered: string[] = [];
      const run = await spawnChild(supervisor, {
        sessionId: "s-late-output",
        argv: createSilentIdleArgv(),
        timeoutMs: 1_000,
        stdinMode: "pipe-closed",
        ...spawnOptions((chunk) => delivered.push(chunk)),
      });

      nowSpy.mockReturnValue(2_000);
      emitOutputChunk(adapter, stream, "live");
      // The forced kill-wait fallback settles the result while the child's
      // inherited pipes stay open. Callers finalize their own output state from
      // that terminal result, so a late chunk must reach nothing at all.
      adapter.settle(null, "SIGKILL");
      const exit = await run.wait();
      expect(adapter.disposeMock).not.toHaveBeenCalled();
      nowSpy.mockReturnValue(3_000);
      emitOutputChunk(adapter, stream, "late");

      expect(delivered).toEqual(["live"]);
      expect(exit[stream]).toBe("live");
      expect(supervisor.getRecord(run.runId)?.lastOutputAtMs).toBe(2_000);
      extinction.resolve();
      await expect(run.waitForExtinction?.()).resolves.toBeUndefined();
      expect(adapter.disposeMock).toHaveBeenCalledOnce();
    },
  );

  it.each(OUTPUT_LISTENER_KINDS)(
    "stops $name, capture, and the output clock when the owner detaches output",
    async ({ stream, spawnOptions }) => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const adapter = createStubChildAdapter();
      createChildAdapterMock.mockResolvedValue(adapter);

      const supervisor = createProcessSupervisor();
      const delivered: string[] = [];
      const run = await spawnChild(supervisor, {
        sessionId: "s-detach-output",
        argv: createSilentIdleArgv(),
        timeoutMs: 1_000,
        stdinMode: "pipe-closed",
        ...spawnOptions((chunk) => delivered.push(chunk)),
      });

      nowSpy.mockReturnValue(2_000);
      emitOutputChunk(adapter, stream, "attached");
      run.detachOutput?.();
      nowSpy.mockReturnValue(3_000);
      emitOutputChunk(adapter, stream, "detached");
      adapter.settle(0);
      const exit = await run.wait();

      expect(delivered).toEqual(["attached"]);
      expect(exit[stream]).toBe("attached");
      expect(supervisor.getRecord(run.runId)?.lastOutputAtMs).toBe(2_000);
    },
  );
});
