import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";

const writePersistedInstalledPluginIndexWithLeaseSync = vi.hoisted(() => vi.fn());

vi.mock("../plugins/installed-plugin-index-store-write.js", () => ({
  writePersistedInstalledPluginIndexWithLeaseSync,
}));

const { persistRefreshedPluginIndex } = await import("./doctor-config-preflight-plugin-index.js");

function snapshotRead(
  metadata: Pick<
    PluginMetadataSnapshot,
    "index" | "registryIndex" | "registryDiagnostics" | "registrySource"
  >,
): DoctorConfigPreflightPluginSnapshotRead {
  return {
    snapshot: {} as ConfigFileSnapshot,
    pluginMigrationFingerprint: "plugin-migrations",
    pluginMetadataSnapshot: metadata as PluginMetadataSnapshot,
  };
}

const measure = async <T>(_name: string, run: () => T | Promise<T>): Promise<T> => await run();

describe("persistRefreshedPluginIndex", () => {
  beforeEach(() => {
    writePersistedInstalledPluginIndexWithLeaseSync.mockReset();
  });

  it("reports selector diagnostics when the durable reread is rejected", async () => {
    const index = {} as PluginMetadataSnapshot["index"];
    const registryIndex = { plugins: [] } as PluginMetadataSnapshot["index"];
    const lease = {} as StartupMigrationLease;
    const env = { OPENCLAW_STATE_DIR: "test-state" };

    await expect(
      persistRefreshedPluginIndex({
        env,
        lease,
        measure,
        readPersistedSnapshot: async () =>
          snapshotRead({
            index,
            registryIndex,
            registryDiagnostics: [
              {
                level: "warn",
                code: "persisted-registry-stale-source",
                message: "stale",
              },
            ],
            registrySource: "derived",
          }),
        snapshotRead: snapshotRead({
          index,
          registryIndex,
          registryDiagnostics: [],
          registrySource: "derived",
        }),
      }),
    ).rejects.toThrow("reread source was derived; diagnostics: persisted-registry-stale-source");

    expect(writePersistedInstalledPluginIndexWithLeaseSync).toHaveBeenCalledWith(registryIndex, {
      env,
      lease,
    });
  });
});
