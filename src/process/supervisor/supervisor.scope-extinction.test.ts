import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSilentIdleArgv,
  createStubChildAdapter,
  createWriteStdoutArgv,
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

describe("process supervisor scope extinction", () => {
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

  it("keeps extinction waiting optional for ordinary child adapters", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      scopeKey: "scope:ordinary-child",
      argv: createSilentIdleArgv(),
    });

    expect(run.waitForExtinction).toBeUndefined();
    const drain = run.wait();
    const drained = vi.fn();
    void drain.then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();

    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    await expect(drain).resolves.toMatchObject({ exitCode: 0 });
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains extinction until its scope joins (failed=%s)", async (failed) => {
    const extinction = createDeferred();
    const adapter = Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    });
    createChildAdapterMock.mockResolvedValue(adapter);
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:one-shot-late-join";
    const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const run = await spawnChild(supervisor, {
      scopeKey,
      argv: createSilentIdleArgv(),
    });
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({ exitCode: 0 });
    if (failed) {
      extinction.reject(new Error("cleanup identity lost"));
      await expect(run.waitForExtinction!()).rejects.toThrow("cleanup identity lost");
      await expect(cleanup()).rejects.toThrow("cleanup identity lost");
      await expect(cleanup()).rejects.toThrow("cleanup identity lost");
    } else {
      extinction.resolve();
      await run.waitForExtinction!();
      await expect(cleanup()).resolves.toBeUndefined();
    }
    // The released owner must neither poison a new run nor retain the old admission.
    await expect(
      supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" })(),
    ).resolves.toBeUndefined();
    if (failed) {
      await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
    } else {
      await supervisor.shutdown();
    }
  });

  it.each(["child", "external"] as const)(
    "keeps %s execution available but reports unsupported one-shot cleanup",
    async (mode) => {
      const adapter = createStubChildAdapter();
      createChildAdapterMock.mockResolvedValue(adapter);
      createPtyAdapterMock.mockResolvedValue(adapter);
      const supervisor = createProcessSupervisor();
      const scopeKey = `scope:unsupported-${mode}`;
      const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
      const run = await supervisor.spawn({
        mode: "child",
        argv: createSilentIdleArgv(),
        scopeKey,
        ...(mode === "external" ? { cleanupOwnership: "external" as const } : {}),
      });
      adapter.emitStdout("tool execution remains available");
      adapter.settle(0);
      await expect(run.wait()).resolves.toMatchObject({
        exitCode: 0,
        stdout: "tool execution remains available",
      });
      await expect(cleanup()).rejects.toThrow("cannot confirm owned execution-tree settlement");
      await supervisor.shutdown();
    },
  );

  it("allows graceful descendant cleanup after a one-shot root result", async () => {
    const extinction = createDeferred();
    const adapter = Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    });
    createChildAdapterMock.mockResolvedValue(adapter);
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:graceful-one-shot";
    const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const run = await spawnChild(supervisor, {
      scopeKey,
      argv: createSilentIdleArgv(),
    });
    adapter.settle(0);
    await run.wait();
    const closing = cleanup();
    expect(adapter.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    extinction.resolve();
    await closing;
    await supervisor.shutdown();
  });

  it.each(["scope", "shutdown"] as const)(
    "keeps timed-out construction cleanup joinable through %s",
    async (join) => {
      vi.useFakeTimers();
      const startup = createDeferred<StubChildAdapter>();
      const extinction = createDeferred();
      const adapter = Object.assign(createStubChildAdapter(), {
        waitForExtinction: () => extinction.promise,
      });
      createChildAdapterMock.mockReturnValueOnce(startup.promise);
      const supervisor = createProcessSupervisor();
      const scopeKey = "scope:timed-out-construction";
      const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, {
        processTree: "transport-only",
      });
      const pending = spawnChild(supervisor, {
        scopeKey,
        argv: createSilentIdleArgv(),
        timeoutMs: 25,
      });
      try {
        await vi.advanceTimersByTimeAsync(25);
        const run = await pending;
        await expect(run.wait()).resolves.toMatchObject({ reason: "overall-timeout" });
        const drain = join === "scope" ? cleanupScope() : supervisor.shutdown();
        const drained = vi.fn();
        void drain.then(drained, drained);
        await vi.advanceTimersByTimeAsync(0);
        expect(drained).not.toHaveBeenCalled();

        startup.resolve(adapter);
        await vi.advanceTimersByTimeAsync(0);
        expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
        expect(drained).not.toHaveBeenCalled();
        expect(adapter.disposeMock).not.toHaveBeenCalled();

        adapter.settle(null, "SIGKILL");
        extinction.resolve();
        await expect(drain).resolves.toBeUndefined();
        expect(adapter.disposeMock).toHaveBeenCalledOnce();
      } finally {
        startup.resolve(adapter);
        adapter.settle(null, "SIGKILL");
        extinction.resolve();
        await pending;
        await supervisor.shutdown();
        await cleanupScope();
      }
    },
  );

  it("preserves root output when authoritative extinction settles first", async () => {
    const adapter = createStubChildAdapter();
    adapter.oomScoreWrapperSelected = true;
    const extinction = createDeferred();
    adapter.waitForExtinction = async () => await extinction.promise;
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    expect(run.waitForExtinction).toBeTypeOf("function");
    extinction.resolve();
    await Promise.resolve();
    expect(adapter.disposeMock).not.toHaveBeenCalled();
    expect(run.activity.resultSettled).toBe(false);
    adapter.emitStdout("ok");
    adapter.settle(0);

    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
    expect(exit.oomScoreWrapperSelected).toBe(true);
    expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { outcome: "process-tree extinction", failure: false },
    { outcome: "cleanup identity loss", failure: true },
  ])("retains root-result cancellation ownership until $outcome", async ({ failure }) => {
    const extinction = createDeferred();
    const adapter = Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    });
    createChildAdapterMock.mockResolvedValue(adapter);
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      scopeKey: "scope:root-result-before-extinction",
      argv: createSilentIdleArgv(),
    });
    expect(run.waitForExtinction).toBeTypeOf("function");
    adapter.emitStdout("authentic root output");
    adapter.settle(23);
    const root = await run.wait();

    expect(root).toMatchObject({ reason: "exit", exitCode: 23, stdout: "authentic root output" });
    expect(adapter.disposeMock).not.toHaveBeenCalled();
    supervisor.cancelScope("scope:root-result-before-extinction");
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(run.activity.resultSettled).toBe(true);

    if (failure) {
      extinction.reject(new Error("cleanup identity lost"));
      await expect(run.waitForExtinction?.()).rejects.toThrow("cleanup identity lost");
    } else {
      extinction.resolve();
      await expect(run.waitForExtinction?.()).resolves.toBeUndefined();
    }
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
    await expect(run.wait()).resolves.toBe(root);
    supervisor.cancel(run.runId);
    expect(adapter.killMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "drains cancelled startups and live siblings before reporting ownership failure (reused run ID=%s)",
    async (reuseRunId) => {
      const first = createStubChildAdapter();
      const sibling = createStubChildAdapter({ pid: 4321 });
      const siblingExtinction = createDeferred();
      sibling.waitForExtinction = async () => await siblingExtinction.promise;
      const startup = createDeferred<StubChildAdapter>();
      createChildAdapterMock.mockReturnValueOnce(startup.promise).mockResolvedValueOnce(sibling);

      const supervisor = createProcessSupervisor();
      const cleanupScope = supervisor.acquireScopeCleanup("scope:failed-drain", {
        processTree: "transport-only",
      });
      const sharedId = reuseRunId ? { runId: "same-agent-run" } : {};
      const firstPending = spawnChild(supervisor, {
        ...sharedId,
        scopeKey: "scope:failed-drain",
        argv: createSilentIdleArgv(),
      });
      const siblingRun = await spawnChild(supervisor, {
        ...sharedId,
        scopeKey: "scope:failed-drain",
        argv: createSilentIdleArgv(),
      });
      supervisor.cancelScope("scope:failed-drain");
      const drain = cleanupScope();
      startup.resolve(first);
      const firstRun = await firstPending;
      expect(first.killMock).toHaveBeenCalledWith("SIGKILL");
      expect(first.disposeMock).not.toHaveBeenCalled();
      first.settle(null, "SIGKILL");
      await firstRun.waitForExtinction?.();
      expect(first.disposeMock).toHaveBeenCalled();
      expect(sibling.killMock).toHaveBeenCalledWith("SIGTERM");
      expect(siblingRun.pid).toBe(sibling.pid);
      sibling.settle(0);
      await Promise.all([firstRun.wait(), siblingRun.wait()]);

      const drained = vi.fn();
      void drain.then(drained, drained);
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      expect(sibling.disposeMock).not.toHaveBeenCalled();

      siblingExtinction.reject(new Error("sibling owner lost authority"));
      await expect(drain).rejects.toThrow("sibling owner lost authority");
      expect(sibling.disposeMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not finalize a newer admission when an older startup with the same run ID fails", async () => {
    const startup = createDeferred<StubChildAdapter>();
    const sibling = createStubChildAdapter({ pid: 4321 });
    createChildAdapterMock.mockReturnValueOnce(startup.promise).mockResolvedValueOnce(sibling);
    const supervisor = createProcessSupervisor();
    const input = {
      runId: "same-agent-run",
      argv: createSilentIdleArgv(),
    };
    const pending = spawnChild(supervisor, input);
    const replacement = await spawnChild(supervisor, input);
    try {
      const snapshot = { ...replacement.activity };
      const rejected = expect(pending).rejects.toThrow("older startup failed");
      startup.reject(new Error("older startup failed"));
      await rejected;
      expect(replacement.activity).toEqual(snapshot);
    } finally {
      sibling.settle(0);
      await replacement.wait();
      await supervisor.shutdown();
    }
  });
  it.each([false, true])(
    "preserves native PTY without a tree requirement (scoped=%s)",
    async (scoped) => {
      const supervisor = createProcessSupervisor();
      const scopeKey = "scope:pty-transport";
      const cleanup = scoped
        ? supervisor.acquireScopeCleanup(scopeKey, { processTree: "transport-only" })
        : undefined;
      const pty = createStubChildAdapter();
      createPtyAdapterMock.mockResolvedValue(pty);
      const run = await supervisor.spawn({
        mode: "pty",
        argv: createSilentIdleArgv(),
        scopeKey,
      });
      try {
        expect(createPtyAdapterMock).toHaveBeenCalledOnce();
        expect(createChildAdapterMock).not.toHaveBeenCalled();
        pty.emitStdout("interactive output");
        pty.settle(0);
        await expect(run.wait()).resolves.toMatchObject({
          exitCode: 0,
          stdout: "interactive output",
        });
        await cleanup?.();
      } finally {
        pty.settle(0);
        await supervisor.shutdown();
      }
    },
  );

  it("keeps a required-all scope dominant over owned-only backend cleanup", async () => {
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:strict-backend-owner";
    const ownedCleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "owned-only" });
    const strictCleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const external = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(external);
    try {
      const run = await supervisor.spawn({
        mode: "child",
        argv: createSilentIdleArgv(),
        scopeKey,
        cleanupOwnership: "external",
      });
      external.settle(0);
      await run.wait();
      await expect(ownedCleanup()).resolves.toBeUndefined();
      await expect(strictCleanup()).rejects.toThrow(
        "cannot confirm owned execution-tree settlement",
      );
    } finally {
      external.settle(0);
      await Promise.allSettled([ownedCleanup(), strictCleanup(), supervisor.shutdown()]);
    }
  });
});
