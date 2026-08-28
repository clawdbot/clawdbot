// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime reload auth adoption", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
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
      if (agentDir !== "/tmp/unused-agent") {
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

    const publication = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void publication.catch(() => undefined);
    await vi.waitFor(() => expect(order).toContain("config-build-start"));
    order.push("auth-mutation");
    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    const affectedRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }).then(
      (runtime) => {
        order.push("affected-dispatch-resolved");
        return runtime;
      },
    );
    const siblingRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    void affectedRead.catch(() => undefined);
    void siblingRead.catch(() => undefined);
    order.push("config-build-finish");
    configBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await vi.waitFor(() => expect(order).toContain("auth-drain-start"));
    await expect(
      Promise.race([publication.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    await expect(
      Promise.race([affectedRead.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    order.push("auth-drain-finish");
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
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
      agentDir: "/tmp/unused-agent",
      config: replacementConfig,
      workspaceDir: "/tmp/unused-workspace",
    });
    expect(lease.snapshot.config).toBe(replacementConfig);
    lease.release();
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

    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void authWaiter.catch(() => undefined);
    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void reload.catch(() => undefined);
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(
      Promise.race([authWaiter.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    configBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await expect(reload).resolves.toBeUndefined();
    const runtime = await authWaiter;
    unregister();

    expect(runtime?.config).toBe(replacementConfig);
    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
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
      if (config === initialConfig && agentDir === "/tmp/configured-worker") {
        return await workerAuthBuild.promise;
      }
      if (config === initialConfig && agentDir === "/tmp/configured-research") {
        return await researchAuthBuild.promise;
      }
      if (config === replacementConfig && agentDir === "/tmp/configured-worker") {
        replacementWorkerStarted = true;
        return await replacementWorkerBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mocks.mutationListener?.({
      agentDir: "/tmp/configured-worker",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    const firstWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-research",
      affectsInheritedStores: false,
    });
    workerAuthBuild.resolve({ agentDir: "/tmp/configured-worker", wrote: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
    await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    const adoptedWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    let adoptedWorkerSettled = false;
    void adoptedWorkerRead.then(() => {
      adoptedWorkerSettled = true;
    });
    await Promise.resolve();
    expect(adoptedWorkerSettled).toBe(false);

    researchAuthBuild.resolve({ agentDir: "/tmp/configured-research", wrote: false });
    await vi.waitFor(() => expect(replacementWorkerStarted).toBe(true));
    expect(adoptedWorkerSettled).toBe(false);
    replacementWorkerBuild.resolve({ agentDir: "/tmp/configured-worker", wrote: false });
    await expect(reload).resolves.toBeUndefined();
    await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
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

    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void authWaiter.catch(() => undefined);
    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void reload.catch(() => undefined);
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });

    await expect(reload).rejects.toBe(reloadError);
    await expect(authWaiter).rejects.toBe(reloadError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for default",
    );

    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: replacementConfig });
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = "/tmp/unused-agent";
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const firstBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const secondBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const firstError = new Error("superseded auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockImplementationOnce(async () => await secondBuild.promise);

    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
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
        research: "/tmp/configured-research",
        worker: "/tmp/configured-worker",
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

      mocks.mutationListener?.({
        agentDir: agentDirs.worker,
        affectsInheritedStores: false,
      });
      mocks.mutationListener?.({
        agentDir: agentDirs.research,
        affectsInheritedStores: false,
      });
      const dispatches = {
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
    },
  );

  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const agentDirs = {
      default: "/tmp/unused-agent",
      research: "/tmp/configured-research",
      worker: "/tmp/configured-worker",
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

    mocks.mutationListener?.({ agentDir: agentDirs.worker, affectsInheritedStores: false });
    mocks.mutationListener?.({ agentDir: agentDirs.research, affectsInheritedStores: false });
    mocks.mutationListener?.({ affectsInheritedStores: true });
    const dispatches = Object.fromEntries(
      Object.keys(agentDirs).map((agentId) => [
        agentId,
        loadPublishedGatewayReplyDispatchRuntime({ agentId }),
      ]),
    ) as Record<keyof typeof agentDirs, Promise<unknown>>;
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
      if (agentDir === "/tmp/configured-worker") {
        return await workerBuild.promise;
      }
      if (agentDir === "/tmp/configured-research") {
        return await researchBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mocks.mutationListener?.({
      agentDir: "/tmp/configured-worker",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    const workerDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    void workerDispatch.catch(() => undefined);
    let workerSettled = false;
    void workerDispatch.then(() => {
      workerSettled = true;
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-research",
      affectsInheritedStores: false,
    });
    const researchDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" });
    void researchDispatch.catch(() => undefined);
    workerBuild.resolve({ agentDir: "/tmp/configured-worker", wrote: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(workerSettled).toBe(true));
    await expect(
      Promise.race([researchDispatch.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    expect(events).not.toContain("published");
    researchBuild.reject(researchError);

    await expect(workerDispatch).resolves.toMatchObject({ agentId: "worker" });
    await expect(researchDispatch).rejects.toBe(researchError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for research",
    );
    expect(events).not.toContain("published");
    expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
    unregister();
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
      agentDir: "/tmp/configured-worker",
      affectsInheritedStores: false,
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-research",
      affectsInheritedStores: false,
    });
    const workerDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    const researchDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" });
    void workerDispatch.catch(() => undefined);
    void researchDispatch.catch(() => undefined);

    await expect(workerDispatch).rejects.toBe(projectionError);
    await expect(researchDispatch).resolves.toMatchObject({
      agentId: "research",
      agentDir: "/tmp/configured-research",
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

    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void authWaiter.catch(() => undefined);
    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void reload.catch(() => undefined);
    authBuild.reject(obsoleteAuthError);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(
      Promise.race([authWaiter.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    configBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await expect(reload).resolves.toBeUndefined();
    await expect(authWaiter).resolves.toMatchObject({ config: replacementConfig });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
