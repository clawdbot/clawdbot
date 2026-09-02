// Loads optional lightweight migration providers from bundled plugin artifacts.
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { MigrationProviderPlugin } from "./migration-provider.types.js";
import { loadPluginPublicArtifactModuleSync } from "./public-surface-loader.js";

const MIGRATION_PROVIDER_ARTIFACT = "migration-provider-api.js";

type MigrationProviderArtifactModule = {
  buildMigrationProvider?: () => MigrationProviderPlugin;
};

export type MigrationProviderArtifactPlugin = Pick<
  PluginManifestRecord,
  "id" | "origin" | "rootDir" | "contracts"
>;

export function resolveBundledMigrationProviderPublicArtifacts(params: {
  plugins: readonly MigrationProviderArtifactPlugin[];
  providerId: string;
}): Array<{ pluginId: string; provider: MigrationProviderPlugin }> {
  const providers: Array<{ pluginId: string; provider: MigrationProviderPlugin }> = [];
  for (const plugin of params.plugins) {
    const declared = plugin.contracts?.migrationProviders ?? [];
    if (
      plugin.origin !== "bundled" ||
      declared.length === 0 ||
      !declared.includes(params.providerId)
    ) {
      continue;
    }
    let artifact: MigrationProviderArtifactModule;
    try {
      artifact = loadPluginPublicArtifactModuleSync<MigrationProviderArtifactModule>({
        pluginRoot: plugin.rootDir,
        artifactBasename: MIGRATION_PROVIDER_ARTIFACT,
        origin: "bundled",
      });
    } catch (error) {
      if (error instanceof MissingPublicSurfaceError) {
        continue;
      }
      throw error;
    }
    if (typeof artifact.buildMigrationProvider !== "function") {
      throw new Error(
        `Bundled plugin "${plugin.id}" has an invalid ${MIGRATION_PROVIDER_ARTIFACT}: buildMigrationProvider is required.`,
      );
    }
    const provider = artifact.buildMigrationProvider();
    if (
      provider.id !== params.providerId ||
      typeof provider.plan !== "function" ||
      typeof provider.apply !== "function"
    ) {
      throw new Error(
        `Bundled plugin "${plugin.id}" returned an invalid migration provider from ${MIGRATION_PROVIDER_ARTIFACT}.`,
      );
    }
    const existing = providers.find((entry) => entry.provider.id === provider.id);
    if (existing) {
      throw new Error(
        `Multiple bundled plugins declare migration provider "${provider.id}": ${existing.pluginId}, ${plugin.id}.`,
      );
    }
    providers.push({ pluginId: plugin.id, provider });
  }
  return providers;
}
