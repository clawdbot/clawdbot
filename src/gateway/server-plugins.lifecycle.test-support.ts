import { afterEach, beforeEach, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  INSTANCE_BINDING_PROBE_METHOD,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";

export function installInstanceBindingConfigIo() {
  const configIoRestorers: Array<{ mockRestore: () => void }> = [];

  beforeEach(async () => {
    const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const facades = await Promise.all([import("../config/io.js"), import("../config/config.js")]);
    // Cached mutation importers retain the shared mocks; delegate those same exports to real IO
    // so config receipts, preflight, source snapshots, and runtime defaults keep their real owner.
    for (const facade of facades) {
      configIoRestorers.push(
        vi.spyOn(facade, "createConfigIO").mockImplementation(actualIo.createConfigIO),
        vi.spyOn(facade, "getRuntimeConfig").mockImplementation(actualIo.getRuntimeConfig),
        vi
          .spyOn(facade, "readConfigFileSnapshot")
          .mockImplementation(actualIo.readConfigFileSnapshot),
        vi
          .spyOn(facade, "readConfigFileSnapshotWithPluginMetadata")
          .mockImplementation(actualIo.readConfigFileSnapshotWithPluginMetadata),
        vi
          .spyOn(facade, "readConfigFileSnapshotForWrite")
          .mockImplementation(actualIo.readConfigFileSnapshotForWrite),
        vi.spyOn(facade, "writeConfigFile").mockImplementation(actualIo.writeConfigFile),
      );
    }
  });

  afterEach(() => {
    for (const restore of configIoRestorers.splice(0)) {
      restore.mockRestore();
    }
  });
}

export async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

export function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}
