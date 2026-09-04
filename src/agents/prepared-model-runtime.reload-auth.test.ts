// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import {
  acquireAgentRunPreparedModelRuntime,
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshStalePreparedModelRuntimeCatalog,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime reload auth adoption", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("refreshes stale catalog content only when an explicit read requests it", async () => {
    mocks.configuredAgentIds = ["default"];
    const model = {
      provider: "catalog-refresh-fixture",
      id: "authenticated-model",
      name: "Authenticated model",
      api: "openai-completions" as const,
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [model],
      routeVariants: [model],
    });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };
    const liveBuild = createDeferred<{
      entries: Array<typeof model>;
      routeVariants: Array<typeof model>;
    }>();

    await refreshPreparedModelRuntimeSnapshots(input.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    mocks.buildPreparedModelCatalogSnapshot.mockClear();
    mocks.createPreparedModelCatalogWorker.mockClear();
    expect((await prepareModelRuntimeSnapshot(input)).modelCatalog.entries).toEqual([]);

    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: true,
    });

    const authPublished = await prepareModelRuntimeSnapshot(input);
    expect(authPublished).toMatchObject({
      modelCatalog: { entries: [] },
    });
    expect(
      mocks.createPreparedModelCatalogWorker.mock.calls.at(-1)?.[0].agentFacts.providerIds,
    ).toContain("custom");
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

    const nextConfig = { logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(nextConfig);
    const readInput = { ...input, config: nextConfig };
    const published = await prepareModelRuntimeSnapshot(readInput);

    let requestReadSettled = false;
    const requestRead = loadPreparedModelCatalogOwnerSnapshot({
      ...readInput,
      readOnly: true,
    }).then(() => {
      requestReadSettled = true;
    });
    mocks.runPreparedModelCatalogWorker.mockImplementation(() => liveBuild.promise);
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    try {
      expect(requestReadSettled).toBe(true);
      expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
    } finally {
      liveBuild.resolve({ entries: [model], routeVariants: [model] });
      await requestRead;
    }

    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [model],
      routeVariants: [model],
    });
    await expect(refreshStalePreparedModelRuntimeCatalog(published)).resolves.toMatchObject({
      entries: [model],
    });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    await expect(refreshStalePreparedModelRuntimeCatalog(published)).resolves.toBeUndefined();
  });

  it("does not refresh a catalog snapshot that is not owned by the runtime", async () => {
    mocks.configuredAgentIds = ["default"];
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };
    await refreshPreparedModelRuntimeSnapshots(input.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = await prepareModelRuntimeSnapshot(input);
    const unowned = { ...published };

    await expect(refreshStalePreparedModelRuntimeCatalog(unowned)).resolves.toBeUndefined();
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
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
      catalogMode: "static",
    });
    mocks.runPreparedModelCatalogWorker.mockClear();
    mocks.createPreparedModelCatalogWorker.mockClear();
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: false,
    });

    await prepareModelRuntimeSnapshot(input);
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
    expect(
      mocks.createPreparedModelCatalogWorker.mock.calls.at(-1)?.[0].agentFacts.providerIds,
    ).toEqual([]);
  });

  it("shares one live rebuild across concurrent stale catalog reads", async () => {
    mocks.configuredAgentIds = ["default"];
    const model = {
      provider: "catalog-refresh-fixture",
      id: "concurrent-model",
      name: "Concurrent model",
      api: "openai-completions" as const,
    };
    const liveBuild = createDeferred<{
      entries: Array<typeof model>;
      routeVariants: Array<typeof model>;
    }>();
    mocks.runPreparedModelCatalogWorker.mockImplementation(() => liveBuild.promise);
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };

    await refreshPreparedModelRuntimeSnapshots(input.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    const published = await prepareModelRuntimeSnapshot(input);
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

    const first = refreshStalePreparedModelRuntimeCatalog(published);
    const second = refreshStalePreparedModelRuntimeCatalog(published);
    await vi.waitFor(() => expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce());
    liveBuild.resolve({ entries: [model], routeVariants: [model] });

    const catalogs = await Promise.all([first, second]);
    expect(catalogs).toHaveLength(2);
    for (const catalog of catalogs) {
      expect(catalog).toMatchObject({ entries: [model], routeVariants: [model] });
    }
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
  });

  it("commits auth invalidation inside the active lifecycle publication", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    const initialConfig = {};
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const configBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const order: string[] = [];
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
      if (event.phase === "published") {
        order.push("config-published");
      }
    });
    let defaultBuildCount = 0;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir !== state.agentDir("default")) {
        return { agentDir: String(agentDir), wrote: false };
      }
      defaultBuildCount += 1;
      if (defaultBuildCount === 1) {
        order.push("config-build-start");
        return await configBuild.promise;
      }
      order.push("auth-drain-start");
      return await authBuild.promise;
    });

    let publication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let affectedRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let siblingRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    try {
      publication = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      void publication.catch(() => undefined);
      await vi.waitFor(() => expect(order).toContain("config-build-start"));
      order.push("auth-mutation");
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
      });
      affectedRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }).then(
        (runtime) => {
          order.push("affected-dispatch-resolved");
          return runtime;
        },
      );
      siblingRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      void affectedRead.catch(() => undefined);
      void siblingRead.catch(() => undefined);
      order.push("config-build-finish");
      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await vi.waitFor(() => expect(order).toContain("auth-drain-start"));
      await expect(
        Promise.race([publication.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");
      await expect(
        Promise.race([affectedRead.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      order.push("auth-drain-finish");
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await expect(publication).resolves.toBeUndefined();
      const [affectedRuntime, siblingRuntime] = await Promise.all([affectedRead, siblingRead]);
      unregister();

      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(affectedRuntime?.config).toBe(replacementConfig);
      expect(siblingRuntime?.config).toBe(replacementConfig);
      expect(order).toEqual([
        "config-build-start",
        "auth-mutation",
        "config-build-finish",
        "auth-drain-start",
        "auth-drain-finish",
        "config-published",
        "affected-dispatch-resolved",
      ]);
      const buildCountAfterPublication = mocks.ensureOpenClawModelsJson.mock.calls.length;
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(buildCountAfterPublication);
      const lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: state.agentDir("default"),
        config: replacementConfig,
        workspaceDir: "/tmp/unused-workspace",
      });
      expect(lease.snapshot.config).toBe(replacementConfig);
      lease.release();
    } finally {
      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await Promise.allSettled([publication, affectedRead, siblingRead]);
      unregister();
    }
  });

  it("adopts an in-flight auth gate into a same-owner config reload", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const configBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockImplementationOnce(async () => await configBuild.promise);

    let authWaiter: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      void authWaiter.catch(() => undefined);
      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      void reload.catch(() => undefined);
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
      await expect(
        Promise.race([authWaiter.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await expect(reload).resolves.toBeUndefined();
      const runtime = await authWaiter;
      unregister();

      expect(runtime?.config).toBe(replacementConfig);
      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await Promise.allSettled([authWaiter, reload]);
      unregister();
    }
  });

  it("adopts remaining auth work after another owner already published", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const workerAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const replacementWorkerBuild = createDeferred<{ agentDir: string; wrote: false }>();
    let replacementWorkerStarted = false;
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config, agentDir) => {
      if (config === initialConfig && agentDir === state.agentDir("worker")) {
        return await workerAuthBuild.promise;
      }
      if (config === initialConfig && agentDir === state.agentDir("research")) {
        return await researchAuthBuild.promise;
      }
      if (config === replacementConfig && agentDir === state.agentDir("worker")) {
        replacementWorkerStarted = true;
        return await replacementWorkerBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    let firstWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let adoptedWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("worker"),
        affectsInheritedStores: false,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      firstWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      mocks.mutationListener?.({
        agentDir: state.agentDir("research"),
        affectsInheritedStores: false,
      });
      workerAuthBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
      await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      adoptedWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      let adoptedWorkerSettled = false;
      void adoptedWorkerRead.then(
        () => {
          adoptedWorkerSettled = true;
        },
        () => undefined,
      );
      await Promise.resolve();
      expect(adoptedWorkerSettled).toBe(false);

      researchAuthBuild.resolve({ agentDir: state.agentDir("research"), wrote: false });
      await vi.waitFor(() => expect(replacementWorkerStarted).toBe(true));
      expect(adoptedWorkerSettled).toBe(false);
      replacementWorkerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await expect(reload).resolves.toBeUndefined();
      await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
      unregister();

      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
    } finally {
      workerAuthBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      researchAuthBuild.resolve({ agentDir: state.agentDir("research"), wrote: false });
      replacementWorkerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await Promise.allSettled([firstWorkerRead, adoptedWorkerRead, reload]);
      unregister();
    }
  });

  it("rejects an adopted auth gate when config reload fails and permits recovery", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const reloadError = new Error("replacement config failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockRejectedValueOnce(reloadError);

    let authWaiter: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      void authWaiter.catch(() => undefined);
      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      void reload.catch(() => undefined);
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });

      await expect(reload).rejects.toBe(reloadError);
      await expect(authWaiter).rejects.toBe(reloadError);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).rejects.toThrow("prepared reply dispatch runtime owner was not published for default");

      await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: replacementConfig });
    } finally {
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await Promise.allSettled([authWaiter, reload]);
    }
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = state.agentDir("default");
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const firstBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const secondBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const firstError = new Error("superseded auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockImplementationOnce(async () => await secondBuild.promise);

    let dispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    try {
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      void dispatch.catch(() => undefined);
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      firstBuild.reject(firstError);
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
      await expect(
        Promise.race([dispatch.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      secondBuild.resolve({ agentDir, wrote: false });
      await expect(dispatch).resolves.toMatchObject({ agentId: "default", agentDir });
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      firstBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      secondBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await Promise.allSettled([dispatch]);
    }
  });

  it.each([
    { failedAgentId: "worker", successfulAgentId: "research" },
    { failedAgentId: "research", successfulAgentId: "worker" },
  ] as const)(
    "isolates simultaneous scoped auth failure for $failedAgentId",
    async ({ failedAgentId, successfulAgentId }) => {
      mocks.configuredAgentIds = ["default", "worker", "research"];
      const config = {};
      await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      const agentDirs = {
        research: state.agentDir("research"),
        worker: state.agentDir("worker"),
      } as const;
      const builds = {
        research: createDeferred<{ agentDir: string; wrote: false }>(),
        worker: createDeferred<{ agentDir: string; wrote: false }>(),
      };
      const refreshError = new Error(`${failedAgentId} auth build failed`);
      mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
        const agentId =
          agentDir === agentDirs.worker
            ? "worker"
            : agentDir === agentDirs.research
              ? "research"
              : undefined;
        return agentId
          ? await builds[agentId].promise
          : { agentDir: String(agentDir), wrote: false };
      });

      let dispatches:
        | Record<keyof typeof builds, ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>
        | undefined;
      try {
        mocks.mutationListener?.({
          agentDir: agentDirs.worker,
          affectsInheritedStores: false,
        });
        mocks.mutationListener?.({
          agentDir: agentDirs.research,
          affectsInheritedStores: false,
        });
        dispatches = {
          research: loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" }),
          worker: loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" }),
        };
        void dispatches.research.catch(() => undefined);
        void dispatches.worker.catch(() => undefined);
        await vi.waitFor(() =>
          expect(mocks.ensureOpenClawModelsJson.mock.calls.length).toBeGreaterThanOrEqual(4),
        );
        if (failedAgentId === "worker") {
          builds.worker.reject(refreshError);
        } else {
          builds.worker.resolve({ agentDir: agentDirs.worker, wrote: false });
        }
        await vi.waitFor(() =>
          expect(mocks.ensureOpenClawModelsJson.mock.calls.length).toBeGreaterThanOrEqual(5),
        );
        if (failedAgentId === "research") {
          builds.research.reject(refreshError);
        } else {
          builds.research.resolve({ agentDir: agentDirs.research, wrote: false });
        }

        await expect(dispatches[failedAgentId]).rejects.toBe(refreshError);
        await expect(dispatches[successfulAgentId]).resolves.toMatchObject({
          agentId: successfulAgentId,
          agentDir: agentDirs[successfulAgentId],
        });
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: failedAgentId }),
        ).rejects.toThrow(
          `prepared reply dispatch runtime owner was not published for ${failedAgentId}`,
        );
        expect(mocks.warn).toHaveBeenCalledOnce();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(refreshError.message));
      } finally {
        for (const agentId of Object.keys(builds) as Array<keyof typeof builds>) {
          builds[agentId].resolve({ agentDir: agentDirs[agentId], wrote: false });
        }
        await Promise.allSettled(Object.values(dispatches ?? {}));
      }
    },
  );

  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const agentDirs = {
      default: state.agentDir("default"),
      research: state.agentDir("research"),
      worker: state.agentDir("worker"),
    } as const;
    const builds = {
      default: createDeferred<{ agentDir: string; wrote: false }>(),
      research: createDeferred<{ agentDir: string; wrote: false }>(),
      worker: createDeferred<{ agentDir: string; wrote: false }>(),
    };
    const refreshError = new Error("inherited research auth build failed");
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      const entry = Object.entries(agentDirs).find(
        ([, configuredDir]) => configuredDir === agentDir,
      );
      return entry
        ? await builds[entry[0] as keyof typeof builds].promise
        : { agentDir: String(agentDir), wrote: false };
    });

    let dispatches:
      | Record<keyof typeof builds, ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>
      | undefined;
    try {
      mocks.mutationListener?.({ agentDir: agentDirs.worker, affectsInheritedStores: false });
      mocks.mutationListener?.({ agentDir: agentDirs.research, affectsInheritedStores: false });
      mocks.mutationListener?.({ affectsInheritedStores: true });
      dispatches = Object.fromEntries(
        Object.keys(agentDirs).map((agentId) => [
          agentId,
          loadPublishedGatewayReplyDispatchRuntime({ agentId }),
        ]),
      ) as Record<
        keyof typeof agentDirs,
        ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>
      >;
      for (const dispatch of Object.values(dispatches)) {
        void dispatch.catch(() => undefined);
      }
      builds.default.resolve({ agentDir: agentDirs.default, wrote: false });
      builds.worker.resolve({ agentDir: agentDirs.worker, wrote: false });
      await vi.waitFor(() =>
        expect(mocks.ensureOpenClawModelsJson.mock.calls.length).toBeGreaterThanOrEqual(6),
      );

      builds.research.reject(refreshError);

      await expect(dispatches.default).rejects.toBe(refreshError);
      await expect(dispatches.worker).rejects.toBe(refreshError);
      await expect(dispatches.research).rejects.toBe(refreshError);
      expect(mocks.warn).toHaveBeenCalledOnce();
    } finally {
      for (const agentId of Object.keys(builds) as Array<keyof typeof builds>) {
        builds[agentId].resolve({ agentDir: agentDirs[agentId], wrote: false });
      }
      await Promise.allSettled(Object.values(dispatches ?? {}));
    }
  });

  it("commits a successful owner when the final independent owner fails", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const workerBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchError = new Error("final research auth build failed");
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === state.agentDir("worker")) {
        return await workerBuild.promise;
      }
      if (agentDir === state.agentDir("research")) {
        return await researchBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    let workerDispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let researchDispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("worker"),
        affectsInheritedStores: false,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      workerDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      void workerDispatch.catch(() => undefined);
      let workerSettled = false;
      void workerDispatch.then(
        () => {
          workerSettled = true;
        },
        () => undefined,
      );
      mocks.mutationListener?.({
        agentDir: state.agentDir("research"),
        affectsInheritedStores: false,
      });
      researchDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" });
      void researchDispatch.catch(() => undefined);
      workerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
      await vi.waitFor(() => expect(workerSettled).toBe(true));
      await expect(
        Promise.race([researchDispatch.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");
      expect(events).not.toContain("published");
      researchBuild.reject(researchError);

      await expect(workerDispatch).resolves.toMatchObject({ agentId: "worker" });
      await expect(researchDispatch).rejects.toBe(researchError);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" }),
      ).rejects.toThrow("prepared reply dispatch runtime owner was not published for research");
      expect(events).not.toContain("published");
      expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
      unregister();
    } finally {
      workerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      researchBuild.resolve({ agentDir: state.agentDir("research"), wrote: false });
      await Promise.allSettled([workerDispatch, researchDispatch]);
      unregister();
    }
  });

  it("isolates reply projection replacement failure to its component", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const projectionError = new Error("reply projection replacement failed");
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    const replaceSpy = vi
      .spyOn(PreparedReplyDispatchPublicationOwner.prototype, "replace")
      .mockImplementationOnce(() => {
        throw projectionError;
      });

    mocks.mutationListener?.({
      agentDir: state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    mocks.mutationListener?.({
      agentDir: state.agentDir("research"),
      affectsInheritedStores: false,
    });
    const workerDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    const researchDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" });
    void workerDispatch.catch(() => undefined);
    void researchDispatch.catch(() => undefined);

    await expect(workerDispatch).rejects.toBe(projectionError);
    await expect(researchDispatch).resolves.toMatchObject({
      agentId: "research",
      agentDir: state.agentDir("research"),
    });
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );
    expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
    replaceSpy.mockRestore();
    unregister();
  });

  it("lets an adopting reload settle the gate after the obsolete auth build fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const configBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const obsoleteAuthError = new Error("obsolete auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockImplementationOnce(async () => await configBuild.promise);

    let authWaiter: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      void authWaiter.catch(() => undefined);
      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      void reload.catch(() => undefined);
      authBuild.reject(obsoleteAuthError);
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
      await expect(
        Promise.race([authWaiter.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await expect(reload).resolves.toBeUndefined();
      await expect(authWaiter).resolves.toMatchObject({ config: replacementConfig });
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      authBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      configBuild.resolve({ agentDir: state.agentDir("default"), wrote: false });
      await Promise.allSettled([authWaiter, reload]);
    }
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
