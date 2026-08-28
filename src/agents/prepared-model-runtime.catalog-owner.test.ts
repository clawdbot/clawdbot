// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "./prepared-model-catalog-owner.js";
import {
  startSerializedSnapshotBuild,
  startSerializedSnapshotBuildBatch,
} from "./prepared-model-runtime.build.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

beforeEach(() => resetPreparedModelRuntimeHarness());

describe("prepared catalog owner lifecycle", () => {
  it.each([false, true])(
    "retains the current preparation across adopted auth (previous snapshot: %s)",
    async (previousSnapshot) => {
      mocks.configuredAgentIds = ["alpha"];
      const agentDir = "/tmp/configured-alpha";
      if (previousSnapshot) {
        mocks.configuredWorkspaces.set("alpha", "/tmp/old-workspace");
        await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
      }
      const workspaceDir = "/tmp/fresh-workspace";
      mocks.configuredWorkspaces.set("alpha", workspaceDir);
      const config = { plugins: {} };
      const source = createDeferred<{ agentDir: string; wrote: false }>();
      const auth = createDeferred<{ agentDir: string; wrote: false }>();
      const started = createDeferred();
      const authStarted = createDeferred();
      mocks.ensureOpenClawModelsJson
        .mockImplementationOnce(async () => {
          started.resolve();
          return await source.promise;
        })
        .mockImplementationOnce(async () => {
          authStarted.resolve();
          return await auth.promise;
        });
      const phases: string[] = [];
      const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
        phases.push(phase),
      );
      const publication = refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      let published = false;
      void publication.then(
        () => {
          published = true;
        },
        () => undefined,
      );
      let dispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
      let dispatched = false;
      try {
        await started.promise;
        dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "alpha" });
        void dispatch.then(
          () => {
            dispatched = true;
          },
          () => undefined,
        );
        // Any later inference is now wrong, including an auth build with no completed snapshot.
        mocks.configuredAgentDirs.set("alpha", "/tmp/later-agent");
        mocks.configuredWorkspaces.set("alpha", "/tmp/later-workspace");
        mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
        source.resolve({ agentDir, wrote: false });
        await authStarted.promise;
        expect(published).toBe(false);
        expect(dispatched).toBe(false);
        expect(phases).not.toContain("published");
        auth.resolve({ agentDir, wrote: false });
        await publication;
        await expect(dispatch).resolves.toMatchObject({
          agentId: "alpha",
          agentDir,
          workspaceDir,
          config,
        });
        const snapshot = await prepareModelRuntimeSnapshot({ agentId: "alpha", agentDir, config });
        expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
          agentId: "alpha",
          workspaceDir,
        });
        expect(phases.filter((phase) => phase === "published")).toHaveLength(1);
        expect(phases).not.toContain("failed");
      } finally {
        source.resolve({ agentDir, wrote: false });
        auth.resolve({ agentDir, wrote: false });
        await Promise.allSettled([publication, dispatch]);
        unregister();
      }
    },
  );

  it("refreshes a newer beta preparation instead of the completed alpha snapshot", async () => {
    const agentDir = "/tmp/rebound-catalog-agent";
    const workspaceDir = "/tmp/rebound-catalog-workspace";
    const input = { agentDir, inheritedAuthDir: agentDir, workspaceDir, config: {} };
    mocks.configuredAgentIds = ["alpha"];
    mocks.configuredAgentDirs.set("alpha", agentDir);
    const alpha = await publishPreparedModelRuntimeSnapshot(input);
    expect(resolvePublishedModelCatalogOwner(alpha)).toMatchObject({ agentId: "alpha" });
    mocks.configuredAgentIds = ["beta"];
    mocks.configuredAgentDirs.set("beta", agentDir);
    const freshInput = { ...input, config: { plugins: {} } };
    const source = createDeferred<{ agentDir: string; wrote: false }>();
    const started = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      started.resolve();
      return await source.promise;
    });
    const fresh = publishPreparedModelRuntimeSnapshot(freshInput, { force: true });
    void fresh.catch(() => undefined);
    let refreshed: Promise<Awaited<ReturnType<typeof prepareModelRuntimeSnapshot>>> | undefined;
    try {
      await started.promise;
      expect(resolvePublishedModelCatalogOwner(alpha)).toMatchObject({ agentId: "alpha" });
      // The beta fact must already exist; neither the old snapshot nor ambient inference can supply it.
      mocks.configuredAgentIds = ["gamma"];
      mocks.configuredAgentDirs.set("gamma", agentDir);
      mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
      refreshed = prepareModelRuntimeSnapshot(freshInput);
      void refreshed.catch(() => undefined);
      source.resolve({ agentDir, wrote: false });
      await expect(fresh).rejects.toThrow("superseded");
      const snapshot = await refreshed;
      expect(snapshot.agentId).toBeUndefined();
      expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
        agentId: "beta",
        workspaceDir,
      });
    } finally {
      source.resolve({ agentDir, wrote: false });
      await Promise.allSettled([fresh, refreshed]);
    }
  });

  it("retains known-unbound identity across auth refresh while runtime reads stay usable", async () => {
    const input = { config: {}, agentDir: "/tmp/unbound-catalog-agent", readOnly: true };
    mocks.configuredAgentIds = ["alpha"];
    const first = await publishPreparedModelRuntimeSnapshot(input);
    expect(() => resolvePublishedModelCatalogOwner(first)).toThrow(
      "did not identify one configured agent",
    );
    mocks.configuredAgentDirs.set("alpha", input.agentDir);
    expect(preparePublishedModelCatalogOwnerIdentity(input)).toMatchObject({ agentId: "alpha" });
    mocks.mutationListener!({ agentDir: input.agentDir, affectsInheritedStores: false });
    const refreshed = await prepareModelRuntimeSnapshot(input);
    expect(refreshed.createStores().authStorage.getAll()).toMatchObject({
      custom: { type: "api_key" },
    });
    expect(refreshed.workspaceDir).toBeUndefined();
    expect(() => resolvePublishedModelCatalogOwner(refreshed)).toThrow(
      "did not identify one configured agent",
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});

describe("prepared build candidate lifetime", () => {
  it.each([
    {
      name: "single default",
      single: true,
      generation: undefined,
      build: undefined,
      allowed: true,
      callbacks: true,
    },
    {
      name: "batch default",
      single: false,
      generation: undefined,
      build: undefined,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch build-only",
      single: false,
      generation: undefined,
      build: true,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch missing build predicate",
      single: false,
      generation: false,
      build: undefined,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch inherited generation predicate",
      single: false,
      generation: false,
      build: false,
      allowed: false,
      callbacks: false,
    },
  ])("preserves $name semantics", async ({ single, generation, build, allowed, callbacks }) => {
    const input = { config: {}, agentDir: "/tmp/candidate-lifetime", readOnly: true };
    const candidate = {
      input,
      catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      ...(generation === undefined ? {} : { isGenerationCurrent: () => generation }),
      ...(build === undefined ? {} : { isBuildCurrent: () => build }),
    };
    const started = single
      ? startSerializedSnapshotBuild(candidate, new Map(), 1_000, "static")
      : startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000, "static");
    try {
      if (!allowed) {
        await expect(started.pending).rejects.toThrow("superseded");
      } else {
        const result = await started.pending;
        const { snapshot } = Array.isArray(result) ? result[0]! : result;
        if (callbacks) {
          await expect(snapshot.loadFullModelCatalog!()).resolves.toMatchObject({ entries: [] });
        } else {
          await expect(snapshot.loadFullModelCatalog!()).rejects.toThrow("superseded");
        }
      }
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    } finally {
      await started.completion;
    }
  });

  it.each(["before", "after"] as const)(
    "checks supersession %s workspace preparation",
    async (checkpoint) => {
      const input = { config: {}, agentDir: "/tmp/candidate-checkpoint", readOnly: true };
      const candidate = {
        input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
        isGenerationCurrent: () => false,
        isBuildCurrent: () => false,
        ...(checkpoint === "before" ? { isPreparationCurrent: () => false } : {}),
      };
      const build = startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000, "static");
      try {
        await expect(build.pending).rejects.toThrow("superseded");
        expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(checkpoint === "before" ? 0 : 1);
        expect(mocks.discoverModels).not.toHaveBeenCalled();
      } finally {
        await build.completion;
      }
    },
  );
});
