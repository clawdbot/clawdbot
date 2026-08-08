import { describe, expect, it } from "vitest";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { summarizePluginDoctorContractModule } from "./doctor-contract-registry.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";

const DOCTOR_CONTRACT_SURFACES = [
  "legacyConfigRules",
  "normalizeCompatibilityConfig",
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
      const declaration = record.manifest?.doctorContract;
      if (!declaration) {
        mismatches.push(`${record.id}: missing doctorContract declaration`);
        continue;
      }
      const mod = getCachedPluginModuleLoader({
        cache: moduleLoaders,
        modulePath: artifactPath,
        importerUrl: import.meta.url,
      })(artifactPath) as Parameters<typeof summarizePluginDoctorContractModule>[0];
      const summary = summarizePluginDoctorContractModule(mod);
      for (const surface of DOCTOR_CONTRACT_SURFACES) {
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
