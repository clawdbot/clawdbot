// Setup migration import helpers read existing config during onboarding migration.
import fs from "node:fs/promises";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  listAvailableManifestContractPlugins,
  loadManifestContractSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../plugins/official-external-plugin-catalog.js";
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

// Onboarding migration import helpers detect existing setups, select a plugin
// migration provider, preview a plan, back up state, and apply into fresh setup.
type SetupMigrationDetection = {
  providerId: string;
  label: string;
  source?: string;
  message?: string;
};

type SetupMigrationOption = {
  providerId: string;
  label: string;
  hint?: string;
};

type InstallableSetupMigrationProvider = {
  providerId: string;
  entry: OnboardingPluginInstallEntry;
  description?: string;
};

type ManifestSetupMigrationProvider = {
  providerId: string;
  label: string;
  description?: string;
};

const MEANINGFUL_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);
const MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS = new Set(["securityAcknowledgedAt"]);
const MEANINGFUL_WORKSPACE_ENTRIES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "skills",
] as const;
const MEANINGFUL_STATE_ENTRIES = ["credentials", "sessions", "agents"] as const;

const loadMigrationProviderRuntimeModule = createLazyRuntimeModule(
  () => import("../plugins/migration-provider-runtime.js"),
);

const loadMigrationContextModule = createLazyRuntimeModule(
  () => import("../commands/migrate/context.js"),
);

const loadConfigPathsModule = createLazyRuntimeModule(() => import("../config/paths.js"));

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
  return Object.entries(config as Record<string, unknown>).some(([key, value]) => {
    if (MEANINGFUL_CONFIG_IGNORED_KEYS.has(key)) {
      return false;
    }
    if (key === "wizard") {
      return hasMeaningfulWizardConfig(value);
    }
    return true;
  });
}

function hasMeaningfulWizardConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return true;
  }
  return Object.keys(value as Record<string, unknown>).some(
    (key) => !MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS.has(key),
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
  // Migration import is currently fresh-setup only unless an explicit env gate
  // opts into existing-target behavior.
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
    loadMigrationProviderRuntimeModule(),
    loadMigrationContextModule(),
    loadConfigPathsModule(),
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
      // Detection is advisory; one failing provider must not prevent onboarding
      // from offering other migration sources.
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

function resolveInstallableSetupMigrationProviders(): InstallableSetupMigrationProvider[] {
  const providers: InstallableSetupMigrationProvider[] = [];
  for (const catalogEntry of listOfficialExternalPluginCatalogEntries()) {
    const manifest = getOfficialExternalPluginCatalogManifest(catalogEntry);
    const pluginId = resolveOfficialExternalPluginId(catalogEntry);
    const install = resolveOfficialExternalPluginInstall(catalogEntry);
    if (!pluginId || !install) {
      continue;
    }
    for (const providerId of manifest?.contracts?.migrationProviders ?? []) {
      providers.push({
        providerId,
        entry: {
          pluginId,
          label: resolveOfficialExternalPluginLabel(catalogEntry),
          install,
          trustedSourceLinkedOfficialInstall: true,
        },
        ...(catalogEntry.description ? { description: catalogEntry.description } : {}),
      });
    }
  }
  return providers;
}

function formatMigrationProviderId(providerId: string): string {
  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveManifestMigrationProviderLabel(params: {
  providerId: string;
  pluginName?: string;
}): string {
  const pluginName = params.pluginName?.trim().replace(/\s+Migration$/i, "");
  return pluginName || formatMigrationProviderId(params.providerId) || params.providerId;
}

function resolveManifestSetupMigrationProviders(
  baseConfig: OpenClawConfig,
): ManifestSetupMigrationProvider[] {
  const snapshot = loadManifestContractSnapshot({ config: baseConfig });
  return listAvailableManifestContractPlugins({
    snapshot,
    contract: "migrationProviders",
    config: baseConfig,
  }).flatMap((plugin) =>
    (plugin.contracts?.migrationProviders ?? []).map((providerId) => {
      const provider: ManifestSetupMigrationProvider = {
        providerId,
        label: resolveManifestMigrationProviderLabel({ providerId, pluginName: plugin.name }),
      };
      if (plugin.description) {
        provider.description = plugin.description;
      }
      return provider;
    }),
  );
}

export async function listSetupMigrationOptions(params: {
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
}): Promise<SetupMigrationOption[]> {
  const { resolvePluginMigrationProviders } = await loadMigrationProviderRuntimeModule();
  const providers = resolvePluginMigrationProviders({ cfg: params.baseConfig });
  const options: SetupMigrationOption[] = [];
  const providerIds = new Set<string>();
  const addOption = (option: SetupMigrationOption) => {
    if (providerIds.has(option.providerId)) {
      return;
    }
    providerIds.add(option.providerId);
    options.push(option);
  };

  for (const detection of params.detections) {
    addOption({
      providerId: detection.providerId,
      label: detection.label,
      ...(detection.source || detection.message
        ? { hint: detection.source ?? detection.message }
        : {}),
    });
  }
  for (const provider of providers) {
    addOption({
      providerId: provider.id,
      label: provider.label,
      hint: provider.description ?? t("wizard.migration.sourcePathHint"),
    });
  }
  for (const provider of resolveManifestSetupMigrationProviders(params.baseConfig)) {
    addOption({
      providerId: provider.providerId,
      label: provider.label,
      hint: provider.description ?? t("wizard.migration.sourcePathHint"),
    });
  }
  for (const provider of resolveInstallableSetupMigrationProviders()) {
    addOption({
      providerId: provider.providerId,
      label: provider.entry.label,
      hint: provider.description ?? t("wizard.migration.sourcePathHint"),
    });
  }

  return options;
}

async function selectSetupMigrationProvider(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
}): Promise<string> {
  const options = await listSetupMigrationOptions({
    baseConfig: params.baseConfig,
    detections: params.detections,
  });
  if (options.length === 0) {
    throw new Error("No migration providers found.");
  }
  const providerId =
    params.opts.importFrom?.trim() ||
    (await params.prompter.select({
      message: t("wizard.migration.source"),
      options: options.map((option) => ({
        value: option.providerId,
        label: option.label,
        ...(option.hint ? { hint: option.hint } : {}),
      })),
      initialValue: params.detections[0]?.providerId ?? options[0]?.providerId,
    }));
  if (!options.some((option) => option.providerId === providerId)) {
    throw new Error(`Unknown migration provider "${providerId}".`);
  }
  return providerId;
}

async function resolveSetupMigrationProvider(params: {
  providerId: string;
  baseConfig: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
}): Promise<{ provider: MigrationProviderPlugin; baseConfig: OpenClawConfig }> {
  const { ensureStandaloneMigrationProviderRegistryLoaded, resolvePluginMigrationProvider } =
    await loadMigrationProviderRuntimeModule();
  ensureStandaloneMigrationProviderRegistryLoaded({
    cfg: params.baseConfig,
    providerId: params.providerId,
  });
  const existing = resolvePluginMigrationProvider({
    providerId: params.providerId,
    cfg: params.baseConfig,
  });
  if (existing) {
    return { provider: existing, baseConfig: params.baseConfig };
  }
  const installable = resolveInstallableSetupMigrationProviders().find(
    (provider) => provider.providerId === params.providerId,
  );
  if (!installable) {
    throw new Error(`Unknown migration provider "${params.providerId}".`);
  }
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.baseConfig,
    entry: installable.entry,
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    promptInstall: false,
  });
  if (!result.installed) {
    throw new Error(`Could not install migration provider "${params.providerId}".`);
  }
  ensureStandaloneMigrationProviderRegistryLoaded({
    cfg: result.cfg,
    providerId: params.providerId,
  });
  const provider = resolvePluginMigrationProvider({
    providerId: params.providerId,
    cfg: result.cfg,
  });
  if (!provider) {
    throw new Error(`Installed plugin did not register migration provider "${params.providerId}".`);
  }
  return { provider, baseConfig: result.cfg };
}

function hasCredentialCandidate(plan: MigrationPlan): boolean {
  return plan.items.some(
    (item) => item.kind === "auth" || item.kind === "secret" || item.sensitive === true,
  );
}

async function createSetupMigrationPlan(params: {
  provider: MigrationProviderPlugin;
  ctx: MigrationProviderContext;
  importSecrets: boolean;
  nonInteractive: boolean;
  prompter: WizardPrompter;
}): Promise<{ ctx: MigrationProviderContext; plan: MigrationPlan }> {
  let ctx = { ...params.ctx, includeSecrets: params.importSecrets };
  let plan = await params.provider.plan(ctx);
  if (params.nonInteractive || params.importSecrets || !hasCredentialCandidate(plan)) {
    return { ctx, plan };
  }
  const includeSecrets = await params.prompter.confirm({
    message: t("wizard.migration.includeCredentials"),
    initialValue: true,
  });
  if (!includeSecrets) {
    return { ctx, plan };
  }
  ctx = { ...ctx, includeSecrets: true };
  plan = await params.provider.plan(ctx);
  return { ctx, plan };
}

