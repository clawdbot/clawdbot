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
      sessionId: "ordinary-child",
      scopeKey: "scope:ordinary-child",
      argv: createSilentIdleArgv(),
    });

    expect(run.waitForExtinction).toBeUndefined();
    const drain = supervisor.waitForScope("scope:ordinary-child");
    const drained = vi.fn();
    void drain.then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();

    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    await expect(drain).resolves.toBeUndefined();
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
  });

  it("preserves root output when authoritative extinction settles first", async () => {
    const adapter = createStubChildAdapter();
    adapter.oomScoreWrapperSelected = true;
    const extinction = createDeferred();
    adapter.waitForExtinction = async () => await extinction.promise;
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    expect(run.waitForExtinction).toBeTypeOf("function");
    extinction.resolve();
    await Promise.resolve();
    expect(adapter.disposeMock).not.toHaveBeenCalled();
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
      sessionId: "root-result-before-extinction",
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
    expect(supervisor.getRecord(run.runId)).toMatchObject({
      state: "exited",
      terminationReason: "exit",
      exitCode: 23,
    });

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

  it("drains cancelled startups and live siblings before reporting ownership failure", async () => {
    const first = createStubChildAdapter();
    const sibling = createStubChildAdapter({ pid: 4321 });
    const [firstExtinction, siblingExtinction] = [createDeferred(), createDeferred()];
    first.waitForExtinction = async () => await firstExtinction.promise;
    sibling.waitForExtinction = async () => await siblingExtinction.promise;
    const startup = createDeferred<StubChildAdapter>();
    createChildAdapterMock.mockReturnValueOnce(startup.promise).mockResolvedValueOnce(sibling);

    const supervisor = createProcessSupervisor();
    const pending = ["failed-owner", "pending-owner"].map((sessionId) =>
      spawnChild(supervisor, {
        sessionId,
        scopeKey: "scope:failed-drain",
        argv: createSilentIdleArgv(),
      }),
    );
    supervisor.cancelScope("scope:failed-drain");
    const drain = supervisor.waitForScope("scope:failed-drain");
    startup.resolve(first);
    const runs = await Promise.all(pending);
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(sibling.killMock).toHaveBeenCalledWith("SIGTERM");
    first.settle(0);
    sibling.settle(0);
    await Promise.all(runs.map((run) => run.wait()));

    const drained = vi.fn();
    void drain.then(drained, drained);
    firstExtinction.reject(new Error("first owner lost authority"));
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    expect(sibling.disposeMock).not.toHaveBeenCalled();

    siblingExtinction.resolve();
    await expect(drain).rejects.toThrow("first owner lost authority");
    expect(sibling.disposeMock).toHaveBeenCalledTimes(1);
  });
});
