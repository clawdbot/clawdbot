// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as agentDatabase from "../state/openclaw-agent-db-readonly.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveAgentDir } from "./agent-scope.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "./plugin-model-catalog.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "./prepared-model-catalog-owner.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import {
  startSerializedSnapshotBuild,
  startSerializedSnapshotBuildBatch,
} from "./prepared-model-runtime.build.js";
import {
  activateStandalonePreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  resetPreparedModelRuntimeHarness(state);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("prepared fixture containment", () => {
  function assertOwnedPath(target: string) {
    const relative = path.relative(state.root, path.resolve(target));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`PREPARED_FIXTURE_ESCAPE: ${target}`);
    }
  }

  beforeEach(() => {
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (typeof args[0] === "string" && path.basename(args[0]) === "models.json") {
        assertOwnedPath(args[0]);
      }
      return readFileSync(...args);
    });
    const readDatabase = agentDatabase.withOpenClawAgentDatabaseReadOnly;
    vi.spyOn(agentDatabase, "withOpenClawAgentDatabaseReadOnly").mockImplementation(
      (operation, options, behavior) => {
        // Guard before delegation: the reader may reuse a handle before probing the file.
        assertOwnedPath(options.path!);
        return readDatabase(operation, options, behavior);
      },
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["static", "live"] as const)("contains native %s model capture", async (catalogMode) => {
    mocks.configuredAgentIds = ["default", "worker"];
    await refreshPreparedModelRuntimeSnapshots({}, { catalogMode });
    expect(mocks.discoverModels).toHaveBeenCalled();
    for (const agentId of ["default", "worker"]) {
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(state.agentDir(agentId), "models.json"),
        "utf8",
      );
    }
  });

  it("contains the native read-only catalog boundary", () => {
    expect(loadPersistedPluginModelCatalogsReadOnly(resolveAgentDir({}, "default"))).toEqual([]);
    expect(agentDatabase.withOpenClawAgentDatabaseReadOnly).toHaveBeenCalledWith(
      expect.any(Function),
      { agentId: "default", path: path.join(state.agentDir("default"), "openclaw-agent.sqlite") },
    );
  });
});

describe("prepared catalog owner lifecycle", () => {
  it.each([false, true])(
    "retains the current preparation across adopted auth (previous snapshot: %s)",
    async (previousSnapshot) => {
      mocks.configuredAgentIds = ["alpha"];
      const agentDir = state.agentDir("alpha");
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
    const agentDir = state.agentDir("rebound-catalog-agent");
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
    const input = { config: {}, agentDir: state.agentDir("unbound-catalog-agent"), readOnly: true };
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
  it("fails a timed-out publication without overlapping its late build with a retry", async () => {
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
    const source = createDeferred<{ agentDir: string; wrote: false }>();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => await source.promise);
    const input = { config: {}, agentDir: state.agentDir("timeout") };
    const builds = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuild");
    try {
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

      source.resolve({ agentDir: input.agentDir, wrote: false });
      // The timeout settles admission before capture finishes; join the native build, not discovery.
      await builds.mock.results[0]!.value.completion;
      expect(mocks.discoverModels).toHaveBeenCalledOnce();
      await expect(publishPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
        agentDir: input.agentDir,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      source.resolve({ agentDir: input.agentDir, wrote: false });
      await Promise.all(builds.mock.results.map((result) => result.value.completion));
      builds.mockRestore();
    }
  });

  it("serializes workspace replacements for one agent-owned catalog", async () => {
    const finishFirstGate = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
      await finishFirstGate.promise;
      return { agentDir: String(targetDir), wrote: false };
    });
    const config = {};
    const agentDir = state.agentDir("workspace-replacement");
    let first: ReturnType<typeof publishPreparedModelRuntimeSnapshot> | undefined;
    let requestDuringFirstGeneration: ReturnType<typeof prepareModelRuntimeSnapshot> | undefined;
    let replacement: ReturnType<typeof publishPreparedModelRuntimeSnapshot> | undefined;
    try {
      first = publishPreparedModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-old",
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
      requestDuringFirstGeneration = prepareModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-old",
      });

      replacement = publishPreparedModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-new",
      });
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

      finishFirstGate.resolve();
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
    } finally {
      finishFirstGate.resolve();
      await Promise.allSettled([first, replacement, requestDuringFirstGeneration]);
    }
  });

  it("serializes conflicting standalone activations for one owner", async () => {
    const agentDir = state.agentDir("concurrent-standalone");
    const firstConfig = {};
    const secondConfig = {};
    const finishFirstBuildGate = createDeferred();
    let finishFirstBuild!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
      finishFirstBuild = () => finishFirstBuildGate.resolve();
      await finishFirstBuildGate.promise;
      return { agentDir: String(targetDir), wrote: false };
    });

    let firstActivation: ReturnType<typeof activateStandalonePreparedModelRuntime> | undefined;
    let secondActivation: ReturnType<typeof activateStandalonePreparedModelRuntime> | undefined;
    try {
      firstActivation = activateStandalonePreparedModelRuntime({
        config: firstConfig,
        agentDir,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
      secondActivation = activateStandalonePreparedModelRuntime({
        config: secondConfig,
        agentDir,
      });

      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      finishFirstBuild();

      const [first, second] = await Promise.all([firstActivation, secondActivation]);
      expect(first?.config).toBe(firstConfig);
      expect(second?.config).toBe(secondConfig);
      expect(first).not.toBe(second);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      finishFirstBuildGate.resolve();
      await Promise.allSettled([firstActivation, secondActivation]);
    }
  });

  it("allows a direct serialized build without a lifecycle generation guard", async () => {
    const input = {
      config: {},
      agentDir: state.agentDir("direct-prepared-model-runtime-build"),
      readOnly: true,
    };
    const build = startSerializedSnapshotBuild(
      { input, catalogOwner: preparePublishedModelCatalogOwnerIdentity(input) },
      new Map(),
      1_000,
      "static",
    );

    try {
      await expect(build.pending).resolves.toMatchObject({
        snapshot: {
          agentDir: input.agentDir,
          config: input.config,
        },
        pluginGeneration: expect.any(Object),
      });
    } finally {
      await build.completion;
    }
  });

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
    const input = { config: {}, agentDir: state.agentDir("candidate-lifetime"), readOnly: true };
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
      const input = {
        config: {},
        agentDir: state.agentDir("candidate-checkpoint"),
        readOnly: true,
      };
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
