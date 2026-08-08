import { describe, expect, it } from "vitest";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";

const DOCTOR_CONTRACT_SURFACES = [
  "configRepair",
  "resolveSessionStoreAgentIds",
  "sessionRouteStateOwners",
  "stateMigrations",
] as const satisfies readonly (keyof PluginManifestDoctorContract)[];

describe("bundled plugin doctor contract declarations", () => {
  it("matches every resolvable artifact's coerced doctor surfaces", () => {
    const moduleLoaders = createPluginModuleLoaderCache();
    const mismatches: string[] = [];

    for (const record of loadBundledPluginManifestRegistry().plugins) {
      const artifactPath = resolvePluginDoctorContractArtifactPath(record.rootDir);
      if (!artifactPath) {
        continue;
      }
      const declaration = record.doctorContract;
      if (!declaration) {
        mismatches.push(`${record.id}: missing doctorContract declaration`);
        continue;
      }
      const mod = getCachedPluginModuleLoader({
        cache: moduleLoaders,
        modulePath: artifactPath,
        importerUrl: import.meta.url,
      })(artifactPath) as Parameters<typeof coercePluginDoctorContractModule>[0];
      const { summary } = coercePluginDoctorContractModule(mod);
      for (const surface of DOCTOR_CONTRACT_SURFACES) {
        if (surface === "sessionRouteStateOwners" && record.sessionRouteStateOwners !== undefined) {
          if (summary.sessionRouteStateOwners) {
            mismatches.push(`${record.id}: bundled owner metadata must use the manifest`);
          }
          continue;
        }
        const declared = declaration[surface] === true;
        if (declared !== summary[surface]) {
          mismatches.push(
            `${record.id}:${surface} declared=${String(declared)} actual=${String(summary[surface])}`,
          );
        }
      }
    }

    expect(mismatches).toStrictEqual([]);
  }, 600_000);
});
