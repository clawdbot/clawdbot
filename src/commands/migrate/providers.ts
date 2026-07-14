/** Migration provider lookup, option shaping, and plan creation helpers. */
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

/** Resolves a migration provider from the loaded plugin migration registry. */
export function resolveMigrationProvider(
  providerId: string,
  config = getRuntimeConfig(),
): MigrationProviderPlugin {
  ensureStandaloneMigrationProviderRegistryLoaded({
    cfg: config,
    providerId,
  });
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

/** Builds provider-specific options from shared migrate CLI flags. */
export function buildMigrationProviderOptions(
  opts: MigrateCommonOptions,
  providerId = opts.provider,
): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (providerId === "codex" && opts.verifyPluginApps === true) {
    options.verifyPluginApps = true;
  }
  if (providerId === "codex" && opts.configPatchMode) {
    options.configPatchMode = opts.configPatchMode;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/** Creates a migration plan after validating provider-specific flag support. */
export async function createMigrationPlan(
  runtime: RuntimeEnv,
  opts: MigrateCommonOptions & { provider: string },
): Promise<MigrationPlan> {
  if (opts.verifyPluginApps && opts.provider !== "codex") {
    throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
  }
  const provider = resolveMigrationProvider(opts.provider, opts.configOverride);
  const ctx = buildMigrationContext({
    source: opts.source,
    includeSecrets: opts.includeSecrets,
    overwrite: opts.overwrite,
    configOverride: opts.configOverride,
    providerOptions: buildMigrationProviderOptions(opts),
    runtime,
    json: opts.json,
  });
  return await provider.plan(ctx);
}
