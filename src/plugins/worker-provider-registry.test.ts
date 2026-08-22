/** Covers cloud-worker provider manifest ownership, uniqueness, and lookup ordering. */
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { WorkerProvider } from "./types.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "./worker-provider-manifest.js";

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

  it("rejects a non-function optional machine-options hook", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      listMachineOptions: ["standard"],
    } as unknown as WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "worker provider registration listMachineOptions must be a function",
      }),
    );
  });

  it("rejects a non-boolean provision-before-installation declaration", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      provisionBeforeInstallation: "sometimes",
    } as unknown as WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "worker provider registration provisionBeforeInstallation must be a boolean",
      }),
    );
  });

  it("registers both placement modes in canonical order", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      supportedExecutionModes: ["worker-turn", "remote-exec"],
    } satisfies WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.get("static-ssh")?.provider).toBe(provider);
    expect(pluginRegistry.registry.diagnostics).toEqual([]);
  });

  it.each([
    { modes: [], label: "no modes" },
    { modes: ["remote-exec", "worker-turn"], label: "modes in noncanonical order" },
    { modes: ["worker-turn", "worker-turn"], label: "duplicate worker-turn modes" },
    { modes: ["remote-exec", "remote-exec"], label: "duplicate remote-exec modes" },
    { modes: ["unsupported"], label: "an unknown mode" },
    { modes: ["worker-turn", "unsupported"], label: "an unknown additional mode" },
    {
      modes: ["worker-turn", "remote-exec", "worker-turn"],
      label: "more than two modes",
    },
  ])("rejects $label in a placement declaration", ({ modes }) => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      supportedExecutionModes: modes,
    } as unknown as WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("worker provider registration supportedExecutionModes"),
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
