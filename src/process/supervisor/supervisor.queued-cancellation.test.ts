// Queued supervisor replacements must not launch after their caller cancels.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { SpawnInput, SpawnProcessAdapter } from "./types.js";

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

type StubProcessAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  killMock: ReturnType<typeof vi.fn>;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createStubProcessAdapter(pid = 1234): StubProcessAdapter {
  const completion = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const killMock = vi.fn();
  return {
    pid,
    supportsRawOutput: false,
    onStdout: () => undefined,
    onStderr: () => undefined,
    wait: async () => completion.promise,
    kill: (signal) => killMock(signal),
    dispose: () => undefined,
    killMock,
    settle: (code, signal = null) => completion.resolve({ code, signal }),
  };
}

function createSpawnInput(params: {
  runId: string;
  scopeKey: string;
  mode?: "child" | "pty";
  replaceExistingScope?: boolean;
}): SpawnInput {
  return {
    runId: params.runId,
    sessionId: "queued-cancellation",
    backendId: "test",
    scopeKey: params.scopeKey,
    replaceExistingScope: params.replaceExistingScope,
    mode: params.mode ?? "child",
    argv: [process.execPath, "-e", "process.stdout.write('should-not-run')"],
  };
}

describe("process supervisor queued cancellation", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
  });

  it.each(["child", "pty"] as const)(
    "does not start an already-cancelled queued %s replacement",
    async (mode) => {
      const first = createStubProcessAdapter();
      const replacement = createStubProcessAdapter();
      const firstStartup = createDeferred<StubProcessAdapter>();
      createChildAdapterMock.mockReturnValueOnce(firstStartup.promise);
      if (mode === "pty") {
        createPtyAdapterMock.mockResolvedValueOnce(replacement);
      } else {
        createChildAdapterMock.mockResolvedValueOnce(replacement);
      }

      const supervisor = createProcessSupervisor();
      const scopeKey = "scope:cancel-queued";
      const firstRunPromise = supervisor.spawn(
        createSpawnInput({ runId: `cancel-queued-${mode}-first`, scopeKey }),
      );
      const replacementRunId = `cancel-queued-${mode}-replacement`;
      const replacementPromise = supervisor.spawn(
        createSpawnInput({
          runId: replacementRunId,
          scopeKey,
          mode,
          replaceExistingScope: true,
        }),
      );

      expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
      expect(createPtyAdapterMock).not.toHaveBeenCalled();

      supervisor.cancel(replacementRunId, "manual-cancel");
      firstStartup.resolve(first);
      const [firstRun, replacementRun] = await Promise.all([firstRunPromise, replacementPromise]);

      expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
      expect(createPtyAdapterMock).not.toHaveBeenCalled();
      expect(first.killMock).not.toHaveBeenCalled();
      expect(replacement.killMock).not.toHaveBeenCalled();
      expect(replacementRun.pid).toBeUndefined();
      await expect(replacementRun.wait()).resolves.toMatchObject({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: null,
      });
      expect(supervisor.getRecord(replacementRunId)).toMatchObject({
        state: "exited",
        terminationReason: "manual-cancel",
      });

      first.settle(0);
      await expect(firstRun.wait()).resolves.toMatchObject({ reason: "exit" });
    },
  );

  it("never starts cancelled queued replacements or cancels their surviving scope", async () => {
    const replacementCount = 32;
    const first = createStubProcessAdapter(1234);
    const later = createStubProcessAdapter(1235);
    const firstStartup = createDeferred<StubProcessAdapter>();
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise).mockResolvedValueOnce(later);

    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:cancel-many-queued";
    const firstRunPromise = supervisor.spawn(
      createSpawnInput({ runId: "cancel-many-queued-first", scopeKey }),
    );
    const replacements = Array.from({ length: replacementCount }, (_unused, index) => {
      const runId = `cancel-many-queued-replacement-${index}`;
      const replacement = supervisor.spawn(
        createSpawnInput({
          runId,
          scopeKey,
          mode: index % 2 === 0 ? "child" : "pty",
          replaceExistingScope: true,
        }),
      );
      supervisor.cancel(runId, "manual-cancel");
      return replacement;
    });
    const laterRunPromise = supervisor.spawn(
      createSpawnInput({ runId: "cancel-many-queued-later", scopeKey }),
    );

    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
    expect(createPtyAdapterMock).not.toHaveBeenCalled();

    firstStartup.resolve(first);
    const [firstRun, replacementRuns, laterRun] = await Promise.all([
      firstRunPromise,
      Promise.all(replacements),
      laterRunPromise,
    ]);

    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
    expect(first.killMock).not.toHaveBeenCalled();
    expect(later.killMock).not.toHaveBeenCalled();
    for (const replacement of replacementRuns) {
      expect(replacement.pid).toBeUndefined();
    }
    await expect(Promise.all(replacementRuns.map((run) => run.wait()))).resolves.toEqual(
      Array.from({ length: replacementCount }, () =>
        expect.objectContaining({ reason: "manual-cancel" }),
      ),
    );

    first.settle(0);
    later.settle(0);
    await expect(Promise.all([firstRun.wait(), laterRun.wait()])).resolves.toEqual([
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });
});
