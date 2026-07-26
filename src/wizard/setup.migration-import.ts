import type { OnboardOptions } from "../commands/onboard-types.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "../commands/onboarding-plugin-install.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
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
import { offerLiveModelVerification } from "./setup.inference-verification.js";
import {
  assertDeferredMigrationApplyContract,
  finalizeSetupMigrationPromotion,
} from "./setup.migration-finalize.js";
import {
  assertFreshSetupMigrationTarget,
  buildSetupMigrationPlanSourceSnapshot,
  buildSetupMigrationTargetSnapshot,
  inspectSetupMigrationFreshness,
  preserveSetupMigrationSecurityAcknowledgement,
  prepareSetupMigrationAttemptBoundary,
  withSetupMigrationTargetLock,
} from "./setup.migration-snapshot.js";
import {
  buildSetupMigrationPhasePlan,
  createSetupMigrationStage,
  recoverSetupMigrationPromotion,
  type SetupMigrationPromotionOutcome,
} from "./setup.migration-stage.js";

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
const loadMigrationProviderRuntimeModule = createLazyRuntimeModule(
  () => import("../plugins/migration-provider-runtime.js"),
);

const loadMigrationContextModule = createLazyRuntimeModule(
  () => import("../commands/migrate/context.js"),
);

const loadConfigPathsModule = createLazyRuntimeModule(() => import("../config/paths.js"));

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
  readConfigFile: () => Promise<OpenClawConfig>;
  commitConfigFile: (
    config: OpenClawConfig,
    expectedConfig: OpenClawConfig,
  ) => Promise<OpenClawConfig>;
  continueOnboarding?: boolean;
}): Promise<Awaited<ReturnType<typeof finalizeSetupMigrationPromotion>>> {
  const [
    { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig },
    { createMigrationLogger, buildMigrationReportDir },
    { assertApplySucceeded, assertConflictFreePlan, formatMigrationPreview, formatMigrationResult },
    { resolveStateDir },
    onboardHelpers,
  ] = await Promise.all([
    import("../commands/onboard-config.js"),
    loadMigrationContextModule(),
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
  return await withSetupMigrationTargetLock(stateDir, async () => {
    const promotionResume = await recoverSetupMigrationPromotion({
      stateDir,
      providerId,
      readConfigFile: params.readConfigFile,
    });
    if (promotionResume) {
      const committedConfig = await params.readConfigFile();
      const resolvedProvider = await resolveSetupMigrationProvider({
        providerId,
        baseConfig: committedConfig,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir: promotionResume.continuation.workspaceDir,
      });
      assertDeferredMigrationApplyContract(
        resolvedProvider.provider,
        promotionResume.continuation.plan,
      );
      return await finalizeSetupMigrationPromotion({
        provider: resolvedProvider.provider,
        resume: promotionResume,
        config: committedConfig,
        stateDir,
        logger: createMigrationLogger(params.runtime),
        prompter: params.prompter,
        formatMigrationResult,
      });
    }
    const lockedBaseConfig = preserveSetupMigrationSecurityAcknowledgement(
      await params.readConfigFile(),
      params.baseConfig,
    );
    const freshness = await inspectSetupMigrationFreshness({
      baseConfig: lockedBaseConfig,
      stateDir,
      workspaceDir,
    });
    assertFreshSetupMigrationTarget(freshness);
    const resolvedProvider = await resolveSetupMigrationProvider({
      providerId,
      baseConfig: lockedBaseConfig,
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir,
    });
    const planningBaseConfig = await params.readConfigFile();
    const planningTargetSnapshotHash = await buildSetupMigrationTargetSnapshot({
      config: planningBaseConfig,
      stateDir,
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
    const sourceDefault = resolveImportSourceDefault({
      providerId,
      detections: selectedDetections,
    });
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
    const initialCtx: MigrationProviderContext = {
      config: targetConfig,
      stateDir,
      source: sourceDir,
      overwrite: false,
      logger: migrationLogger,
    };
    const planned = await createSetupMigrationPlan({
      provider: resolvedProvider.provider,
      ctx: initialCtx,
      importSecrets: Boolean(params.opts.importSecrets),
      nonInteractive: Boolean(params.opts.nonInteractive),
      prompter: params.prompter,
    });
    const plannedSourceSnapshotHash = await buildSetupMigrationPlanSourceSnapshot(planned.plan);
    const ctx = planned.ctx;
    const plan = planned.plan;
    assertDeferredMigrationApplyContract(resolvedProvider.provider, plan);
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

    targetConfig = onboardHelpers.applyWizardMetadata(targetConfig, {
      command: "onboard",
      mode: "local",
    });
    await prepareSetupMigrationAttemptBoundary({
      currentConfig: await params.readConfigFile(),
      targetConfig,
      stateDir,
      workspaceDir,
      plan,
      expectedTargetSnapshotHash: planningTargetSnapshotHash,
      expectedSourceSnapshotHash: plannedSourceSnapshotHash,
    });
    const reportDir = buildMigrationReportDir(providerId, stateDir);
    const stage = await createSetupMigrationStage({
      providerId,
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig,
    });
    try {
      const stagedPlan = stage.projectPlanToStage(
        buildSetupMigrationPhasePlan(plan, "before-promotion"),
      );
      const stagedRuntime = ctx.runtime
        ? {
            ...ctx.runtime,
            config: {
              ...ctx.runtime.config,
              current: stage.configRuntime.current,
              mutateConfigFile: stage.configRuntime.mutateConfigFile,
              replaceConfigFile: async () => {
                throw new Error("Full config replacement is unavailable during staged migration.");
              },
            },
          }
        : undefined;
      const stagedResult = await resolvedProvider.provider.apply(
        {
          ...ctx,
          ...(stagedRuntime ? { runtime: stagedRuntime } : {}),
          config: stage.getStagedConfig(),
          configRuntime: stage.configRuntime,
          stateDir: stage.staged.stateDir,
          reportDir: stage.staged.reportDir,
        },
        stagedPlan,
      );
      assertApplySucceeded(stagedResult);
      const projectedStagedResult = stage.projectResultToFinal(stagedResult);

      let outcome: SetupMigrationPromotionOutcome = { kind: "no-imported-inference" };
      if (resolveAgentModelPrimaryValue(stage.getStagedConfig().agents?.defaults?.model)) {
        const verification = await offerLiveModelVerification({
          config: stage.getStagedConfig(),
          opts: params.opts,
          prompter: params.prompter,
          runtime: params.runtime,
          workspaceDir: stage.staged.workspaceDir,
          agentDir: stage.staged.agentDir,
          stateDir: stage.staged.stateDir,
          writeConfig: async (config) => {
            stage.replaceStagedConfig(config);
            return stage.getStagedConfig();
          },
          required: true,
        });
        if (!verification.verified || !verification.modelRef) {
          throw new Error("Imported inference was not verified.");
        }
        stage.replaceStagedConfig(verification.config);
        outcome = { kind: "verified-inference", modelRef: verification.modelRef };
      }

      const [currentTargetSnapshotHash, currentSourceSnapshotHash] = await Promise.all([
        buildSetupMigrationTargetSnapshot({
          config: await params.readConfigFile(),
          stateDir,
          workspaceDir,
        }),
        buildSetupMigrationPlanSourceSnapshot(plan),
      ]);
      if (currentTargetSnapshotHash !== planningTargetSnapshotHash) {
        throw new Error("Migration target changed before promotion. Review it and retry.");
      }
      if (currentSourceSnapshotHash !== plannedSourceSnapshotHash) {
        throw new Error("Migration source changed before promotion. Review it and retry.");
      }

      const promoted = await stage.promote({
        expectedConfig: planningBaseConfig,
        continuation: {
          providerLabel: resolvedProvider.provider.label,
          ...(ctx.source ? { source: ctx.source } : {}),
          ...(ctx.includeSecrets !== undefined ? { includeSecrets: ctx.includeSecrets } : {}),
          ...(ctx.providerOptions ? { providerOptions: ctx.providerOptions } : {}),
          plan,
          stagedResult: projectedStagedResult,
          outcome,
          continueOnboarding: params.continueOnboarding === true,
        },
        readConfigFile: params.readConfigFile,
        commitConfigFile: params.commitConfigFile,
      });
      return await finalizeSetupMigrationPromotion({
        provider: resolvedProvider.provider,
        resume: promoted.resume,
        config: promoted.config,
        stateDir,
        logger: migrationLogger,
        prompter: params.prompter,
        formatMigrationResult,
      });
    } finally {
      await stage.cleanup();
    }
  });
}
