import { beforeEach, describe, expect, it, vi } from "vitest";

type LoadStaticCatalog =
  typeof import("./embedded-agent-runner/model.static-catalog.js").loadBundledProviderStaticCatalogContextModels;

const mocks = vi.hoisted(() => ({
  authStorage: { getAll: vi.fn(() => ({ custom: { type: "api_key", key: "test-key" } })) },
  modelRegistry: {
    fork: vi.fn((authStorage: unknown) => ({ authStorage })),
    getAll: vi.fn(() => []),
  },
  discoverAuthStorage: vi.fn(),
  discoverModels: vi.fn(),
  ensureOpenClawModelsJson: vi.fn(async (..._args: unknown[]) => ({
    agentDir: "/tmp/agent",
    wrote: false,
  })),
  buildPreparedModelCatalogSnapshot: vi.fn(async (..._args: unknown[]) => ({
    entries: [],
    routeVariants: [],
  })),
  ensureRuntimePluginsLoaded: vi.fn(),
  loadStaticCatalog: vi.fn<LoadStaticCatalog>(async () => []),
  configuredAgentIds: [] as string[],
  warn: vi.fn(),
  mutationListener: undefined as
    | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
    | undefined,
}));

vi.mock("./model-catalog.js", () => ({
  buildPreparedModelCatalogSnapshot: (...args: unknown[]) =>
    mocks.buildPreparedModelCatalogSnapshot(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => {
    mocks.discoverAuthStorage(...args);
    return mocks.authStorage;
  },
  discoverModels: (...args: unknown[]) => {
    mocks.discoverModels(...args);
    return mocks.modelRegistry;
  },
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.configuredAgentIds,
  resolveAgentDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-agent" : `/tmp/configured-${agentId}`,
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-workspace" : `/tmp/workspace-${agentId}`,
  resolveDefaultAgentDir: () => "/tmp/unused-agent",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    mocks.mutationListener = listener;
    return () => {};
  },
}));

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => mocks.ensureOpenClawModelsJson(...args),
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: (...args: unknown[]) => mocks.ensureRuntimePluginsLoaded(...args),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: (...args: Parameters<LoadStaticCatalog>) =>
    mocks.loadStaticCatalog(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

describe("prepared model runtime snapshots", () => {
  const getTesting = () =>
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.preparedModelRuntimeTestApi")
    ] as {
      resetPreparedModelRuntimeSnapshotsForTest: () => void;
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => void;
    };

  beforeEach(() => {
    getTesting().resetPreparedModelRuntimeSnapshotsForTest();
    mocks.discoverAuthStorage.mockClear();
    mocks.discoverModels.mockClear();
    mocks.ensureOpenClawModelsJson.mockReset();
    mocks.ensureOpenClawModelsJson.mockResolvedValue({ agentDir: "/tmp/agent", wrote: false });
    mocks.buildPreparedModelCatalogSnapshot.mockClear();
    mocks.ensureRuntimePluginsLoaded.mockClear();
    mocks.loadStaticCatalog.mockClear();
    mocks.modelRegistry.fork.mockClear();
    mocks.warn.mockClear();
    mocks.configuredAgentIds = [];
  });

  it("does not discover missing owners from a gateway request", async () => {
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const input = { config: {}, agentDir: "/tmp/prepared-model-runtime-gateway-missing" };

    await activateStandalonePreparedModelRuntime(input);
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not let a read-only draft replace a configured gateway owner", async () => {
    mocks.configuredAgentIds = ["default"];
    const configured = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(configured, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    const activated = await activateStandalonePreparedModelRuntime({
      config: { agents: { defaults: { model: "openai/gpt-5.4" } } },
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/gateway-launch-workspace",
      readOnly: true,
    });

    expect(activated).toBeUndefined();
    await expect(
      prepareModelRuntimeSnapshot({
        config: configured,
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/gateway-launch-workspace",
      }),
    ).resolves.toMatchObject({ config: configured });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("retires a standalone run owner when its final lease releases", async () => {
    const input = {
      config: {},
      agentId: "default",
      agentDir: "/tmp/standalone-run-agent",
      workspaceDir: "/tmp/one-off-run-workspace",
    };
    const lease = await acquireAgentRunPreparedModelRuntime(input);

    await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(lease.snapshot);
    lease.release();
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("retains only the latest idle direct-run owner", async () => {
    const firstInput = {
      config: {},
      agentId: "default",
      agentDir: "/tmp/standalone-retained-run-agent",
      workspaceDir: "/tmp/standalone-retained-run-workspace",
    };
    const firstLease = await acquireAgentRunPreparedModelRuntime(firstInput, {
      retainIdleRunOwner: true,
    });
    firstLease.release();

    await expect(prepareModelRuntimeSnapshot(firstInput)).resolves.toBe(firstLease.snapshot);
    const reusedLease = await acquireAgentRunPreparedModelRuntime(firstInput, {
      retainIdleRunOwner: true,
    });
    reusedLease.release();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

    const secondInput = {
      ...firstInput,
      workspaceDir: "/tmp/standalone-retained-run-workspace-2",
    };
    const secondLease = await acquireAgentRunPreparedModelRuntime(secondInput, {
      retainIdleRunOwner: true,
    });
    secondLease.release();

    await expect(prepareModelRuntimeSnapshot(firstInput)).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
    await expect(prepareModelRuntimeSnapshot(secondInput)).resolves.toBe(secondLease.snapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("publishes an exact dynamic workspace owner at gateway run admission", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    const firstLease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/spawned-workspace",
    });
    const secondLease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/spawned-workspace",
    });

    expect(firstLease.snapshot.workspaceDir).toBe("/tmp/spawned-workspace");
    expect(secondLease.snapshot).toBe(firstLease.snapshot);
    firstLease.release();
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/spawned-workspace",
      }),
    ).resolves.toBe(firstLease.snapshot);
    secondLease.release();
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/spawned-workspace",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("joins an in-flight dynamic owner publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    let finishDynamic!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishDynamic = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );
    const input = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/concurrent-dynamic-workspace",
    };

    const firstPending = acquireAgentRunPreparedModelRuntime(input);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const secondPending = acquireAgentRunPreparedModelRuntime(input);
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    finishDynamic();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
  });

  it("does not let a stale dynamic lease authorize a replacement generation", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/stale-dynamic-workspace",
    };
    const firstLease = await acquireAgentRunPreparedModelRuntime(input);

    markPreparedModelRuntimeSnapshotsStale("test dynamic owner staling");
    await expect(acquireAgentRunPreparedModelRuntime(input)).rejects.toThrow(
      "prepared model runtime owner was not committed",
    );
    firstLease.release();
  });

  it("activates a standalone lease on a configless gateway with no configured owners", async () => {
    mocks.configuredAgentIds = [];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = {
      agentId: "openclaw",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/configless-workspace",
    };
    const lease = await acquireAgentRunPreparedModelRuntime(input);
    expect(lease.snapshot.agentDir).toBe("/tmp/unused-agent");
    lease.release();
  });

  it("activates a standalone lease for a configless runtime while another agent is configured", async () => {
    mocks.configuredAgentIds = ["other"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = {
      agentId: "openclaw",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/configless-mixed-workspace",
    };
    const lease = await acquireAgentRunPreparedModelRuntime(input);
    expect(lease.snapshot.agentDir).toBe("/tmp/unused-agent");
    lease.release();
  });

  it("rejects an ordinary unconfigured agent on an active gateway", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });

    await expect(
      acquireAgentRunPreparedModelRuntime({
        agentId: "missing",
        config,
        agentDir: "/tmp/configured-missing",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-missing",
      }),
    ).rejects.toThrow("prepared model runtime owner was not committed");
  });

  it("rebases a stale dynamic owner onto the committed configured generation", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const dynamicInput = {
      agentId: "default",
      config: initialConfig,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/rebased-dynamic-workspace",
    };
    const firstLease = await acquireAgentRunPreparedModelRuntime(dynamicInput);
    markPreparedModelRuntimeSnapshotsStale("test committed dynamic rebase");
    await publishPreparedModelRuntimeSnapshot(
      {
        ...dynamicInput,
        config: latestConfig,
        workspaceDir: "/tmp/unused-workspace",
      },
      { force: true, provenance: "configured" },
    );

    const secondLease = await acquireAgentRunPreparedModelRuntime(dynamicInput);
    expect(secondLease.snapshot.config).toBe(latestConfig);
    expect(secondLease.snapshot.workspaceDir).toBe(dynamicInput.workspaceDir);
    firstLease.release();
    secondLease.release();
  });

  it("rebases a reserved run identity through its configured agent directory", async () => {
    mocks.configuredAgentIds = ["default", "openclaw"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "openclaw",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/setup-probe-workspace",
    });

    expect(lease.snapshot).toMatchObject({
      agentId: "openclaw",
      agentDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/setup-probe-workspace",
      config,
    });
    lease.release();
  });

  it("keeps an ordinary run bound to its configured agent identity", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "secondary",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/secondary-probe-workspace",
    });

    expect(lease.snapshot).toMatchObject({
      agentId: "secondary",
      agentDir: "/tmp/configured-secondary",
      workspaceDir: "/tmp/secondary-probe-workspace",
      config,
    });
    lease.release();
  });

  it("keeps a configured replacement after the matching dynamic lease releases", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const input = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const dynamicLease = await acquireAgentRunPreparedModelRuntime(input);

    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const configuredSnapshot = await prepareModelRuntimeSnapshot(input);

    expect(configuredSnapshot).not.toBe(dynamicLease.snapshot);
    dynamicLease.release();
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(configuredSnapshot);
  });

  it("blocks new dynamic lease owners until lifecycle replacement commits", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    let finishReplacement!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: boolean }>((resolve) => {
          finishReplacement = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );

    markPreparedModelRuntimeSnapshotsStale("test lease replacement", {
      waitForReplacement: true,
    });
    const leasePending = acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config: initialConfig,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/dynamic-replacement-workspace",
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

    const refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    finishReplacement();
    await refresh;
    const lease = await leasePending;

    expect(lease.snapshot.config).toBe(latestConfig);
    expect(lease.snapshot.workspaceDir).toBe("/tmp/dynamic-replacement-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
    lease.release();
  });

  it("rebases a stale dynamic run after the replacement gate has closed", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    await refreshPreparedModelRuntimeSnapshots(latestConfig);

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config: initialConfig,
      agentDir: "/tmp/stale-agent-dir",
      inheritedAuthDir: "/tmp/stale-agent-dir",
      workspaceDir: "/tmp/dynamic-post-reload-workspace",
    });

    expect(lease.snapshot.config).toBe(latestConfig);
    expect(lease.snapshot.agentDir).toBe("/tmp/unused-agent");
    expect(lease.snapshot.workspaceDir).toBe("/tmp/dynamic-post-reload-workspace");
    lease.release();
  });

  it("rebinds a queued canonical run to committed directories", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });

    markPreparedModelRuntimeSnapshotsStale("test directory replacement", {
      waitForReplacement: true,
    });
    const leasePending = acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config: initialConfig,
      agentDir: "/tmp/old-agent-dir",
      inheritedAuthDir: "/tmp/old-agent-dir",
      workspaceDir: "/tmp/old-workspace-dir",
      preserveWorkspaceDirOnRefresh: false,
    });
    const refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);
    await refresh;
    const lease = await leasePending;

    expect(lease.snapshot.config).toBe(latestConfig);
    expect(lease.snapshot.agentDir).toBe("/tmp/unused-agent");
    expect(lease.snapshot.workspaceDir).toBe("/tmp/unused-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    lease.release();
  });

  it("reuses the configured owner at canonical gateway run admission", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/gateway-launch-workspace",
    });

    expect(lease.snapshot.workspaceDir).toBe("/tmp/gateway-launch-workspace");
    lease.release();
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/gateway-launch-workspace",
      }),
    ).resolves.toBe(lease.snapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("releases a one-read dynamic metadata generation", async () => {
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const input = {
      agentId: "default",
      config: {},
      agentDir: "/tmp/prepared-model-runtime-metadata-agent",
      workspaceDir: "/tmp/prepared-model-runtime-metadata-workspace",
    };

    const lease = await acquireReadOnlyPreparedModelRuntime(input);
    expect(lease.snapshot.workspaceDir).toBe(input.workspaceDir);
    lease.release();

    await expect(prepareModelRuntimeSnapshot({ ...input, readOnly: true })).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("fails a timed-out publication without overlapping its late build with a retry", async () => {
    getTesting().setModelRuntimeBuildTimeoutMsForTest(1);
    let finishTimedOutBuild: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishTimedOutBuild = () => resolve({ agentDir: "/tmp/agent", wrote: false });
        }),
    );
    const input = { config: {}, agentDir: "/tmp/prepared-model-runtime-timeout" };

    await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

    finishTimedOutBuild?.();
    await vi.waitFor(() => expect(mocks.discoverModels).toHaveBeenCalledOnce());
    await expect(publishPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
      agentDir: input.agentDir,
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("rebuilds stale owners with the newly published config", async () => {
    mocks.configuredAgentIds = ["default"];
    const agentDir = "/tmp/unused-agent";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const input = {
      config: firstConfig,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/unused-workspace",
    };
    await publishPreparedModelRuntimeSnapshot(input, { provenance: "configured" });

    await refreshPreparedModelRuntimeSnapshots(secondConfig);
    const refreshed = await prepareModelRuntimeSnapshot({ ...input, config: secondConfig });
    const fromStaleRequest = await prepareModelRuntimeSnapshot(input);

    expect(refreshed.config).toBe(secondConfig);
    expect(fromStaleRequest).toBe(refreshed);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("does not serve the old snapshot after lifecycle refresh fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const agentDir = "/tmp/unused-agent";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const input = {
      config: firstConfig,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/unused-workspace",
    };
    await publishPreparedModelRuntimeSnapshot(input, { provenance: "configured" });
    const refreshError = new Error("catalog refresh failed");
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots(secondConfig)).rejects.toBe(refreshError);
    await expect(prepareModelRuntimeSnapshot({ ...input, config: secondConfig })).rejects.toBe(
      refreshError,
    );
  });

  it("does not serve a retired owner when another owner fails to refresh", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const firstConfig = {};
    await refreshPreparedModelRuntimeSnapshots(firstConfig);
    mocks.configuredAgentIds = ["default"];
    const refreshError = new Error("remaining owner refresh failed");
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots({})).rejects.toBe(refreshError);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-removed",
      affectsInheritedStores: false,
    });
    await expect(
      prepareModelRuntimeSnapshot({
        config: firstConfig,
        agentDir: "/tmp/configured-removed",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("commits no configured owner when one sibling refresh fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const firstConfig = {};
    await refreshPreparedModelRuntimeSnapshots(firstConfig);
    const refreshError = new Error("secondary refresh failed");
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: "/tmp/unused-agent", wrote: false })
      .mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots({})).rejects.toBe(refreshError);
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/unused-workspace",
      }),
    ).rejects.toBe(refreshError);
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/configured-secondary",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-secondary",
      }),
    ).rejects.toBe(refreshError);
  });

  it("stales every owner when queued auth refresh fails after config publication", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refreshPreparedModelRuntimeSnapshots({});
    const refreshError = new Error("queued auth refresh failed");
    let finishConfigRefresh!: () => void;
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishConfigRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
          }),
      )
      .mockResolvedValueOnce({ agentDir: "/tmp/configured-secondary", wrote: false })
      .mockResolvedValueOnce({ agentDir: "/tmp/unused-agent", wrote: false })
      .mockRejectedValueOnce(refreshError);

    const refresh = refreshPreparedModelRuntimeSnapshots({});
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    mocks.mutationListener?.({ affectsInheritedStores: true });
    finishConfigRefresh();

    await expect(refresh).rejects.toBe(refreshError);
    for (const [agentDir, workspaceDir] of [
      ["/tmp/unused-agent", "/tmp/unused-workspace"],
      ["/tmp/configured-secondary", "/tmp/workspace-secondary"],
    ] as const) {
      await expect(
        prepareModelRuntimeSnapshot({
          config: {},
          agentDir,
          inheritedAuthDir: "/tmp/unused-agent",
          workspaceDir,
        }),
      ).rejects.toBe(refreshError);
    }
  });

  it("does not replay an auth mutation that occurs before the first owner is registered", async () => {
    getTesting().setModelRuntimeBuildTimeoutMsForTest(100);
    mocks.configuredAgentIds = ["default"];
    mocks.ensureRuntimePluginsLoaded.mockImplementationOnce(() => {
      mocks.mutationListener?.({ affectsInheritedStores: true });
    });
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: "/tmp/unused-agent", wrote: false })
      .mockImplementationOnce(async () => await new Promise<never>(() => {}));

    await expect(
      refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" }),
    ).resolves.toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("awaits auth invalidation queued during lifecycle publication", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({});
    let finishConfigRefresh: (() => void) | undefined;
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishConfigRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
          }),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishAuthRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
          }),
      );

    const publication = refreshPreparedModelRuntimeSnapshots({});
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    finishConfigRefresh?.();
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    let settled = false;
    void publication.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishAuthRefresh?.();
    await publication;
    expect(settled).toBe(true);
  });

  it("invalidates and refreshes the affected owner at auth publication", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-auth";
    const first = await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "stale after auth mutation",
    );

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const refreshed = await prepareModelRuntimeSnapshot({ config, agentDir });
    expect(refreshed).not.toBe(first);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
  });

  it("treats an auth refresh superseded by a newer mutation as control flow", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-auth-superseded";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir });
    let finishFirstRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishFirstRefresh = () => resolve({ agentDir, wrote: false });
        }),
    );

    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    finishFirstRefresh?.();

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).resolves.toMatchObject({
      agentDir,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not let a superseded owner hide a genuine sibling refresh failure", async () => {
    const config = {};
    const supersededDir = "/tmp/prepared-model-runtime-auth-superseded-sibling";
    const failingDir = "/tmp/prepared-model-runtime-auth-failing-sibling";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: supersededDir });
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: failingDir });
    let finishSupersededRefresh: (() => void) | undefined;
    let failSiblingRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishSupersededRefresh = () => resolve({ agentDir: supersededDir, wrote: false });
          }),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((_resolve, reject) => {
            failSiblingRefresh = () => reject(new Error("genuine sibling refresh failure"));
          }),
      );

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    mocks.mutationListener?.({ agentDir: supersededDir, affectsInheritedStores: false });
    finishSupersededRefresh?.();
    failSiblingRefresh?.();

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.stringContaining("genuine sibling refresh failure"),
      ),
    );
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("refreshes owners that inherit the mutated auth directory", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-custom-agent";
    const inheritedAuthDir = "/tmp/prepared-model-runtime-main-agent";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir, inheritedAuthDir });

    mocks.mutationListener?.({ agentDir: inheritedAuthDir, affectsInheritedStores: false });

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    expect(mocks.discoverAuthStorage).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ inheritedAuthDir }),
    );
  });

  it("tracks default auth inheritance when the owner omits the directory", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-implicit-inheritance";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    mocks.mutationListener?.({
      agentDir: "/tmp/unused-agent",
      affectsInheritedStores: false,
    });

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    expect(mocks.discoverAuthStorage).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ inheritedAuthDir: "/tmp/unused-agent" }),
    );
  });

  it("retains every owner until an explicit lifecycle invalidation", async () => {
    const config = {};
    const firstAgentDir = "/tmp/prepared-model-runtime-concurrent-0";
    await Promise.all(
      Array.from({ length: 70 }, async (_, index) =>
        publishPreparedModelRuntimeSnapshot({
          config,
          agentDir: `/tmp/prepared-model-runtime-concurrent-${index}`,
        }),
      ),
    );
    await prepareModelRuntimeSnapshot({ config, agentDir: firstAgentDir });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(70);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(70);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(70);
  });

  it("serializes workspace replacements for one agent-owned catalog", async () => {
    let finishFirst: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishFirst = () => resolve({ agentDir: "/tmp/agent", wrote: false });
        }),
    );
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-workspace-replacement";
    const first = publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-old",
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
    const requestDuringFirstGeneration = prepareModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-old",
    });

    const replacement = publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-new",
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

    finishFirst?.();
    const firstSnapshot = await first;
    const replacementSnapshot = await replacement;
    expect(await requestDuringFirstGeneration).toBe(firstSnapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      config,
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/workspace-new" }),
    );
    expect(
      await prepareModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-new",
      }),
    ).toBe(replacementSnapshot);
  });

  it("preserves an authoritative workspace override across config refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = "/tmp/unused-agent";
    await publishPreparedModelRuntimeSnapshot(
      {
        agentId: "default",
        config,
        agentDir,
        inheritedAuthDir: agentDir,
        workspaceDir: "/tmp/explicit-workspace",
        preserveWorkspaceDirOnRefresh: true,
      },
      { provenance: "configured" },
    );

    await refreshPreparedModelRuntimeSnapshots({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/explicit-workspace",
    });

    expect(snapshot.workspaceDir).toBe("/tmp/explicit-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      expect.any(Object),
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/explicit-workspace" }),
    );
  });

  it("finds the configured gateway owner when request config omits its launch workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      config,
      agentDir: "/tmp/unused-agent",
    });

    expect(snapshot.workspaceDir).toBe("/tmp/gateway-launch-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("does not substitute a configured owner captured from another environment", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/unused-agent",
        env: { ...process.env, OPENCLAW_PREPARED_RUNTIME_TEST_SCOPE: "different" },
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
  });

  it("does not substitute a configured owner for an explicit workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/other-explicit-workspace",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
  });

  it("does not choose between configured owners sharing one agent directory", async () => {
    const config = {};
    const agentDir = "/tmp/shared-configured-agent";
    await publishPreparedModelRuntimeSnapshot(
      { config, agentDir, workspaceDir: "/tmp/shared-workspace-a" },
      { provenance: "configured" },
    );
    await publishPreparedModelRuntimeSnapshot(
      { config, agentDir, workspaceDir: "/tmp/shared-workspace-b" },
      { provenance: "configured" },
    );

    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("selects a configured owner by agent id when directories are shared", async () => {
    const config = {};
    const agentDir = "/tmp/shared-agent-id-directory";
    await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-a", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );
    const selected = await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-b", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );

    await expect(
      prepareModelRuntimeSnapshot({ agentId: "agent-b", config, agentDir }),
    ).resolves.toBe(selected);
  });

  it("retires configured owners removed by config reload", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config);
    mocks.configuredAgentIds = ["default"];

    await refreshPreparedModelRuntimeSnapshots(config);

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/configured-removed",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });
});
