import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

export type PostInstallMigrationOptions = {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  // Required only on interactive paths; non-interactive callers can omit it
  // since the helper only emits hint lines in that mode.
  prompter?: WizardPrompter;
  // Plugin ids that were just newly installed. Migration offers are gated to
  // providers owned by these plugins so existing on-disk plugins don't trigger
  // a surprise prompt every onboarding run.
  installedPluginIds: readonly string[];
  // When true, the helper only emits hint lines and never prompts or applies.
  // Wire this from non-interactive onboarding paths.
  nonInteractive?: boolean;
};

type ResolvedProviderCandidate = {
  provider: MigrationProviderPlugin;
  source?: string;
};

async function resolveCandidates(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  installedPluginIds: readonly string[];
}): Promise<ResolvedProviderCandidate[]> {
  if (params.installedPluginIds.length === 0) {
    return [];
  }
  const [
    { ensureStandaloneMigrationProviderRegistryLoaded, resolvePluginMigrationProviders },
    { resolveManifestContractRuntimePluginResolution },
    { createMigrationLogger },
    { resolveStateDir },
  ] = await Promise.all([
    import("../plugins/migration-provider-runtime.js"),
    import("../plugins/manifest-contract-runtime.js"),
    import("../commands/migrate/context.js"),
    import("../config/paths.js"),
  ]);
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: params.config });
  const installedIds = new Set(params.installedPluginIds);
  const providers = resolvePluginMigrationProviders({ cfg: params.config });
  const stateDir = resolveStateDir();
  const logger = createMigrationLogger(params.runtime);
  const candidates: ResolvedProviderCandidate[] = [];
  for (const provider of providers) {
    if (!provider.detect) {
      continue;
    }
    // Ownership check: only offer migration for providers declared by a plugin
    // that was just installed in this onboarding step.
    const ownership = resolveManifestContractRuntimePluginResolution({
      cfg: params.config,
      contract: "migrationProviders",
      value: provider.id,
    });
    if (!ownership.pluginIds.some((pluginId) => installedIds.has(pluginId))) {
      continue;
    }
    try {
      const detection = await provider.detect({
        config: params.config,
        stateDir,
        logger,
      });
      if (!detection.found || detection.confidence === "low") {
        continue;
      }
      candidates.push({
        provider,
        ...(detection.source ? { source: detection.source } : {}),
      });
    } catch (error) {
      logger.debug?.(
        `Post-install migration detect for ${provider.id} failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  return candidates;
}

function describeCandidate(candidate: ResolvedProviderCandidate): string {
  const parts = [candidate.provider.label];
  if (candidate.source) {
    parts.push(`at ${candidate.source}`);
  }
  return parts.join(" ");
}

function logMigrationHint(runtime: RuntimeEnv, candidate: ResolvedProviderCandidate): void {
  const command = formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`);
  runtime.log(`Detected ${describeCandidate(candidate)}. Preview migration with ${command}.`);
}

/**
 * Offer interactive migration for any migration provider owned by a plugin
 * that was just installed during onboarding. In non-interactive mode this is
 * a no-op apart from a hint line so scripted setups never mutate state
 * unexpectedly. The actual migration UI (skill/plugin checkboxes, confirm
 * prompt) is owned by `openclaw migrate <provider>`; this helper only owns
 * the gate prompt.
 */
export async function offerPostInstallMigrations(
  params: PostInstallMigrationOptions,
): Promise<void> {
  const candidates = await resolveCandidates({
    config: params.config,
    runtime: params.runtime,
    installedPluginIds: params.installedPluginIds,
  });
  if (candidates.length === 0) {
    return;
  }
  const prompter = params.prompter;
  const interactive =
    params.nonInteractive !== true && process.stdin.isTTY && prompter !== undefined;
  for (const candidate of candidates) {
    if (!interactive || !prompter) {
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    const description = describeCandidate(candidate);
    let accepted = false;
    try {
      accepted = await prompter.confirm({
        message: `Migrate ${description} into this agent now?`,
        initialValue: false,
      });
    } catch (error) {
      // Prompt cancellations / non-TTY refusals fall back to the hint path so
      // onboarding never aborts on an optional offer.
      params.runtime.log(
        `Skipping ${candidate.provider.label} migration prompt: ${formatErrorMessage(error)}`,
      );
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    if (!accepted) {
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    try {
      const { migrateDefaultCommand } = await import("../commands/migrate.js");
      await migrateDefaultCommand(params.runtime, {
        provider: candidate.provider.id,
        suppressPlanLog: true,
      });
    } catch (error) {
      params.runtime.log(
        `${candidate.provider.label} migration failed: ${formatErrorMessage(error)}. ` +
          `Re-run with ${formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`)} to inspect.`,
      );
    }
  }
}
