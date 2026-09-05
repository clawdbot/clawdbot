import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createOpenShellBackendSandboxConfig } from "./src/openshell.test-support.js";

function readBackend() {
  return {
    factory: getSandboxBackendFactory("openshell"),
    manager: getSandboxBackendManager("openshell"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("openshell"),
  };
}

const workdirParams: CreateSandboxBackendParams = {
  sessionKey: "agent:openshell-lifecycle:main",
  scopeKey: "agent:openshell-lifecycle:main",
  workspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  agentWorkspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  cfg: createOpenShellBackendSandboxConfig(),
};

describe("OpenShell plugin registration lifecycle", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
  });

  function registerGeneration(remoteWorkspaceDir: string) {
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    const api = createTestPluginApi({
      id: "openshell",
      pluginConfig: { remoteWorkspaceDir },
      registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    });
    plugin.register(api);
    const cleanup = async (
      context: Parameters<NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>>[0],
    ) => {
      for (const lifecycle of lifecycles.toReversed()) {
        await lifecycle.cleanup?.(context);
      }
    };
    const stop = () => cleanup({ reason: "disable" });
    stops.push(stop);
    return { backend: readBackend(), cleanup, stop };
  }

  it.each(["disable", "restart"] as const)(
    "restores eager backend hooks on global %s",
    async (reason) => {
      const original = readBackend();
      for (const remoteWorkspaceDir of ["/sandbox/first", "/sandbox/second", "/agent/third"]) {
        const generation = registerGeneration(remoteWorkspaceDir);
        expect(generation.backend.factory).toEqual(expect.any(Function));
        expect(generation.backend.manager).toEqual({
          describeRuntime: expect.any(Function),
          removeRuntime: expect.any(Function),
        });
        expect(generation.backend.resolveWorkdir?.(workdirParams)).toBe(remoteWorkspaceDir);

        await generation.cleanup({ reason });
        expect(readBackend()).toEqual(original);
        await generation.stop();
        expect(readBackend()).toEqual(original);
      }
    },
  );

  it.each(["disable", "restart", "reset", "delete"] as const)(
    "preserves global backend hooks during scoped %s cleanup",
    async (reason) => {
      const generation = registerGeneration("/sandbox/scoped");
      for (const scope of [
        { sessionKey: "agent:other:main" },
        { runId: "other-run" },
        { sessionKey: "" },
        { runId: "" },
      ]) {
        await generation.cleanup({ reason, ...scope });
        expect(readBackend()).toEqual(generation.backend);
      }
      if (reason === "reset" || reason === "delete") {
        await generation.cleanup({ reason });
        expect(readBackend()).toEqual(generation.backend);
      }
    },
  );

  it.each(["older-first", "newer-first"] as const)(
    "preserves the live backend when plugin generations stop %s",
    async (order) => {
      const original = readBackend();
      const older = registerGeneration("/sandbox/older");
      const newer = registerGeneration("/sandbox/newer");
      expect(readBackend()).toEqual(newer.backend);

      const first = order === "older-first" ? older : newer;
      const last = order === "older-first" ? newer : older;
      await first.stop();
      expect(readBackend()).toEqual(last.backend);
      await last.stop();
      expect(readBackend()).toEqual(original);
      await first.stop();
      expect(readBackend()).toEqual(original);
    },
  );

  it.each([
    "discovery",
    "tool-discovery",
    "setup-only",
    "setup-runtime",
    "cli-metadata",
  ] satisfies OpenClawPluginApi["registrationMode"][])(
    "does not register runtime hooks or services in %s mode",
    (registrationMode) => {
      const original = readBackend();
      const services: OpenClawPluginService[] = [];
      const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
      plugin.register(
        createTestPluginApi({
          registrationMode,
          pluginConfig: { remoteWorkspaceDir: "/outside-managed-roots" },
          registerService: (service) => services.push(service),
          registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
        }),
      );
      expect(services).toEqual([]);
      expect(lifecycles).toEqual([]);
      expect(readBackend()).toEqual(original);
    },
  );

  it("retires a registered backend even when no plugin services ever start", async () => {
    const originalBackend = readBackend();
    const originalRegistry = getActivePluginRegistry();
    const { registry } = createPluginRegistryFixture();
    const record = createPluginRecord({ id: "openshell" });
    registry.registry.plugins.push(record);
    plugin.register(
      registry.createApi(record, {
        config: {},
        pluginConfig: { remoteWorkspaceDir: "/sandbox/unstarted" },
      }),
    );
    setActivePluginRegistry(registry.registry);
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      expect(readBackend().resolveWorkdir?.(workdirParams)).toBe("/sandbox/unstarted");
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect.poll(readBackend).toEqual(originalBackend);
    } finally {
      setActivePluginRegistry(originalRegistry ?? createEmptyPluginRegistry());
      try {
        await expect.poll(readBackend).toEqual(originalBackend);
      } finally {
        if (!originalRegistry) {
          resetPluginRuntimeStateForTest();
        }
      }
    }
  });
});
