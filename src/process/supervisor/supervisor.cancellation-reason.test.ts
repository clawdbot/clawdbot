// Active process cancellation must keep one canonical terminal reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import type {
  ProcessSupervisor,
  SpawnInput,
  SpawnProcessAdapter,
  TerminationReason,
} from "./types.js";

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

type CancellationTestAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
  settle: (signal: NodeJS.Signals) => void;
};

function createCancellationTestAdapter(): CancellationTestAdapter {
  const completion = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const killMock = vi.fn();
  const disposeMock = vi.fn();

  return {
    pid: 4321,
    supportsRawOutput: false,
    onStdout: () => undefined,
    onStderr: () => undefined,
    wait: async () => completion.promise,
    kill: (signal) => killMock(signal),
    dispose: disposeMock,
    killMock,
    disposeMock,
    settle: (signal) => completion.resolve({ code: null, signal }),
  };
}

type CancellationPath = "run-id" | "scope";

function cancelThrough(
  supervisor: ProcessSupervisor,
  path: CancellationPath,
  runId: string,
  scopeKey: string,
  reason: TerminationReason,
): void {
  if (path === "scope") {
    supervisor.cancelScope(scopeKey, reason);
    return;
  }
  supervisor.cancel(runId, reason);
}

const cancellationPaths = [
  { label: "run ID", first: "run-id", later: "run-id" },
  { label: "scope", first: "scope", later: "scope" },
  { label: "run ID followed by scope", first: "run-id", later: "scope" },
  { label: "scope followed by run ID", first: "scope", later: "run-id" },
] as const satisfies ReadonlyArray<{
  label: string;
  first: CancellationPath;
  later: CancellationPath;
}>;

const cancellationReasons = [
  {
    firstReason: "manual-cancel",
    laterReasons: ["overall-timeout", "no-output-timeout", "manual-cancel"],
  },
  {
    firstReason: "overall-timeout",
    laterReasons: ["manual-cancel", "no-output-timeout", "overall-timeout"],
  },
  {
    firstReason: "no-output-timeout",
    laterReasons: ["manual-cancel", "overall-timeout", "no-output-timeout"],
  },
] as const satisfies ReadonlyArray<{
  firstReason: TerminationReason;
  laterReasons: ReadonlyArray<TerminationReason>;
}>;

describe("process supervisor first cancellation reason", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useFakeTimers();
  });

  it("keeps the first manual-cancel when a later construction deadline fires", async () => {
    const startup = createDeferred<CancellationTestAdapter>();
    createChildAdapterMock.mockReturnValueOnce(startup.promise);
    const supervisor = createProcessSupervisor();
    const runId = "manual-cancel-then-timeout";
    const pendingRun = supervisor.spawn({
      runId,
      mode: "child",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 25,
      stdinMode: "pipe-closed",
    });

    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    supervisor.cancel(runId, "manual-cancel");

    await vi.advanceTimersByTimeAsync(25);
    const constructionState = await Promise.race([
      pendingRun.then(
        () => "settled" as const,
        () => "rejected" as const,
      ),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(constructionState).toBe("settled");

    const run = await pendingRun;
    await expect(run.wait()).resolves.toMatchObject({
      reason: "manual-cancel",
      timedOut: false,
      noOutputTimedOut: false,
    });
    expect(run.activity.resultSettled).toBe(true);

    const lateAdapter = createCancellationTestAdapter();
    startup.resolve(lateAdapter);
    await Promise.resolve();
    expect(lateAdapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(lateAdapter.disposeMock).not.toHaveBeenCalled();
    lateAdapter.settle("SIGKILL");
    await run.waitForExtinction?.();
    expect(lateAdapter.disposeMock).toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const mode of ["child", "pty"] as const) {
    describe(`${mode} processes`, () => {
      for (const path of cancellationPaths) {
        describe(path.label, () => {
          it.each(cancellationReasons)(
            "keeps $firstReason after repeated overlapping cancellation",
            async ({ firstReason, laterReasons }) => {
              const adapter = createCancellationTestAdapter();
              const adapterMock = mode === "child" ? createChildAdapterMock : createPtyAdapterMock;
              adapterMock.mockResolvedValueOnce(adapter);

              const supervisor = createProcessSupervisor();
              const runId = `first-cancellation-${mode}`;
              const scopeKey = `scope:first-cancellation-${mode}`;
              const input: SpawnInput = {
                runId,
                scopeKey,
                mode,
                argv: [process.execPath, "-e", ""],
              };
              const run = await supervisor.spawn(input);
              const exitPromise = run.wait();

              cancelThrough(supervisor, path.first, runId, scopeKey, firstReason);
              for (const laterReason of laterReasons) {
                cancelThrough(supervisor, path.later, runId, scopeKey, laterReason);
                expect(run.activity.resultSettled, `after ${laterReason}`).toBe(false);
              }

              expect(adapter.killMock).toHaveBeenCalledTimes(1);

              const signal =
                process.platform === "win32" && firstReason !== "manual-cancel"
                  ? "SIGKILL"
                  : "SIGTERM";
              expect(adapter.killMock).toHaveBeenCalledWith(signal);
              adapter.settle(signal);

              await expect(exitPromise).resolves.toMatchObject({
                reason: firstReason,
                exitSignal: signal,
                timedOut: firstReason !== "manual-cancel",
                noOutputTimedOut: firstReason === "no-output-timeout",
              });
              expect(run.activity.resultSettled).toBe(true);
              expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
              expect(vi.getTimerCount()).toBe(0);
            },
          );
        });
      }
    });
  }
});
