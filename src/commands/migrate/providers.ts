import { getRuntimeConfig } from "../../config/config.js";
import {
  ensureStandaloneMigrationProviderRegistryLoaded,
  resolvePluginMigrationProvider,
  resolvePluginMigrationProviders,
} from "../../plugins/migration-provider-runtime.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { buildMigrationContext } from "./context.js";
import type { MigrateCommonOptions } from "./types.js";

export function resolveMigrationProvider(providerId: string): MigrationProviderPlugin {
  const config = getRuntimeConfig();
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: config });
  const provider = resolvePluginMigrationProvider({ providerId, cfg: config });
  if (!provider) {
    const available = resolvePluginMigrationProviders({ cfg: config }).map((entry) => entry.id);
    const suffix =
      available.length > 0
        ? ` Available providers: ${available.join(", ")}.`
        : " No providers found.";
    throw new Error(`Unknown migration provider "${providerId}".${suffix}`);
  }
  return provider;
}

export function buildMigrationProviderOptions(
  opts: MigrateCommonOptions,
): Record<string, unknown> | undefined {
  if (opts.provider === "codex" && opts.verifyPluginApps === true) {
    return { verifyPluginApps: true };
  }
  return undefined;
}

export async function createMigrationPlan(
  runtime: RuntimeEnv,
  opts: MigrateCommonOptions & { provider: string },
): Promise<MigrationPlan> {
  if (opts.verifyPluginApps && opts.provider !== "codex") {
    throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
  }
  const provider = resolveMigrationProvider(opts.provider);
  const ctx = buildMigrationContext({
    source: opts.source,
    includeSecrets: opts.includeSecrets,
    overwrite: opts.overwrite,
    providerOptions: buildMigrationProviderOptions(opts),
    runtime,
    json: opts.json,
  });
  return await provider.plan(ctx);
}
