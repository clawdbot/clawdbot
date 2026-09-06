import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import * as contextEngineRegistry from "../context-engine/registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getGlobalPluginRegistry, initializeGlobalHookRunner } from "./hook-runner-global.js";
import { createPluginHostRegistryRetirement, runPluginHostCleanup } from "./host-hook-cleanup.js";
import {
  cleanupPluginSessionSchedulerJobs,
  getPluginRunContext,
  setPluginRunContext,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "./host-hook-runtime.test-fixtures.js";
import { activatePluginRegistry } from "./loader-shared.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { projectPluginContributions } from "./registry-contributions.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  getPluginRecordRegistry,
  isPluginRegistryLifecycleEpochActive,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import {
  captureActivePluginRegistrySnapshot,
  clearActivePluginRegistry,
  commitStagedPluginRegistry,
  createPluginRegistryOwner,
  getActivePluginRegistry,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createRuntimeSystem } from "./runtime/runtime-system.js";
import type { PluginRuntime } from "./runtime/types.js";
import { buildPluginLoaderAliasMap, buildPluginLoaderJitiOptions } from "./sdk-alias.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const hookTurn = {
  name: "Lifecycle probe",
  agentId: "main",
  sessionKey: "hook:probe",
  message: "Probe",
  externalContentSource: "email",
  deliver: false,
} satisfies Parameters<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>[0];

function builder(system?: PluginRuntime["system"]) {
  const runtime = createPluginRuntime({
    hooks: {
      dispatchHookAgentTurn: async () => ({
        ok: true,
        runId:
          getPluginRuntimeGatewayRequestScope()?.pluginRegistry === getActivePluginRegistry()
            ? "published"
            : "preparing",
      }),
    },
  });
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: {
      ...runtime,
      system: system ?? runtime.system,
      config: { ...runtime.config, current: () => ({}) },
    },
    activateGlobalSideEffects: true,
  });
}

function addPlugin(owner: ReturnType<typeof builder>, id: string) {
  const record = createPluginRecord({ id, origin: "bundled", enabled: true, status: "loaded" });
  const api = owner.createApi(record, { config: {} });
  owner.registry.plugins.push(record);
  const onDispose = api.lifecycle.onDispose;
  assert(onDispose, "Registry-created plugins expose lifecycle disposal registration");
  return { record, api, onDispose };
}

afterEach(async () => {
  await clearActivePluginRegistry();
});

