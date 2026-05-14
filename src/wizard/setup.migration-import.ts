import fs from "node:fs/promises";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

export type SetupMigrationDetection = {
  providerId: string;
  label: string;
  source?: string;
  message?: string;
};

const MEANINGFUL_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);
const MEANINGFUL_WORKSPACE_ENTRIES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "skills",
] as const;
const MEANINGFUL_STATE_ENTRIES = ["credentials", "sessions", "agents"] as const;

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function hasDirectoryEntries(candidate: string): Promise<boolean> {
  try {
    return (await fs.readdir(candidate)).length > 0;
  } catch {
    return false;
  }
}

function hasMeaningfulConfig(config: OpenClawConfig): boolean {
  return Object.keys(config as Record<string, unknown>).some(
    (key) => !MEANINGFUL_CONFIG_IGNORED_KEYS.has(key),
  );
}

export async function inspectSetupMigrationFreshness(params: {
  baseConfig: OpenClawConfig;
  stateDir: string;
  workspaceDir: string;
}): Promise<{ fresh: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (hasMeaningfulConfig(params.baseConfig)) {
    reasons.push("existing config values are loaded");
  }
  for (const entry of MEANINGFUL_WORKSPACE_ENTRIES) {
    if (await exists(path.join(params.workspaceDir, entry))) {
      reasons.push(`workspace ${entry} exists`);
    }
  }
  for (const entry of MEANINGFUL_STATE_ENTRIES) {
    if (await hasDirectoryEntries(path.join(params.stateDir, entry))) {
      reasons.push(`state ${entry}/ exists`);
    }
  }
  return { fresh: reasons.length === 0, reasons };
}

