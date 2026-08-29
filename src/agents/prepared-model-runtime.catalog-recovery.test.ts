// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime catalog recovery", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("drains queued auth mutations before rebuilding reply dispatch", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await expect(recovery).resolves.toBe(true);

    await expect(prepareModelRuntimeSnapshot(defaultInput)).resolves.not.toBe(initialDefault);
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "secondary",
        config,
        agentDir: "/tmp/configured-secondary",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-secondary",
      }),
    ).resolves.toMatchObject({ agentId: "secondary" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).resolves.toMatchObject({ agentId: "secondary" });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
  });

  it("defers to a config replacement that supersedes recovery", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      signalRecoveryBuildStarted?.();
      await recoveryBuildBlocked;
      return { agentDir: "/tmp/unused-agent", wrote: false };
    });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    await recoveryBuildStarted;
    const replacementConfig = { gateway: { mode: "local" as const } };
    const configReplacement = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    releaseRecoveryBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(configReplacement).resolves.toBeUndefined();
    await expect(
      prepareModelRuntimeSnapshot({ ...defaultInput, config: replacementConfig }),
    ).resolves.toMatchObject({ config: replacementConfig });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: replacementConfig });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });
});
