// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime reload auth adoption", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("does not live-refresh a token rotation with the same profile set", async () => {
    mocks.configuredAgentIds = ["default"];
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };

    await refreshPreparedModelRuntimeSnapshots(input.config, {
      gatewayLifecycle: true,
    });
    // Publication kicked birth discovery; an ordinary read joins that in-flight build.
    await (await prepareModelRuntimeSnapshot(input)).loadFullModelCatalog?.();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    mocks.runPreparedModelCatalogWorker.mockClear();
    mocks.createPreparedModelCatalogWorkerInput.mockClear();
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: false,
    });

    await prepareModelRuntimeSnapshot(input);
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
    expect(
      mocks.createPreparedModelCatalogWorkerInput.mock.calls.at(-1)?.[0].agentFacts.providerIds,
    ).toEqual(["custom"]);
  });

  it("rediscovers the catalog once when an auth mutation changes the profile set", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config,
    });
    await snapshot.loadFullModelCatalog?.();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    mocks.runPreparedModelCatalogWorker.mockClear();

    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });

    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config });
    await vi.waitFor(() => expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce());
  });

  it("commits config build, auth drain, publication, and dispatch in order", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
    });
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      phases.push(phase),
    );
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
        profileSetChanged: true,
      });
      const dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      await refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      await dispatch;
      expect(phases).toContain("published");
      expect(phases.indexOf("invalidated")).toBeLessThan(phases.indexOf("published"));
    } finally {
      unregister();
    }
  });

  it("recovers with a corrective auth mutation after a failed build", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
    });
    const failure = new Error("auth refresh build failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw failure;
    });
    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toBe(
      failure,
    );

    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
  });

  it("commits no published owner when the final independent owner fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const failure = new Error("secondary auth refresh failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => mocks.authStorage);
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true })).rejects.toBe(
      failure,
    );
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toThrow(
      "not published",
    );
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("not published");
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