export async function runSetupMigrationImport(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  commitConfigFile: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  continueOnboarding?: boolean;
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
    loadMigrationContextModule(),
    import("../commands/migrate/apply.js"),
    import("../commands/migrate/output.js"),
    loadConfigPathsModule(),
    import("../commands/onboard-helpers.js"),
  ]);
  const providerId = await selectSetupMigrationProvider({
    opts: params.opts,
    baseConfig: params.baseConfig,
    detections: params.detections,
    prompter: params.prompter,
  });
  const workspaceInput =
    params.opts.workspace ??
    (params.opts.nonInteractive
      ? (params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await params.prompter.text({
          message: t("wizard.migration.targetWorkspace"),
          initialValue:
            params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));
  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);
  const stateDir = resolveStateDir();
  assertFreshSetupMigrationTarget(
    await inspectSetupMigrationFreshness({
      baseConfig: params.baseConfig,
      stateDir,
      workspaceDir,
    }),
  );
  const resolvedProvider = await resolveSetupMigrationProvider({
    providerId,
    baseConfig: params.baseConfig,
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir,
  });
  const migrationLogger = createMigrationLogger(params.runtime);
  const selectedDetections = [...params.detections];
  if (
    resolvedProvider.provider.detect &&
    !selectedDetections.some((detection) => detection.providerId === providerId)
  ) {
    try {
      const detection = await resolvedProvider.provider.detect({
        config: resolvedProvider.baseConfig,
        stateDir,
        logger: migrationLogger,
      });
      if (detection.found) {
        selectedDetections.push({
          providerId,
          label: detection.label ?? resolvedProvider.provider.label,
          ...(detection.source ? { source: detection.source } : {}),
          ...(detection.message ? { message: detection.message } : {}),
        });
      }
    } catch (error) {
      migrationLogger.debug?.(
        `Migration provider ${providerId} detection failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  const sourceDefault = resolveImportSourceDefault({ providerId, detections: selectedDetections });
  const sourceDir =
    params.opts.importSource?.trim() ||
    sourceDefault ||
    (params.opts.nonInteractive
      ? (() => {
          throw new Error("--import-source is required for non-interactive migration import.");
        })()
      : await params.prompter.text({
          message: t("wizard.migration.sourceAgentHome"),
          initialValue: providerId === "hermes" ? "~/.hermes" : undefined,
        }));
  let targetConfig = applyLocalSetupWorkspaceConfig(resolvedProvider.baseConfig, workspaceDir);
  if (params.opts.skipBootstrap) {
    targetConfig = applySkipBootstrapConfig(targetConfig);
  }
  const initialCtx = {
    config: targetConfig,
    stateDir,
    source: sourceDir,
    overwrite: false,
    logger: migrationLogger,
  };
  const { ctx, plan } = await createSetupMigrationPlan({
    provider: resolvedProvider.provider,
    ctx: initialCtx,
    importSecrets: Boolean(params.opts.importSecrets),
    nonInteractive: Boolean(params.opts.nonInteractive),
    prompter: params.prompter,
  });
  await params.prompter.note(
    formatMigrationPreview(plan).join("\n"),
    t("wizard.migration.previewTitle"),
  );
  assertConflictFreePlan(plan, providerId);

  const confirmed =
    params.opts.nonInteractive === true
      ? true
      : await params.prompter.confirm({
          message: t("wizard.migration.apply"),
          initialValue: true,
        });
  if (!confirmed) {
    throw new WizardCancelledError(t("wizard.migration.cancelled"));
  }

  const reportDir = buildMigrationReportDir(providerId, stateDir);
  const backupPath = await createPreMigrationBackup({});
  // Commit base wizard metadata before applying migrations so generated reports
  // can reference a concrete OpenClaw config target.
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
  const result = await resolvedProvider.provider.apply(applyCtx, plan);
  const withReport = {
    ...result,
    ...((result.backupPath ?? backupPath) ? { backupPath: result.backupPath ?? backupPath } : {}),
    reportDir: result.reportDir ?? reportDir,
  };
  assertApplySucceeded(withReport);
  await params.prompter.note(
    formatMigrationResult(withReport).join("\n"),
    t("wizard.migration.appliedTitle"),
  );
  if (params.continueOnboarding) {
    await params.prompter.note(
      t("wizard.migration.continuing"),
      t("wizard.migration.appliedTitle"),
    );
  } else {
    await params.prompter.outro(t("wizard.migration.complete"));
  }
}
