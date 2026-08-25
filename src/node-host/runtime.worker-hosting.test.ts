import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHostClient } from "./client.js";
import { NodeWorkerContainerContextMismatchError } from "./node-worker-container-lifecycle.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  closeWorkerSupervisor: vi.fn(async () => undefined),
  initializeWorkerSupervisor: vi.fn(async () => undefined),
  resolveContainerEngine: vi.fn(async (_options?: { env?: NodeJS.ProcessEnv }) => ({
    id: "docker" as const,
    command: "docker",
    target: "e".repeat(64),
  })),
}));

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./invoke.js", () => ({ handleInvoke: vi.fn(async () => undefined) }));
vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock("./node-worker-container-engine.js", () => ({
  resolveNodeWorkerContainerEngine: mocks.resolveContainerEngine,
}));
vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({
    initialize: mocks.initializeWorkerSupervisor,
    close: mocks.closeWorkerSupervisor,
  })),
}));
vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    readonly exec = vi.fn();
  },
}));
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [],
  })),
}));
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn(() => []) }));

const client = { request: vi.fn(async () => ({})) } as unknown as NodeHostClient;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeWorkerSupervisor.mockReset().mockResolvedValue(undefined);
  mocks.initializeWorkerSupervisor.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function prepareWorkerRuntime(isolation?: "container") {
  return prepareNodeHostRuntime({
    config: {
      nodeHost: {
        skills: { enabled: false },
        workerRuns: { enabled: true, ...(isolation ? { isolation } : {}) },
      },
    },
    env: { PATH: "/usr/bin" },
    enableWorkerRuns: true,
  });
}

describe("node-host worker manifest", () => {
  it("allows environment-managed processes to force worker hosting without durable config", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
      forceWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(true);
  });

  it("keeps local consent separate from connection metadata", async () => {
    const prepared = await prepareWorkerRuntime();

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(prepared.manifest).not.toHaveProperty("workerRuns");
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
  });

  it("disables container-isolated hosting and records why when no engine is usable", async () => {
    const reason =
      "Container-isolated node workers require Docker or Podman; install and start an engine.";
    mocks.resolveContainerEngine.mockRejectedValueOnce(new Error(reason));

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toBe(reason);
    const runtime = prepared.start({ client });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("disables container-isolated hosting on Windows before probing or advertising an engine", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: { enabled: true, isolation: "container" },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
      platform: "win32",
    });

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toMatch(/windows.*(?:linux|macos)/iu);
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    const runtime = prepared.start({ client });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("resolves the container engine once and passes its exact identity to the supervisor", async () => {
    mocks.initializeWorkerSupervisor.mockImplementationOnce(async () => {
      const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
      options?.onCapacityChanged?.({ total: 3, available: 0 });
      options?.onCapacityChanged?.({ total: 3, available: 3 });
    });
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: {
            enabled: true,
            isolation: "container",
            containerImage: "registry.example/openclaw-worker:22",
          },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    expect(createNodeWorkerSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        containerEngine: { id: "docker", command: "docker", target: "e".repeat(64) },
        containerImage: "registry.example/openclaw-worker:22",
      }),
    );
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).toHaveBeenCalledExactlyOnceWith({ total: 3, available: 3 });
    await runtime.close();
  });

  it("retains container hosting after failed reconciliation and recovers its capacity on start", async () => {
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("orphan sweep failed"))
      .mockImplementationOnce(async () => {
        const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
        options?.onCapacityChanged?.({ total: 2, available: 0 });
        options?.onCapacityChanged?.({ total: 2, available: 2 });
      });

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(prepared.workerHostingDisabledReason).toBeUndefined();
    expect(mocks.closeWorkerSupervisor).not.toHaveBeenCalled();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    await vi.waitFor(() =>
      expect(onRunnerCapacityChanged).toHaveBeenLastCalledWith({ total: 2, available: 2 }),
    );
    expect(onRunnerCapacityChanged.mock.calls).toEqual([
      [{ total: 2, available: 0 }],
      [{ total: 2, available: 2 }],
    ]);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(createNodeWorkerSupervisor).toHaveBeenCalledOnce();
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("keeps a container engine-context mismatch permanently and actionably disabled", async () => {
    const mismatch = new NodeWorkerContainerContextMismatchError(
      "node worker launch launch-1 belongs to a different docker engine or daemon; restore its original engine context before enabling worker hosting",
    );
    mocks.initializeWorkerSupervisor.mockRejectedValueOnce(mismatch);

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toBe(mismatch.message);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    expect(createNodeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).not.toHaveBeenCalled();
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("disables a retrying container supervisor when a later attempt finds a context mismatch", async () => {
    const mismatch = new NodeWorkerContainerContextMismatchError(
      "node worker launch launch-1 belongs to a different docker engine or daemon; restore its original engine context before enabling worker hosting",
    );
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("launch journal temporarily unavailable"))
      .mockRejectedValueOnce(mismatch);

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(true);
    const onWorkerHostingDisabled = vi.fn();
    const runtime = prepared.start({ client, onWorkerHostingDisabled });

    await vi.waitFor(() =>
      expect(onWorkerHostingDisabled).toHaveBeenCalledExactlyOnceWith(mismatch.message),
    );
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("retries non-container reconciliation after a bounded delay before publishing capacity", async () => {
    vi.useFakeTimers();
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("launch journal temporarily unavailable"))
      .mockImplementationOnce(async () => {
        const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
        options?.onCapacityChanged?.({ total: 2, available: 2 });
      });
    const prepared = await prepareWorkerRuntime();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(onRunnerCapacityChanged).toHaveBeenCalledExactlyOnceWith({ total: 2, available: 2 });
    await runtime.close();
  });

  it("cancels pending reconciliation retries and closes its supervisor exactly once", async () => {
    vi.useFakeTimers();
    mocks.initializeWorkerSupervisor.mockRejectedValueOnce(new Error("launch journal unavailable"));
    const prepared = await prepareWorkerRuntime();
    const runtime = prepared.start({ client });
    await vi.advanceTimersByTimeAsync(0);

    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });
});