describe("plugin instance publication", () => {
  it("shares publication, preparation, and retirement with transformed SDK modules", async () => {
    const modulePath = fileURLToPath(new URL("./registry-lifecycle.ts", import.meta.url));
    // Raw Jiti does not inherit Vitest's workspace aliases.
    const aliasMap = buildPluginLoaderAliasMap(modulePath, "", undefined, "src");
    const sdk = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative: false,
      moduleCache: false,
      fsCache: false,
    })(modulePath) as typeof import("./registry-lifecycle.js");
    const first = builder();
    const { record, api, onDispose } = addPlugin(first, "shared-owner");
    const cleanup = vi.fn();
    const disposed = vi.fn();
    api.registerRuntimeLifecycle({ id: "shared-owner", cleanup });
    onDispose(disposed);
    const callback = getPluginInstance(record)!.wrap(() => "current");
    await sdk.withPluginRegistryPreparationScope(first.registry, async () => {
      expect(capturePluginLifecycleAuthority(first.registry, record)?.()).toBe(true);
    });
    expect(capturePluginLifecycleAuthority(first.registry, record)).toBeUndefined();
    setActivePluginRegistry(first.registry);
    const authority = sdk.capturePluginLifecycleAuthority(first.registry, record)!;
    expect(authority()).toBe(true);
    expect(
      isPluginRegistryLifecycleEpochActive(
        first.registry,
        sdk.capturePluginRegistryLifecycleEpoch(first.registry)!,
      ),
    ).toBe(true);
    const next = builder();
    next.registry.plugins.push(record);
    projectPluginContributions(first.registry, record, next.registry);
    expect(sdk.capturePluginLifecycleAuthority(next.registry, record)).toBeUndefined();
    expect(
      sdk.capturePluginLifecycleAuthority(next.registry, record, { scopedRuntime: true }),
    ).toBeUndefined();
    setActivePluginRegistry(next.registry);
    expect(sdk.getPluginRecordRegistry(first.registry, record)).toBe(next.registry);
    expect(getPluginRecordRegistry(first.registry, record)).toBe(next.registry);
    expect(authority()).toBe(true);
    expect(sdk.capturePluginLifecycleAuthority(first.registry, record)).toBeUndefined();
    expect(sdk.capturePluginLifecycleAuthority(next.registry, record)?.()).toBe(true);
    sdk.markPluginRegistryRetired(next.registry);
    expect(authority()).toBe(false);
    expect(capturePluginLifecycleAuthority(next.registry, record)).toBeUndefined();
    expect(callback).toThrow("reloaded or disabled");
    await clearActivePluginRegistry();
    await waitForPluginRegistryRetirement(first.registry);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("keeps runtime system reads available while fencing events until publication", async () => {
    const system = {
      ...createRuntimeSystem(),
      enqueueSystemEvent: vi
        .fn<PluginRuntime["system"]["enqueueSystemEvent"]>()
        .mockReturnValue(true),
      requestHeartbeat: vi.fn<PluginRuntime["system"]["requestHeartbeat"]>(),
      formatNativeDependencyHint: vi.fn().mockReturnValue("hint"),
    };
    const candidate = builder(system);
    const { api } = addPlugin(candidate, "events");
    const emit = () => api.runtime.system.enqueueSystemEvent("probe", { sessionKey: "main" });
    const heartbeat = () =>
      api.runtime.system.requestHeartbeat({
        source: "other",
        intent: "immediate",
        reason: "probe",
      });
    expect(api.runtime.system.formatNativeDependencyHint({ packageName: "probe" })).toBe("hint");
    expect(emit).toThrow("no longer active");
    await withPluginRegistryPreparationScope(candidate.registry, async () => {
      expect(emit).toThrow("before publication");
      expect(heartbeat).toThrow("before publication");
    });
    expect(system.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(system.requestHeartbeat).not.toHaveBeenCalled();
    setActivePluginRegistry(candidate.registry);
    expect(emit()).toBe(true);
    heartbeat();
    expect(system.requestHeartbeat).toHaveBeenCalledOnce();
    await clearActivePluginRegistry();
    expect(emit).toThrow("no longer active");
  });
  it("keeps retained callbacks current and permanently revokes replaced instances", async () => {
    const old = builder();
    const retained = addPlugin(old, "retained");
    const replaced = addPlugin(old, "replaced");
    setActivePluginRegistry(old.registry);
    const retainedAuthority = capturePluginLifecycleAuthority(old.registry, retained.record)!;
    const replacedAuthority = capturePluginLifecycleAuthority(old.registry, replaced.record)!;
    const next = builder();
    next.registry.plugins.push(retained.record);
    projectPluginContributions(old.registry, retained.record, next.registry);
    addPlugin(next, "replaced");
    stageActivePluginRegistry(next.registry, null, "default");
    commitStagedPluginRegistry(old.registry, next.registry);
    await waitForPluginRegistryRetirement(old.registry);

    expect(retainedAuthority()).toBe(true);
    expect(replacedAuthority()).toBe(false);
    expect(retained.api.setRunContext({ runId: "live", namespace: "probe", value: true })).toBe(
      true,
    );
    expect(replaced.api.setRunContext({ runId: "stale", namespace: "probe", value: true })).toBe(
      false,
    );
    await expect(retained.api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toMatchObject(
      { runId: "published" },
    );
    await expect(replaced.api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      "no longer active",
    );

    const staleCopy = builder();
    staleCopy.registry.plugins.push(replaced.record);
    setActivePluginRegistry(staleCopy.registry);
    expect(capturePluginLifecycleAuthority(staleCopy.registry, replaced.record)).toBeUndefined();
    expect(replacedAuthority()).toBe(false);
  });

  it("permits candidate preparation only inside the owner's bounded scope", async () => {
    const candidate = builder();
    const { api } = addPlugin(candidate, "candidate");
    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      "no longer active",
    );
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<unknown>;
    await withPluginRegistryPreparationScope(candidate.registry, async () => {
      await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toMatchObject({
        runId: "preparing",
      });
      expect(api.setRunContext({ runId: "unpublished", namespace: "probe", value: true })).toBe(
        false,
      );
      late = ready.then(() => api.runtime.hooks.dispatchHookAgentTurn(hookTurn));
    });
    release();
    await expect(late).rejects.toThrow("no longer active");
    setActivePluginRegistry(candidate.registry);
    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toMatchObject({
      runId: "published",
    });
  });

  it("restores retained authority on failed publication without reviving the failed candidate", async () => {
    const old = builder();
    const retained = addPlugin(old, "retained");
    setActivePluginRegistry(old.registry);
    const before = captureActivePluginRegistrySnapshot();
    const authority = capturePluginLifecycleAuthority(old.registry, retained.record)!;
    const candidate = builder();
    candidate.registry.plugins.push(retained.record);
    const failed = addPlugin(candidate, "failed");
    stageActivePluginRegistry(candidate.registry, null, "default");
    rollbackStagedPluginRegistry(before);
    await waitForPluginRegistryRetirement(candidate.registry);

    expect(getActivePluginRegistry()).toBe(old.registry);
    expect(authority()).toBe(true);
    await expect(retained.api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toMatchObject(
      { runId: "published" },
    );
    await expect(failed.api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      "no longer active",
    );
  });

  it("publishes scheduler jobs once and leaves predecessor jobs untouched by failed candidates", async () => {
    const old = builder();
    const retained = addPlugin(old, "scheduler");
    const cleanup = vi.fn();
    retained.api.registerSessionSchedulerJob({
      id: "static",
      sessionKey: "main",
      kind: "probe",
      cleanup,
    });
    expect(old.registry.sessionSchedulerJobs[0]?.generation).toBeUndefined();
    setActivePluginRegistry(old.registry);
    const dynamicCleanup = vi.fn();
    registerPluginSessionSchedulerJob({
      pluginId: "scheduler",
      ownerRegistry: old.registry,
      job: { id: "dynamic", sessionKey: "main", kind: "probe", cleanup: dynamicCleanup },
    });
    const originalGeneration = old.registry.sessionSchedulerJobs[0]?.generation;
    expect(originalGeneration).toEqual(expect.any(Number));

    const failed = builder();
    const failedCleanup = vi.fn();
    addPlugin(failed, "scheduler").api.registerSessionSchedulerJob({
      id: "static",
      sessionKey: "main",
      kind: "probe",
      cleanup: failedCleanup,
    });
    await cleanupPluginSessionSchedulerJobs({
      records: failed.registry.sessionSchedulerJobs,
      reason: "disable",
      cleanupOwnerRegistry: failed.registry,
    });
    expect(old.registry.sessionSchedulerJobs[0]?.generation).toBe(originalGeneration);
    expect(failedCleanup).not.toHaveBeenCalled();

    const next = builder();
    next.registry.plugins.push(retained.record);
    projectPluginContributions(old.registry, retained.record, next.registry);
    setActivePluginRegistry(next.registry);
    await waitForPluginRegistryRetirement(old.registry);
    expect(next.registry.sessionSchedulerJobs[0]?.generation).toBe(originalGeneration);
    expect(cleanup).not.toHaveBeenCalled();
    expect(dynamicCleanup).not.toHaveBeenCalled();
    retained.api.registerSessionSchedulerJob({
      id: "late",
      sessionKey: "main",
      kind: "probe",
      cleanup,
    });
    expect(
      next.registry.sessionSchedulerJobs.find((entry) => entry.job.id === "late")?.generation,
    ).toEqual(expect.any(Number));
    expect(old.registry.sessionSchedulerJobs.some((entry) => entry.job.id === "late")).toBe(false);
    await clearActivePluginRegistry();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(dynamicCleanup).toHaveBeenCalledOnce();
    await expect(
      cleanupPluginSessionSchedulerJobs({ pluginId: "scheduler", reason: "disable" }),
    ).resolves.toEqual([]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(dynamicCleanup).toHaveBeenCalledOnce();
  });

  it("retains deleted and updated scheduler jobs until their own cleanup", async () => {
    const previous = builder();
    const retained = addPlugin(previous, "scheduler-state");
    const deletedCleanup = vi.fn();
    const initialCleanup = vi.fn();
    const replacementCleanup = vi.fn();
    retained.api.registerSessionSchedulerJob({
      id: "deleted",
      sessionKey: "deleted-session",
      kind: "initial",
      cleanup: deletedCleanup,
    });
    retained.api.registerSessionSchedulerJob({
      id: "updated",
      sessionKey: "same-session",
      kind: "initial",
      cleanup: initialCleanup,
    });
    setActivePluginRegistry(previous.registry);
    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "scheduler-state",
        reason: "delete",
        sessionKey: "deleted-session",
      }),
    ).resolves.toEqual([]);
    expect(deletedCleanup).toHaveBeenCalledOnce();
    registerPluginSessionSchedulerJob({
      pluginId: "scheduler-state",
      ownerRegistry: previous.registry,
      job: {
        id: "updated",
        sessionKey: "same-session",
        kind: "replacement",
        cleanup: replacementCleanup,
      },
    });
    const next = builder();
    next.registry.plugins.push(retained.record);
    projectPluginContributions(previous.registry, retained.record, next.registry);
    setActivePluginRegistry(next.registry);
    await waitForPluginRegistryRetirement(previous.registry);
    expect(listPluginSessionSchedulerJobs("scheduler-state")).toEqual([
      {
        pluginId: "scheduler-state",
        id: "updated",
        sessionKey: "same-session",
        kind: "replacement",
      },
    ]);
    expect(initialCleanup).not.toHaveBeenCalled();
    expect(replacementCleanup).not.toHaveBeenCalled();
    await clearActivePluginRegistry();
    expect(deletedCleanup).toHaveBeenCalledOnce();
    expect(initialCleanup).toHaveBeenCalledOnce();
    expect(replacementCleanup).toHaveBeenCalledOnce();
    expect(listPluginSessionSchedulerJobs("scheduler-state")).toEqual([]);
  });

  it("preserves a replacement scheduler job registered while predecessor cleanup is pending", async () => {
    const previous = builder();
    addPlugin(previous, "scheduler");
    setActivePluginRegistry(previous.registry);
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const previousCleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    const job = { id: "shared-job", sessionKey: "main", kind: "probe" };
    registerPluginSessionSchedulerJob({
      pluginId: "scheduler",
      ownerRegistry: previous.registry,
      job: { ...job, cleanup: previousCleanup },
    });
    const next = builder();
    const replacement = addPlugin(next, "scheduler");
    const replacementCleanup = vi.fn();
    setActivePluginRegistry(next.registry);
    const retirement = waitForPluginRegistryRetirement(previous.registry);
    try {
      await Promise.race([
        cleanupStarted.promise,
        retirement.then(() => {
          throw new Error("Expected predecessor cleanup to remain pending");
        }),
      ]);
      const handle = replacement.api.registerSessionSchedulerJob({
        ...job,
        cleanup: replacementCleanup,
      });
      expect(handle).toEqual({ pluginId: "scheduler", ...job });
      finishCleanup.resolve();
      await retirement;
      expect(previousCleanup).toHaveBeenCalledOnce();
      expect(replacementCleanup).not.toHaveBeenCalled();
      expect(listPluginSessionSchedulerJobs("scheduler")).toEqual([handle]);

      await clearActivePluginRegistry();
      expect(replacementCleanup).toHaveBeenCalledOnce();
      expect(listPluginSessionSchedulerJobs("scheduler")).toEqual([]);
    } finally {
      finishCleanup.resolve();
      await retirement;
    }
  });
});

