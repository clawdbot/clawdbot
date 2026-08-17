import { describe, expect, it, vi } from "vitest";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";

const DOCTOR_CONTRACT_SURFACES = [
  "configRepair",
  "resolveSessionStoreAgentIds",
  "sessionRouteStateOwners",
  "stateMigrations",
] as const satisfies readonly (keyof PluginManifestDoctorContract)[];

describe("bundled plugin doctor contract declarations", () => {
  it("matches every resolvable artifact's coerced doctor surfaces", async () => {
    const mismatches = (
      await Promise.all(
        loadBundledPluginManifestRegistry().plugins.map(async (record) => {
          const pluginMismatches: string[] = [];
          const artifactPath = resolvePluginDoctorContractArtifactPath(record.rootDir);
          if (!artifactPath) {
            return pluginMismatches;
          }
          const declaration = record.doctorContract;
          if (!declaration) {
            pluginMismatches.push(`${record.id}: missing doctorContract declaration`);
            return pluginMismatches;
          }
          // This test owns declaration parity, not plugin-loader behavior. Let
          // Vitest transform each real artifact once instead of creating a Jiti
          // loader per plugin; dedicated loader tests cover production loading.
          const mod = (await vi.importActual(artifactPath)) as Parameters<
            typeof coercePluginDoctorContractModule
          >[0];
          const { summary } = coercePluginDoctorContractModule(mod);
          for (const surface of DOCTOR_CONTRACT_SURFACES) {
            if (
              surface === "sessionRouteStateOwners" &&
              record.sessionRouteStateOwners !== undefined
            ) {
              if (summary.sessionRouteStateOwners) {
                pluginMismatches.push(`${record.id}: bundled owner metadata must use the manifest`);
              }
              continue;
            }
            const declared = declaration[surface] === true;
            if (declared !== summary[surface]) {
              pluginMismatches.push(
                `${record.id}:${surface} declared=${String(declared)} actual=${String(summary[surface])}`,
              );
            }
          }
          return pluginMismatches;
        }),
      )
    ).flat();

    expect(mismatches).toStrictEqual([]);
  }, 600_000);
});