function assertFreshSetupMigrationTarget(freshness: {
  fresh: boolean;
  reasons: readonly string[];
}): void {
  if (freshness.fresh || process.env.OPENCLAW_MIGRATION_EXISTING_IMPORT === "1") {
    return;
  }
  throw new Error(
    [
      "Migration import during onboarding requires a fresh OpenClaw setup.",
      "Create a fresh setup or reset config, credentials, sessions, and workspace before importing.",
      "Backup plus overwrite/merge imports are feature-gated for now.",
      "Existing setup:",
      ...freshness.reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
  );
}

export async function detectSetupMigrationSources(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<SetupMigrationDetection[]> {
  const [
    { ensureStandaloneMigrationProviderRegistryLoaded, resolvePluginMigrationProviders },
    { createMigrationLogger },
    { resolveStateDir },
  ] = await Promise.all([
    import("../plugins/migration-provider-runtime.js"),
    import("../commands/migrate/context.js"),
    import("../config/paths.js"),
  ]);
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: params.config });
  const stateDir = resolveStateDir();
  const logger = createMigrationLogger(params.runtime);
  const detections: SetupMigrationDetection[] = [];
  for (const provider of resolvePluginMigrationProviders({ cfg: params.config })) {
    if (!provider.detect) {
      continue;
    }
    try {
      const detection = await provider.detect({
        config: params.config,
        stateDir,
        logger,
      });
      if (detection.found) {
        detections.push({
          providerId: provider.id,
          label: detection.label ?? provider.label,
          ...(detection.source ? { source: detection.source } : {}),
          ...(detection.message ? { message: detection.message } : {}),
        });
      }
    } catch (error) {
      logger.debug?.(
        `Migration provider ${provider.id} detection failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  return detections;
}

function resolveImportSourceDefault(params: {
  providerId: string;
  detections: readonly SetupMigrationDetection[];
}): string {
  const detected = params.detections.find(
    (detection) => detection.providerId === params.providerId,
  );
  if (detected?.source) {
    return detected.source;
  }
  return params.providerId === "hermes" ? "~/.hermes" : "";
}

async function selectSetupMigrationProvider(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
}): Promise<{
  provider: MigrationProviderPlugin;
  providerId: string;
}> {
  const {
    ensureStandaloneMigrationProviderRegistryLoaded,
    resolvePluginMigrationProvider,
    resolvePluginMigrationProviders,
  } = await import("../plugins/migration-provider-runtime.js");
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: params.baseConfig });
  const providers = resolvePluginMigrationProviders({ cfg: params.baseConfig });
  if (providers.length === 0) {
    throw new Error("No migration providers found.");
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const providerId =
    params.opts.importFrom?.trim() ||
    (await params.prompter.select({
      message: "Migration source",
      options: [
        ...params.detections.map((detection) => ({
          value: detection.providerId,
          label: detection.label,
          ...(detection.source || detection.message
            ? { hint: detection.source ?? detection.message }
            : {}),
        })),
        ...providers
          .filter(
            (provider) =>
              !params.detections.some((detection) => detection.providerId === provider.id),
          )
          .map((provider) => ({
            value: provider.id,
            label: provider.label,
            hint: provider.description ?? "Enter a source path next",
          })),
      ],
      initialValue: params.detections[0]?.providerId ?? providers[0]?.id,
    }));
  const provider =
    providerById.get(providerId) ??
    resolvePluginMigrationProvider({ providerId, cfg: params.baseConfig });
  if (!provider) {
    throw new Error(`Unknown migration provider "${providerId}".`);
  }
  return { provider, providerId };
}

export async function runSetupMigrationImport(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  commitConfigFile: (config: OpenClawConfig) => Promise<OpenClawConfig>;
}): Promise<void> {
  const [
    { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig },
    { createMigrationLogger, buildMigrationReportDir },
    { createPreMigrationBackup },
    { assertApplySucceeded, assertConflictFreePlan, formatMigrationPreview, formatMigrationResult },
    { resolveStateDir },
    onboardHelpers,
  ] = await Promise.all([
    import("../commands/onboard-config.js"),
    import("../commands/migrate/context.js"),
    import("../commands/migrate/apply.js"),
    import("../commands/migrate/output.js"),
    import("../config/paths.js"),
    import("../commands/onboard-helpers.js"),
  ]);
  const { provider, providerId } = await selectSetupMigrationProvider({
    opts: params.opts,
    baseConfig: params.baseConfig,
    detections: params.detections,
    prompter: params.prompter,
  });
  const sourceDefault = resolveImportSourceDefault({ providerId, detections: params.detections });
  const sourceDir =
    params.opts.importSource?.trim() ||
    sourceDefault ||
    (params.opts.nonInteractive
      ? (() => {
          throw new Error("--import-source is required for non-interactive migration import.");
        })()
      : await params.prompter.text({
          message: "Source agent home",
          initialValue: providerId === "hermes" ? "~/.hermes" : undefined,
        }));
  const workspaceInput =
    params.opts.workspace ??
    (params.opts.nonInteractive
      ? (params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await params.prompter.text({
          message: "Target workspace directory",
          initialValue:
            params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));
  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);
  let targetConfig = applyLocalSetupWorkspaceConfig(params.baseConfig, workspaceDir);
  if (params.opts.skipBootstrap) {
    targetConfig = applySkipBootstrapConfig(targetConfig);
  }

  const stateDir = resolveStateDir();
  assertFreshSetupMigrationTarget(
    await inspectSetupMigrationFreshness({
      baseConfig: params.baseConfig,
      stateDir,
      workspaceDir,
    }),
  );
  const ctx = {
    config: targetConfig,
    stateDir,
    source: sourceDir,
    includeSecrets: Boolean(params.opts.importSecrets),
    overwrite: false,
    logger: createMigrationLogger(params.runtime),
  };
  const plan = await provider.plan(ctx);
  await params.prompter.note(formatMigrationPreview(plan).join("\n"), "Migration preview");
  assertConflictFreePlan(plan, providerId);

  const confirmed =
    params.opts.nonInteractive === true
      ? true
      : await params.prompter.confirm({
          message: "Apply this migration now?",
          initialValue: false,
        });
  if (!confirmed) {
    throw new WizardCancelledError("migration cancelled");
  }

  const reportDir = buildMigrationReportDir(providerId, stateDir);
  const backupPath = await createPreMigrationBackup({});
  targetConfig = onboardHelpers.applyWizardMetadata(targetConfig, {
    command: "onboard",
    mode: "local",
  });
  targetConfig = await params.commitConfigFile(targetConfig);
  const applyCtx = {
    ...ctx,
    config: targetConfig,
    ...(backupPath ? { backupPath } : {}),
    reportDir,
  };
  const result = await provider.apply(applyCtx, plan);
  const withReport = {
    ...result,
    ...((result.backupPath ?? backupPath) ? { backupPath: result.backupPath ?? backupPath } : {}),
    reportDir: result.reportDir ?? reportDir,
  };
  assertApplySucceeded(withReport);
  await params.prompter.note(formatMigrationResult(withReport).join("\n"), "Migration applied");
  await params.prompter.outro("Migration complete. Run `openclaw doctor` next.");
}