describe("concurrent Gateway registry owners", () => {
  function ownedRegistry(name: string) {
    const built = builder();
    const plugin = addPlugin(built, "shared-plugin");
    const cleanup = vi.fn();
    const disposed = vi.fn();
    plugin.api.registerRuntimeLifecycle({ id: "connection", cleanup });
    plugin.onDispose(disposed);
    const workspaceDir = `/workspace/gateway-${name}`;
    const mode: Parameters<typeof setActivePluginRegistry>[2] =
      name === "A" ? "explicit" : "gateway-bindable";
    return {
      name,
      built,
      plugin,
      cleanup,
      disposed,
      workspaceDir,
      mode,
      owner: createPluginRegistryOwner(built.registry, workspaceDir),
      callback: getPluginInstance(plugin.record)!.wrap(() => name),
    };
  }

  function publish(fixture: ReturnType<typeof ownedRegistry>) {
    setActivePluginRegistry(
      fixture.built.registry,
      `cache-${fixture.name}`,
      fixture.mode,
      fixture.workspaceDir,
    );
    fixture.owner.publish(fixture.built.registry);
    const epoch = capturePluginRegistryLifecycleEpoch(fixture.built.registry);
    const authority = capturePluginLifecycleAuthority(
      fixture.built.registry,
      fixture.plugin.record,
    );
    assert(epoch);
    assert(authority);
    return { ...fixture, epoch, authority, snapshot: captureActivePluginRegistrySnapshot() };
  }

  async function closeOwners(...owners: ReturnType<typeof createPluginRegistryOwner>[]) {
    const results = await Promise.allSettled(owners.map((owner) => owner.close()));
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  }

  it.each(["success", "failure"] as const)(
    "joins concurrent Gateway closes through cleanup %s",
    async (outcome) => {
      const fixture = ownedRegistry("A");
      const disposing = createDeferredCore();
      const release = createDeferredCore();
      fixture.plugin.onDispose(async () => {
        disposing.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("Gateway cleanup failed");
        }
      });
      publish(fixture);
      const first = fixture.owner.close();
      const second = fixture.owner.close();
      const joined = Promise.allSettled([first, second]);
      let repeatedCloseSettled = false;
      void second.then(
        () => {
          repeatedCloseSettled = true;
        },
        () => {
          repeatedCloseSettled = true;
        },
      );
      try {
        await disposing.promise;
        expect(repeatedCloseSettled).toBe(false);
        release.resolve();
        const results = await joined;
        expect(results.map((result) => result.status)).toEqual(
          outcome === "success" ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"],
        );
        if (results[0].status === "rejected" && results[1].status === "rejected") {
          expect(results[1].reason).toBe(results[0].reason);
        }
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.disposed).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await joined;
      }
    },
  );

  it.each([
    ["A", "B", "A"],
    ["A", "B", "B"],
    ["B", "A", "A"],
    ["B", "A", "B"],
  ] as const)(
    "publishes %s then %s and closes %s first without retiring the survivor",
    async (firstId, secondId, closeFirst) => {
      const beforeCreation = captureActivePluginRegistrySnapshot();
      const fixtures = { A: ownedRegistry("A"), B: ownedRegistry("B") };
      try {
        expect(captureActivePluginRegistrySnapshot()).toEqual(beforeCreation);
        const first = publish(fixtures[firstId]);
        const second = publish(fixtures[secondId]);
        await waitForPluginRegistryRetirement(first.built.registry);
        expect(first.callback()).toBe(first.name);
        expect(second.callback()).toBe(second.name);
        expect(first.authority()).toBe(true);
        expect(first.cleanup).not.toHaveBeenCalled();
        expect(second.cleanup).not.toHaveBeenCalled();

        const closing = closeFirst === firstId ? first : second;
        const survivor = closeFirst === firstId ? second : first;
        await closing.owner.close();
        expect(captureActivePluginRegistrySnapshot()).toEqual(survivor.snapshot);
        expect(capturePluginRegistryLifecycleEpoch(survivor.built.registry)).toBe(survivor.epoch);
        expect(survivor.authority()).toBe(true);
        expect(survivor.callback()).toBe(survivor.name);
        expect(closing.authority()).toBe(false);
        expect(closing.callback).toThrow("reloaded or disabled");
        expect(closing.cleanup).toHaveBeenCalledOnce();
        expect(closing.disposed).toHaveBeenCalledOnce();
        expect(survivor.cleanup).not.toHaveBeenCalled();
        expect(survivor.disposed).not.toHaveBeenCalled();

        await survivor.owner.close();
        expect(getActivePluginRegistry()).toBeNull();
        expect(survivor.authority()).toBe(false);
        expect(survivor.callback).toThrow("reloaded or disabled");
        expect(survivor.cleanup).toHaveBeenCalledOnce();
        expect(survivor.disposed).toHaveBeenCalledOnce();
        await closing.owner.close();
        expect(closing.cleanup).toHaveBeenCalledOnce();
        expect(closing.disposed).toHaveBeenCalledOnce();
      } finally {
        await closeOwners(fixtures.A.owner, fixtures.B.owner);
      }
    },
  );

  it("transfers a reloading owner's retained instances while another Gateway is selected", async () => {
    const a = ownedRegistry("A");
    const b = ownedRegistry("B");
    const replaced = addPlugin(a.built, "replaced");
    const replacedCleanup = vi.fn();
    replaced.api.registerRuntimeLifecycle({ id: "old-connection", cleanup: replacedCleanup });
    const oldCallback = getPluginInstance(replaced.record)!.wrap(() => "old");
    try {
      const publishedA = publish(a);
      const publishedB = publish(b);
      const candidate = builder();
      candidate.registry.plugins.push(a.plugin.record);
      projectPluginContributions(a.built.registry, a.plugin.record, candidate.registry);
      const replacement = addPlugin(candidate, "replaced");
      const replacementDisposed = vi.fn();
      replacement.onDispose(replacementDisposed);
      activatePluginRegistry(
        candidate.registry,
        "cache-A2",
        "gateway-bindable",
        a.workspaceDir,
        a.built.registry,
      );
      a.owner.publish(candidate.registry);
      await waitForPluginRegistryRetirement(a.built.registry);

      expect(a.owner.registry).toBe(candidate.registry);
      expect(getPluginRecordRegistry(a.built.registry, a.plugin.record)).toBe(candidate.registry);
      expect(publishedA.authority()).toBe(true);
      expect(a.callback()).toBe("A");
      expect(a.cleanup).not.toHaveBeenCalled();
      expect(replacedCleanup).toHaveBeenCalledOnce();
      expect(oldCallback).toThrow("reloaded or disabled");
      expect(publishedB.authority()).toBe(true);
      expect(b.callback()).toBe("B");
      expect(b.cleanup).not.toHaveBeenCalled();
      expect(capturePluginRegistryLifecycleEpoch(b.built.registry)).toBe(publishedB.epoch);

      await a.owner.close();
      expect(captureActivePluginRegistrySnapshot()).toEqual(publishedB.snapshot);
      expect(capturePluginRegistryLifecycleEpoch(b.built.registry)).toBe(publishedB.epoch);
      expect(b.callback()).toBe("B");
      expect(a.cleanup).toHaveBeenCalledOnce();
      expect(a.disposed).toHaveBeenCalledOnce();
      expect(replacementDisposed).toHaveBeenCalledOnce();
      expect(b.cleanup).not.toHaveBeenCalled();
    } finally {
      await closeOwners(a.owner, b.owner);
    }
  });

  it("restores both owners' exact authority after crossed-owner activation fails", async () => {
    const a = ownedRegistry("A");
    const b = ownedRegistry("B");
    const activation = vi.spyOn(contextEngineRegistry, "activateContextEngineRegistrations");
    try {
      const publishedA = publish(a);
      const publishedB = publish(b);
      initializeGlobalHookRunner(b.built.registry);
      const candidate = builder();
      candidate.registry.plugins.push(a.plugin.record);
      projectPluginContributions(a.built.registry, a.plugin.record, candidate.registry);
      const failed = addPlugin(candidate, "failed-candidate");
      const failedCleanup = vi.fn();
      const failedDisposed = vi.fn();
      failed.api.registerRuntimeLifecycle({ id: "connection", cleanup: failedCleanup });
      failed.onDispose(failedDisposed);
      const failedCallback = getPluginInstance(failed.record)!.wrap(() => "candidate");
      const failure = new Error("context engine activation failed");
      activation.mockImplementationOnce((registry) => {
        expect(registry).toBe(candidate.registry);
        expect(getActivePluginRegistry()).toBe(candidate.registry);
        expect(a.owner.registry).toBe(a.built.registry);
        expect(getPluginRecordRegistry(a.built.registry, a.plugin.record)).toBe(candidate.registry);
        expect(b.callback()).toBe("B");
        throw failure;
      });

      await expect(
        Promise.resolve().then(() =>
          activatePluginRegistry(
            candidate.registry,
            "cache-A2",
            "gateway-bindable",
            a.workspaceDir,
            a.built.registry,
          ),
        ),
      ).rejects.toBe(failure);
      await waitForPluginRegistryRetirement(candidate.registry);
      expect(a.owner.registry).toBe(a.built.registry);
      expect(getPluginRecordRegistry(a.built.registry, a.plugin.record)).toBe(a.built.registry);
      expect(captureActivePluginRegistrySnapshot()).toEqual(publishedB.snapshot);
      expect(getGlobalPluginRegistry()).toBe(b.built.registry);
      for (const published of [publishedA, publishedB]) {
        expect(capturePluginRegistryLifecycleEpoch(published.built.registry)).toBe(published.epoch);
        expect(published.authority()).toBe(true);
        expect(published.callback()).toBe(published.name);
        expect(published.cleanup).not.toHaveBeenCalled();
        expect(published.disposed).not.toHaveBeenCalled();
      }
      expect(failedCallback).toThrow("reloaded or disabled");
      expect(failedCleanup).toHaveBeenCalledOnce();
      expect(failedDisposed).toHaveBeenCalledOnce();
    } finally {
      activation.mockRestore();
      await closeOwners(a.owner, b.owner);
    }
  });
});

