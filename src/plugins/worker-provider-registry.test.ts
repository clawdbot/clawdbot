/** Covers cloud-worker provider manifest ownership, uniqueness, and lookup ordering. */
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { WorkerProvider } from "./types.js";
import {
  listWorkerProviderRegistrations,
  resolveDurableWorkerProviderAutoEnabledReasons,
  resolveWorkerProvider,
} from "./worker-provider-registry.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createWorkerProvider(id: string): WorkerProvider {
  return {
    id,
    provision: async () => {
      throw new Error("not called");
    },
    inspect: async () => ({ status: "unknown" }),
    destroy: async () => {},
  };
}

function createOwner(id: string, workerProviders: string[] = []) {
  return createPluginRecord({
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    contracts: { workerProviders },
    configSchema: false,
  });
}

describe("worker provider registry", () => {
  it("registers providers declared by the plugin manifest", () => {
    const pluginRegistry = createTestRegistry();
    const provider = createWorkerProvider("static-ssh");

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(listWorkerProviderRegistrations(pluginRegistry.registry)).toEqual([
      expect.objectContaining({ pluginId: "owner", provider }),
    ]);
  });

  it("rejects registrations missing manifest ownership", () => {
    const pluginRegistry = createTestRegistry();

    pluginRegistry.registerWorkerProvider(createOwner("owner"), createWorkerProvider("static-ssh"));

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "owner",
        message: "plugin must declare contracts.workerProviders for provider: static-ssh",
      }),
    );
  });

  it("rejects incomplete provider contracts", () => {
    const pluginRegistry = createTestRegistry();
    const provider = createWorkerProvider("static-ssh");
    delete (provider as Partial<WorkerProvider>).inspect;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({ message: "worker provider registration missing method: inspect" }),
    );
  });

  it("rejects a non-function optional renew hook", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      renew: "later",
    } as unknown as WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "worker provider registration renew must be a function",
      }),
    );
  });

  it("rejects a non-function optional SSH identity resolver", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      resolveSshIdentity: "later",
    } as unknown as WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "worker provider registration resolveSshIdentity must be a function",
      }),
    );
  });

  it("rejects invalid provider ids", () => {
    const pluginRegistry = createTestRegistry();

    pluginRegistry.registerWorkerProvider(
      createOwner("owner", ["__proto__"]),
      createWorkerProvider("__proto__"),
    );

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "owner",
        message: "worker provider registration missing valid id",
      }),
    );
  });

  it("rejects normalized duplicate provider ids", () => {
    const pluginRegistry = createTestRegistry();
    pluginRegistry.registerWorkerProvider(
      createOwner("first", ["static-ssh"]),
      createWorkerProvider("Static-SSH"),
    );

    pluginRegistry.registerWorkerProvider(
      createOwner("second", ["static-ssh"]),
      createWorkerProvider(" static-ssh "),
    );

    expect(pluginRegistry.registry.workerProviders.size).toBe(1);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second",
        message: "worker provider already registered: static-ssh (first)",
      }),
    );
  });

  it("lists deterministically and resolves normalized provider ids", () => {
    const registry = createEmptyPluginRegistry();
    const alphaA = createWorkerProvider("alpha");
    const beta = createWorkerProvider("beta");
    registry.workerProviders.set("beta", { pluginId: "b-owner", provider: beta, source: "b" });
    registry.workerProviders.set("alpha", {
      pluginId: "a-owner",
      provider: alphaA,
      source: "a",
    });

    expect(
      listWorkerProviderRegistrations(registry).map((entry) => [entry.provider.id, entry.pluginId]),
    ).toEqual([
      ["alpha", "a-owner"],
      ["beta", "b-owner"],
    ]);
    expect(resolveWorkerProvider(registry, " ALPHA ")).toBe(alphaA);
    expect(resolveWorkerProvider(registry, "__proto__")).toBeUndefined();
  });

  it("auto-enables only bundled owners needed by durable leases", () => {
    const reasons = resolveDurableWorkerProviderAutoEnabledReasons(
      {
        plugins: [
          {
            id: "qa-lab",
            origin: "bundled",
            contracts: { workerProviders: ["other", "static-ssh"] },
          },
          {
            id: "external-workers",
            origin: "global",
            contracts: { workerProviders: ["cloud-vendor"] },
          },
        ],
        diagnostics: [],
      } as never,
      [" STATIC-SSH ", "cloud-vendor"],
    );

    expect(reasons).toEqual({ "qa-lab": ["static-ssh durable worker lease"] });
  });
});
