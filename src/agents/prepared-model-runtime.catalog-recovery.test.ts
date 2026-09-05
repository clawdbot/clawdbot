// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PreparedModelRuntimeAuthPublicationOwner } from "./prepared-model-runtime-auth-publication.js";
import {
  advancePreparedModelRuntimeConfig,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime catalog recovery", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime-catalog-recovery" });
    resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentDirs.set("default", "/tmp/unused-agent");
    mocks.configuredAgentDirs.set("secondary", "/tmp/configured-secondary");
    mocks.configuredAgentDirs.set("tertiary", "/tmp/configured-tertiary");
  });

  afterEach(async () => {
    await state.cleanup();
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

  it("publishes an auth mutation queued immediately after the recovery commit", async () => {
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

    let injectedMutation = false;
    const resolveSpy = vi
      .spyOn(PreparedModelRuntimeAuthPublicationOwner.prototype, "resolve")
      .mockImplementation(function (this: PreparedModelRuntimeAuthPublicationOwner, ...args) {
        resolveSpy.mockRestore();
        const resolved = this.resolve(...args);
        if (!injectedMutation) {
          injectedMutation = true;
          queueMicrotask(() => {
            mocks.mutationListener?.({
              agentDir: "/tmp/unused-agent",
              affectsInheritedStores: false,
            });
          });
        }
        return resolved;
      });

    try {
      const recovery =
        replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
      mocks.mutationListener?.({
        agentDir: "/tmp/configured-secondary",
        affectsInheritedStores: false,
      });
      await expect(recovery).resolves.toBe(true);

      await expect(prepareModelRuntimeSnapshot(defaultInput)).resolves.not.toBe(initialDefault);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ agentId: "default" });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(6);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("continues queued recovery after a model-neutral config stamp", async () => {
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

    let releaseAuthBuild: (() => void) | undefined;
    const authBuildBlocked = new Promise<void>((resolve) => {
      releaseAuthBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      await authBuildBlocked;
      return { agentDir: String(args[1]), wrote: false };
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    const stampedConfig = { logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(stampedConfig);
    releaseAuthBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default", config: stampedConfig });
  });

  it("publishes recovered dispatch while an unrelated owner remains degraded", async () => {
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

    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(new Error("secondary auth failed"));
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());

    await expect(
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault),
    ).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
  });

  it("restores recovered dispatch when an adopted sibling refresh fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
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
    const siblingError = new Error("adopted secondary auth failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async (...args: unknown[]) => {
        signalRecoveryBuildStarted?.();
        await recoveryBuildBlocked;
        return { agentDir: String(args[1]), wrote: false };
      })
      .mockImplementationOnce(async () => {
        mocks.mutationListener?.({
          agentDir: "/tmp/configured-tertiary",
          affectsInheritedStores: false,
        });
        throw siblingError;
      });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    await recoveryBuildStarted;
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    releaseRecoveryBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" }),
    ).resolves.toMatchObject({ agentId: "tertiary" });
  });

  it.each([
    ["recovery first", ["secondary", "tertiary"]],
    ["sibling first", ["tertiary", "secondary"]],
  ])("settles an independent owner when adopted auth fails for the %s", async (_label, order) => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    const authError = new Error("adopted default auth failed");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      signalRecoveryBuildStarted?.();
      await recoveryBuildBlocked;
      return { agentDir: String(args[1]), wrote: false };
    });
    for (const agentId of order) {
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
        if (agentId === "secondary") {
          throw authError;
        }
        return { agentDir: String(args[1]), wrote: false };
      });
    }

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    await recoveryBuildStarted;
    for (const agentId of order) {
      mocks.mutationListener?.({
        agentDir:
          agentId === "secondary" ? "/tmp/configured-secondary" : "/tmp/configured-tertiary",
        affectsInheritedStores: false,
      });
    }
    releaseRecoveryBuild?.();

    await expect(recovery).rejects.toBe(authError);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" }),
    ).resolves.toMatchObject({ agentId: "tertiary" });
  });

  it("keeps a completed owner pending when later auth work links it to failed recovery", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    const authError = new Error("adopted secondary auth failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async (...args: unknown[]) => ({
        agentDir: String(args[1]),
        wrote: false,
      }))
      .mockImplementationOnce(async (...args: unknown[]) => ({
        agentDir: String(args[1]),
        wrote: false,
      }))
      .mockImplementationOnce(async () => {
        mocks.mutationListener?.({ affectsInheritedStores: true });
        throw authError;
      });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-tertiary",
      affectsInheritedStores: false,
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });

    await expect(recovery).rejects.toBe(authError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for tertiary",
    );
  });

  it("settles adopted auth work when the recovery build fails", async () => {
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

    const recoveryError = new Error("default recovery failed");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      mocks.mutationListener?.({
        agentDir: "/tmp/configured-secondary",
        affectsInheritedStores: false,
      });
      throw recoveryError;
    });

    await expect(
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault),
    ).rejects.toBe(recoveryError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for default",
    );
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).resolves.toMatchObject({ agentId: "secondary" });
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