describe("registered generation cleanup", () => {
  it.each(["before initialization", "after retained cleanup"] as const)(
    "retires a later removal after registry restoration %s",
    async (timing) => {
      const first = builder();
      const { record, onDispose } = addPlugin(first, "retained-then-removed");
      const cleaned = vi.fn();
      onDispose(cleaned);
      const retained = builder();
      retained.registry.plugins.push(record);
      setActivePluginRegistry(first.registry);
      setActivePluginRegistry(retained.registry);
      if (timing === "after retained cleanup") {
        await waitForPluginRegistryRetirement(first.registry);
      }
      setActivePluginRegistry(first.registry);
      await waitForPluginRegistryRetirement(first.registry);
      await waitForPluginRegistryRetirement(retained.registry);
      expect(cleaned).not.toHaveBeenCalled();
      setActivePluginRegistry(builder().registry);
      await waitForPluginRegistryRetirement(first.registry);
      expect(cleaned).toHaveBeenCalledOnce();
      expect(getPluginInstance(record)!.wrap(() => "stale")).toThrow("reloaded or disabled");
    },
  );

  it("preserves separate legacy hook budgets before final resource disposal", async () => {
    vi.useFakeTimers();
    const previous = builder();
    const { record, api, onDispose } = addPlugin(previous, "bounded-cleanup");
    const instance = getPluginInstance(record)!;
    const events: string[] = [];
    const step = async (name: string) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 4_000);
      });
      events.push(name);
    };
    api.registerRuntimeLifecycle({ id: "first", cleanup: () => step("first") });
    api.registerRuntimeLifecycle({ id: "second", cleanup: () => step("second") });
    onDispose(() => step("disposed"));
    const next = builder();
    addPlugin(next, "bounded-cleanup");
    try {
      const cleanup = createPluginHostRegistryRetirement({
        cfg: {},
        previousRegistry: previous.registry,
        nextRegistry: next.registry,
      })();
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(cleanup).resolves.toEqual({ cleanupCount: 2, failures: [] });
      expect(events).toEqual(["first", "second", "disposed"]);
    } finally {
      const disposal = instance.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await disposal.catch(() => {});
      await getPluginInstance(next.registry.plugins[0]!)!.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["restart", "disable"] as const)(
    "finishes an admitted receipt before legacy %s cleanup and final disposal",
    async (reason) => {
      const previous = builder();
      const { record, api, onDispose } = addPlugin(previous, "connection");
      const instance = getPluginInstance(record)!;
      // SAFETY: These managed facades preserve Node's public timer signatures.
      const callbackTimers = instance.loadBuiltin(
        "node:timers",
        createRequire(import.meta.url),
      ) as typeof import("node:timers");
      const timers = instance.loadBuiltin(
        "node:timers/promises",
        createRequire(import.meta.url),
      ) as typeof import("node:timers/promises");
      const events: string[] = [];
      let connectionOpen = true;
      const receipt = instance.wrap(() => {
        expect(connectionOpen).toBe(true);
        return "receipt";
      });
      api.registerSessionExtension({
        namespace: "connection",
        description: "Owns a test connection",
        async cleanup(context) {
          await new Promise<void>((resolve) => {
            callbackTimers.setImmediate(() => resolve());
          });
          expect(receipt()).toBe("receipt");
          events.push(`session:${context.reason}`);
        },
      });
      api.registerRuntimeLifecycle({
        id: "connection",
        async cleanup(context) {
          await new Promise<void>((resolve) => {
            callbackTimers.setTimeout(() => resolve(), 1);
          });
          await timers.setTimeout(1);
          connectionOpen = false;
          events.push(`runtime:${context.reason}`);
        },
      });
      onDispose(() => {
        events.push("disposed");
      });
      setActivePluginRegistry(previous.registry);
      const next = builder();
      if (reason === "restart") {
        addPlugin(next, "connection");
      }
      try {
        await instance.wrap(async () => {
          setActivePluginRegistry(next.registry);
          await waitForPluginRegistryRetirement(previous.registry);
          events.push("published");
          events.push(receipt());
        })();
        expect(events).toEqual([
          "published",
          "receipt",
          `session:${reason}`,
          `runtime:${reason}`,
          "disposed",
        ]);
        expect(receipt).toThrow("reloaded or disabled");
      } finally {
        await instance.dispose().catch(() => {});
      }
    },
  );

  it("lets external retirement waiters join cleanup after the invoking call's acknowledgment", async () => {
    const previous = builder();
    const { record, api } = addPlugin(previous, "self");
    const instance = getPluginInstance(record)!;
    const acknowledged = createDeferredCore();
    const finishReceipt = createDeferredCore();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    let selfAcknowledged = false;
    let externalSettled = false;
    api.registerRuntimeLifecycle({
      id: "connection",
      async cleanup() {
        cleanupStarted.resolve();
        await finishCleanup.promise;
      },
    });
    setActivePluginRegistry(previous.registry);
    const call = instance.wrap(async () => {
      setActivePluginRegistry(builder().registry);
      await waitForPluginRegistryRetirement(previous.registry);
      selfAcknowledged = true;
      acknowledged.resolve();
      await finishReceipt.promise;
      return "receipt";
    })();
    let external: Promise<void> | undefined;
    try {
      await Promise.race([
        acknowledged.promise,
        cleanupStarted.promise.then(() => {
          expect(selfAcknowledged).toBe(true);
        }),
      ]);
      external = waitForPluginRegistryRetirement(previous.registry).then(() => {
        externalSettled = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(externalSettled).toBe(false);
      finishReceipt.resolve();
      await cleanupStarted.promise;
      expect(externalSettled).toBe(false);
      finishCleanup.resolve();
      await expect(call).resolves.toBe("receipt");
      await external;
      expect(externalSettled).toBe(true);
    } finally {
      finishReceipt.resolve();
      finishCleanup.resolve();
      await Promise.allSettled([call, external, instance.dispose()]);
    }
  });

  it("preserves the invoking failure while observing failed cleanup and completing sibling hooks", async () => {
    const previous = builder();
    const { record, api, onDispose } = addPlugin(previous, "failed-call");
    const instance = getPluginInstance(record)!;
    const callFailure = new Error("receipt failed");
    const cleanupFailure = new Error("legacy cleanup failed");
    const sibling = vi.fn();
    const disposed = vi.fn();
    api.registerRuntimeLifecycle({
      id: "fails",
      cleanup() {
        throw cleanupFailure;
      },
    });
    api.registerRuntimeLifecycle({ id: "sibling", cleanup: sibling });
    onDispose(disposed);
    setActivePluginRegistry(previous.registry);
    const call = instance.wrap(async () => {
      setActivePluginRegistry(builder().registry);
      await waitForPluginRegistryRetirement(previous.registry);
      throw callFailure;
    })();
    try {
      await expect(call).rejects.toBe(callFailure);
      await expect(waitForPluginRegistryRetirement(previous.registry)).rejects.toThrow(
        "Plugin host cleanup failed",
      );
      expect(sibling).toHaveBeenCalledOnce();
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      await instance.dispose().catch(() => {});
    }
  });

  it("preserves structured host failures while disposing partial records and final resources", async () => {
    const previous = builder();
    const { record, api, onDispose } = addPlugin(previous, "failed-hook");
    const partial = addPlugin(previous, "partial");
    partial.record.status = "error";
    const failure = new Error("legacy failure");
    const cleaned = vi.fn();
    const partialDisposed = vi.fn();
    api.registerRuntimeLifecycle({
      id: "failed",
      cleanup() {
        throw failure;
      },
    });
    onDispose(cleaned);
    partial.onDispose(partialDisposed);
    try {
      const result = await createPluginHostRegistryRetirement({
        cfg: {},
        previousRegistry: previous.registry,
        nextRegistry: builder().registry,
      })();
      expect(result.failures).toContainEqual({
        pluginId: "failed-hook",
        hookId: "runtime:failed",
        error: failure,
      });
      expect(cleaned).toHaveBeenCalledOnce();
      expect(partialDisposed).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([
        getPluginInstance(record)!.dispose(),
        getPluginInstance(partial.record)!.dispose(),
      ]);
    }
  });

  it.each(["reset", "delete"] as const)(
    "runs %s cleanup without retiring the instance",
    async (reason) => {
      const owner = builder();
      const { record, api } = addPlugin(owner, "session");
      const cleanup = vi.fn();
      api.registerRuntimeLifecycle({ id: "session", cleanup });
      setActivePluginRegistry(owner.registry);
      const result = await runPluginHostCleanup({
        registry: owner.registry,
        reason,
        sessionKey: "main",
        skipPersistentSessionState: true,
      });
      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      expect(cleanup).toHaveBeenCalledWith({ reason, sessionKey: "main", runId: undefined });
      expect(getPluginInstance(record)!.wrap(() => "still active")()).toBe("still active");
    },
  );

  it("releases a failed candidate's legacy resources while retaining committed ownership and run context", async () => {
    const previous = builder();
    const retained = addPlugin(previous, "retained");
    const retainedCleanup = vi.fn();
    retained.api.registerRuntimeLifecycle({ id: "retained", cleanup: retainedCleanup });
    setActivePluginRegistry(previous.registry);
    const before = captureActivePluginRegistrySnapshot();
    const candidate = builder();
    candidate.registry.plugins.push(retained.record);
    projectPluginContributions(previous.registry, retained.record, candidate.registry);
    const failed = addPlugin(candidate, "failed");
    const failedCleanup = vi.fn();
    const disposed = vi.fn();
    failed.api.registerRuntimeLifecycle({ id: "connection", cleanup: failedCleanup });
    failed.onDispose(disposed);
    const runContext = { runId: "surviving-run", namespace: "probe" };
    setPluginRunContext({
      pluginId: "failed",
      patch: { ...runContext, value: "committed context" },
    });
    stageActivePluginRegistry(candidate.registry, null, "default");
    rollbackStagedPluginRegistry(before);
    await waitForPluginRegistryRetirement(candidate.registry);
    expect(failedCleanup).toHaveBeenCalledExactlyOnceWith({
      reason: "restart",
      sessionKey: undefined,
      runId: undefined,
    });
    expect(disposed).toHaveBeenCalledOnce();
    expect(retainedCleanup).not.toHaveBeenCalled();
    expect(getPluginRunContext({ pluginId: "failed", get: runContext })).toBe("committed context");
    expect(getPluginInstance(retained.record)!.wrap(() => "retained")()).toBe("retained");
  });
});
