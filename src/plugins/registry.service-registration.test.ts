import { afterEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";
import { startPluginServices } from "./services.js";

const registries: ReturnType<typeof createPluginRegistry>["registry"][] = [];

afterEach(async () => {
  await clearActivePluginRegistry();
  for (const registry of registries.splice(0)) {
    await disposePluginRegistryInstances(registry);
  }
});

class ClassBackedLifecycleService {
  starts = 0;
  advertisements = 0;

  constructor(readonly id: string) {}

  start() {
    this.starts += 1;
  }

  advertise() {
    this.advertisements += 1;
  }
}

function createRegistrationFixture() {
  const builder = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  registries.push(builder.registry);
  const createRecord = (id: string) => {
    const record = createPluginRecord({
      id,
      source: `/plugins/${id}/index.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    builder.registry.plugins.push(record);
    return record;
  };
  return { builder, createRecord };
}

describe("plugin service registration identity", () => {
  it.each([
    { surface: "service", id: "" },
    { surface: "service", id: "   " },
    { surface: "service", id: "\t\n" },
    { surface: "discovery", id: "" },
    { surface: "discovery", id: "   " },
    { surface: "discovery", id: "\t\n" },
  ] as const)("reports a blank $surface service id ($id)", async ({ surface, id }) => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("invalid-service-owner");
    const api = builder.createApi(record, { config: {} });
    const service = new ClassBackedLifecycleService(id);

    if (surface === "service") {
      api.registerService(service);
    } else {
      api.registerGatewayDiscoveryService(service);
    }

    const registrations =
      surface === "service" ? builder.registry.services : builder.registry.gatewayDiscoveryServices;
    const recordIds = surface === "service" ? record.services : record.gatewayDiscoveryServiceIds;
    expect(registrations).toEqual([]);
    expect(recordIds).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          surface === "service"
            ? "service registration missing id"
            : "gateway discovery service registration missing id",
      },
    ]);

    if (surface === "service") {
      const handle = await startPluginServices({ registry: builder.registry, config: {} });
      expect(service.starts).toBe(0);
      await handle.stop();
    } else {
      expect(service.advertisements).toBe(0);
    }
  });

  it.each([
    { surface: "service", sameOwner: false, paddedFirst: true },
    { surface: "service", sameOwner: false, paddedFirst: false },
    { surface: "service", sameOwner: true, paddedFirst: true },
    { surface: "service", sameOwner: true, paddedFirst: false },
    { surface: "discovery", sameOwner: false, paddedFirst: true },
    { surface: "discovery", sameOwner: false, paddedFirst: false },
    { surface: "discovery", sameOwner: true, paddedFirst: true },
    { surface: "discovery", sameOwner: true, paddedFirst: false },
  ] as const)(
    "deduplicates $surface registrations (same owner: $sameOwner, padded first: $paddedFirst)",
    async ({ surface, sameOwner, paddedFirst }) => {
      const { builder, createRecord } = createRegistrationFixture();
      const firstRecord = createRecord("first-owner");
      const secondRecord = sameOwner ? firstRecord : createRecord("second-owner");
      const firstApi = builder.createApi(firstRecord, { config: {} });
      const secondApi = builder.createApi(secondRecord, { config: {} });
      const firstService = new ClassBackedLifecycleService(
        paddedFirst ? " shared-service " : "shared-service",
      );
      const secondService = new ClassBackedLifecycleService(
        paddedFirst ? "shared-service" : " shared-service ",
      );

      if (surface === "service") {
        firstApi.registerService(firstService);
        secondApi.registerService(secondService);
      } else {
        firstApi.registerGatewayDiscoveryService(firstService);
        secondApi.registerGatewayDiscoveryService(secondService);
      }

      const registrations =
        surface === "service"
          ? builder.registry.services
          : builder.registry.gatewayDiscoveryServices;
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        pluginId: firstRecord.id,
        source: firstRecord.source,
        service: { id: firstService.id },
      });
      expect(registrations[0]?.service).toBeInstanceOf(ClassBackedLifecycleService);

      const recordIds =
        surface === "service" ? firstRecord.services : firstRecord.gatewayDiscoveryServiceIds;
      expect(recordIds).toEqual(["shared-service"]);

      if (sameOwner) {
        expect(builder.registry.diagnostics).toEqual([]);
      } else {
        expect(builder.registry.diagnostics).toEqual([
          expect.objectContaining({
            pluginId: "second-owner",
            message:
              surface === "service"
                ? "service already registered: shared-service (first-owner)"
                : "gateway discovery service already registered: shared-service (first-owner)",
          }),
        ]);
        expect(
          surface === "service" ? secondRecord.services : secondRecord.gatewayDiscoveryServiceIds,
        ).toEqual([]);
      }

      setActivePluginRegistry(builder.registry);
      if (surface === "service") {
        const handle = await startPluginServices({ registry: builder.registry, config: {} });
        try {
          expect(firstService.starts).toBe(1);
          expect(secondService.starts).toBe(0);
        } finally {
          await handle.stop();
        }
      } else {
        await builder.registry.gatewayDiscoveryServices[0]!.service.advertise({
          machineDisplayName: "fixture",
          gatewayPort: 18789,
          gatewayTlsEnabled: false,
          gatewayDirectReachable: true,
          minimal: true,
        });
        expect(firstService.advertisements).toBe(1);
        expect(secondService.advertisements).toBe(0);
      }
    },
  );
});
