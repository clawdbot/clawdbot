// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  rejectPendingPreparedModelRuntimeReplacement,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime snapshots", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
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

  it("publishes invalidation before the replacement generation", async () => {
    mocks.configuredAgentIds = ["default"];
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });

    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    unregister();
    await refreshPreparedModelRuntimeSnapshots({});

    expect(events).toEqual(["invalidated", "published"]);
  });

  it("makes the replacement owner readable before announcing publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    let publishedOwner: ReturnType<typeof getPreparedModelRuntimeSnapshot>;
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedOwner = getPreparedModelRuntimeSnapshot({
          agentId: "default",
          agentDir: "/tmp/unused-agent",
          inheritedAuthDir: "/tmp/unused-agent",
          config: replacementConfig,
        });
      }
    });

    await refreshPreparedModelRuntimeSnapshots(replacementConfig);
    unregister();

    expect(publishedOwner).toMatchObject({ config: replacementConfig });
  });

  it("announces invalidation from the direct stale owner boundary", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });

    markPreparedModelRuntimeSnapshotsStale("test direct reload stale edge", {
      waitForReplacement: true,
    });
    unregister();

    expect(events).toEqual(["invalidated"]);
  });

  it("terminates direct invalidation when no replacement owns it", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const events: Array<{ phase: string; error?: Error }> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event);
    });

    markPreparedModelRuntimeSnapshotsStale("direct invalidation has no replacement");
    unregister();

    expect(events).toEqual([
      { phase: "invalidated" },
      {
        phase: "failed",
        error: expect.objectContaining({ message: "direct invalidation has no replacement" }),
      },
    ]);
  });

  it("announces a failed replacement so lifecycle readers do not wait indefinitely", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const events: Array<{ phase: string; error?: Error }> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event);
    });
    const replacementError = new Error("replacement aborted");

    const gateId = markPreparedModelRuntimeSnapshotsStale("test failed reload", {
      waitForReplacement: true,
    });
    rejectPendingPreparedModelRuntimeReplacement(gateId, replacementError);
    unregister();

    expect(events).toEqual([
      { phase: "invalidated" },
      { phase: "failed", error: replacementError },
    ]);
  });

  it("does not let a read-only draft replace a configured gateway owner", async () => {
    mocks.configuredAgentIds = ["default"];
    const configured = retainLegacyDefaultAgentId(
      { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { default: {} } } },
      "default",
    );
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

  it("publishes a static turn generation without live catalog discovery", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: {},
        agentId: "default",
        agentDir: "/tmp/static-run-agent",
        workspaceDir: "/tmp/static-run-workspace",
      },
      { catalogMode: "static" },
    );

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    lease.release();
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

  it("retains an exact dynamic workspace owner after gateway run admission", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const workspaceDir = "/tmp/spawned-workspace";
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const acquireDynamicLease = () =>
      acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir,
      });
    const [firstLease, secondLease] = await Promise.all([
      acquireDynamicLease(),
      acquireDynamicLease(),
    ]);

    expect(firstLease.snapshot.workspaceDir).toBe(workspaceDir);
    expect(secondLease.snapshot).toBe(firstLease.snapshot);
    firstLease.release();
    secondLease.release();
    const retainedLease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir,
    });
    expect(retainedLease.snapshot).toBe(firstLease.snapshot);
    retainedLease.release();
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
    const config = retainLegacyDefaultAgentId({ agents: { entries: { default: {} } } }, "default");
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
    });

    expect(lease.snapshot.workspaceDir).toBe("/tmp/gateway-launch-workspace");
    lease.release();
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
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
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
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
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(100);
    mocks.configuredAgentIds = ["default"];
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: "/tmp/unused-agent", wrote: false })
      .mockImplementationOnce(async () => await new Promise<never>(() => {}));

    await expect(
      refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" }),
    ).resolves.toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
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

  it("defers an in-flight auth refresh to a superseding config publication", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishAuthRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
    const reload = refreshPreparedModelRuntimeSnapshots(
      { agents: { defaults: { model: "openai/gpt-5.5" } } },
      { gatewayLifecycle: true },
    );
    finishAuthRefresh?.();
    await reload;
    unregister();

    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
  });

  it("does not announce an auth republication while a config replacement gate is pending", async () => {
    mocks.configuredAgentIds = ["default"];
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const publishedSnapshots: Array<ReturnType<typeof getPreparedModelRuntimeSnapshot>> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedSnapshots.push(
          getPreparedModelRuntimeSnapshot({
            agentId: "default",
            agentDir: "/tmp/unused-agent",
            inheritedAuthDir: "/tmp/unused-agent",
            config: replacementConfig,
          }),
        );
      }
    });

    // The mutation queues an auth task; the synchronous stale edge of the config
    // refresh opens the replacement gate before that task runs.
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    unregister();

    expect(publishedSnapshots).toHaveLength(1);
    expect(publishedSnapshots[0]).toMatchObject({ config: replacementConfig });
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

  it("rejects a deduplicated caller when an auth refresh is superseded", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-auth-pending-superseded";
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
    const deduplicated = publishPreparedModelRuntimeSnapshot({ config, agentDir });
    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    finishFirstRefresh?.();

    await expect(deduplicated).rejects.toThrow("superseded");
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).resolves.toMatchObject({
      agentDir,
    });
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
});
