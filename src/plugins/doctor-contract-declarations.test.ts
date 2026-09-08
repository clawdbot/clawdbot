import path from "node:path";
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

const sourceManifestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
};

describe("bundled plugin doctor contract declarations", () => {
  it("matches every resolvable artifact's coerced doctor surfaces", async () => {
    const mismatches = (
      await Promise.all(
        loadBundledPluginManifestRegistry({ env: sourceManifestEnv }).plugins.map(
          async (record) => {
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
                  pluginMismatches.push(
                    `${record.id}: bundled owner metadata must use the manifest`,
                  );
                }
                continue;
              }
              const value = declaration[surface];
              const declared =
                value === true || (surface === "stateMigrations" && Array.isArray(value));
              if (declared !== summary[surface]) {
                pluginMismatches.push(
                  `${record.id}:${surface} declared=${String(declared)} actual=${String(summary[surface])}`,
                );
              }
            }
            return pluginMismatches;
          },
        ),
      )
    ).flat();

    expect(mismatches).toStrictEqual([]);
  }, 600_000);

  it("declares every state migration identity and phase in module order", async () => {
    const mismatches = (
      await Promise.all(
        loadBundledPluginManifestRegistry({ env: sourceManifestEnv }).plugins.map(
          async (record) => {
            const declaration = record.doctorContract?.stateMigrations;
            if (!Array.isArray(declaration)) {
              return [];
            }
            const artifactPath = resolvePluginDoctorContractArtifactPath(record.rootDir);
            if (!artifactPath) {
              return [`${record.id}: missing Doctor contract artifact`];
            }
            const mod = (await vi.importActual(artifactPath)) as Parameters<
              typeof coercePluginDoctorContractModule
            >[0];
            const actual = coercePluginDoctorContractModule(mod).stateMigrations.map((migration) =>
              Object.assign(
                { id: migration.id },
                migration.doctorOnly === true ? { doctorOnly: true as const } : {},
                migration.phase ? { phase: migration.phase } : {},
              ),
            );
            return JSON.stringify(declaration) === JSON.stringify(actual)
              ? []
              : [`${record.id}: declared state migration descriptors do not match the artifact`];
          },
        ),
      )
    ).flat();

    expect(mismatches).toStrictEqual([]);
  }, 600_000);
});
