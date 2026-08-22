import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOnboardingSetupTarget } from "../commands/onboard-agent-target.js";
import * as firstAgentOnboarding from "../commands/onboard-first-agent.js";
import type { OnboardMode, OnboardOptions } from "../commands/onboard-types.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { ConfigMutationConflictError } from "../config/config.js";
import { createMergePatch, applyMergePatch } from "../config/merge-patch.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { t } from "./i18n/index.js";
import { runWizardWithPromptNavigation } from "./navigation-prompter.js";
import type { WizardPrompter } from "./prompts.js";
import { offerLiveModelVerification } from "./setup.inference-verification.js";
import {
  detectSetupMigrationSources,
  listSetupMigrationOptions,
  runSetupMigrationImport,
} from "./setup.migration-import.js";
import {
  SetupMigrationFreshnessError,
  SetupMigrationTargetChangedError,
} from "./setup.migration-snapshot.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import {
  hasQuickstartGatewayOverrides,
  formatQuickstartGatewaySummary,
  readSetupConfigFileSnapshot,
  readValidSetupConfigFile,
  requireRiskAcknowledgement,
  resolveQuickstartGatewayDefaults,
  writeWizardConfigFile,
} from "./setup.shared.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./setup.types.js";
import { resolveSetupWorkspaceSelection } from "./setup.workspace.js";

type SetupFlowChoice = WizardFlow | "import" | "keep-model" | `import:${string}`;

const loadConfigLoggingModule = createLazyRuntimeModule(() => import("../config/logging.js"));

const loadOnboardConfigModule = createLazyRuntimeModule(
  () => import("../commands/onboard-config.js"),
);

export async function runSetupWizard(
  opts: OnboardOptions,
  runtimeInput: RuntimeEnv | undefined,
  prompter: WizardPrompter,
) {
  await runWizardWithPromptNavigation(
    prompter,
    async (navigationPrompter) => await runSetupWizardOnce(opts, runtimeInput, navigationPrompter),
  );
}

async function runSetupWizardOnce(
  initialOpts: OnboardOptions,
  runtimeInput: RuntimeEnv | undefined,
  prompter: WizardPrompter,
) {
  let opts = initialOpts;
  const runtime = runtimeInput ?? defaultRuntime;
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  await onboardHelpers.printWizardHeader(runtime);
  await prompter.intro(t("wizard.setup.intro"));

  const snapshot = await readSetupConfigFileSnapshot();
  let currentSetupSnapshot = snapshot;
  let baseConfig: OpenClawConfig = snapshot.valid
    ? (snapshot.runtimeConfig ?? snapshot.config)
    : {};
  let setupConfigMergeBase = structuredClone(baseConfig);
  baseConfig = await requireRiskAcknowledgement({ opts, prompter, config: baseConfig });
  // Ordinary onboard reruns must preserve existing agents.list / bindings. Only
  // explicit reset or import flows are allowed to shrink the config — see issue
  // openclaw#84692.
  const writeSetupConfigFile = async (
    config: OpenClawConfig,
    optsLocal: { allowConfigSizeDrop?: boolean } = {},
  ) => {
    const committed = await writeWizardConfigFile(config, {
      ...optsLocal,
      mergeBase: setupConfigMergeBase,
    });
    setupConfigMergeBase = structuredClone(committed);
    return committed;
  };

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      t("wizard.setup.invalidConfigTitle"),
    );
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.openclaw.ai/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    await prompter.outro(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const compatibilityNotices = snapshot.valid
    ? buildPluginCompatibilitySnapshotNotices({ config: baseConfig })
    : [];
  if (compatibilityNotices.length > 0) {
    await prompter.note(
      [
        `Detected ${compatibilityNotices.length} plugin compatibility notice${compatibilityNotices.length === 1 ? "" : "s"} in the current config.`,
        ...compatibilityNotices
          .slice(0, 4)
          .map((notice) => `- ${formatPluginCompatibilityNotice(notice)}`),
        ...(compatibilityNotices.length > 4
          ? [`- ... +${compatibilityNotices.length - 4} more`]
          : []),
        "",
        `Review: ${formatCliCommand("openclaw doctor")}`,
        `Inspect: ${formatCliCommand("openclaw plugins inspect --all")}`,
      ].join("\n"),
      t("wizard.setup.pluginCompatibilityTitle"),
    );
  }

  const quickstartHint = t("wizard.setup.flowQuickstartHint", {
    command: formatCliCommand("openclaw configure"),
  });
  const manualHint = t("wizard.setup.flowAdvancedHint");
  const hasExistingModelConfig =
    resolveAgentModelPrimaryValue(baseConfig.agents?.defaults?.model) !== undefined;
  const migrationDetections = await detectSetupMigrationSources({ config: baseConfig, runtime });
  const migrationOptions = await listSetupMigrationOptions({
    baseConfig,
    detections: migrationDetections,
  });
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced" &&
    normalizedExplicitFlow !== "import"
  ) {
    runtime.error(
      "Invalid --flow. Use quickstart, manual, advanced, or import. Example: openclaw onboard --flow quickstart",
    );
    runtime.exit(1);
    return;
  }
  const explicitFlow: SetupFlowChoice | undefined =
    normalizedExplicitFlow === "quickstart" ||
    normalizedExplicitFlow === "advanced" ||
    normalizedExplicitFlow === "import"
      ? normalizedExplicitFlow
      : undefined;
  const keepModelOption = hasExistingModelConfig
    ? {
        value: "keep-model" as const,
        label: t("wizard.setup.flowKeepModel"),
        hint: t("wizard.setup.flowKeepModelHint"),
      }
    : undefined;
  // Import flags are import intent. Non-interactive setup already routes them
  // to the migration import; showing the mode prompt here would let the answer
  // silently drop the requested import.
  const importIntent = Boolean(
    opts.importFrom?.trim() || opts.importSource?.trim() || opts.importSecrets,
  );
  const promptSetupFlow = async (): Promise<SetupFlowChoice> =>
    await prompter.select({
      message: t("wizard.setup.setupMode"),
      options: [
        ...(keepModelOption ? [keepModelOption] : []),
        { value: "quickstart", label: t("wizard.setup.flowQuickstart"), hint: quickstartHint },
        { value: "advanced", label: t("wizard.setup.flowAdvanced"), hint: manualHint },
        ...(migrationOptions.length > 0
          ? [{ value: "import" as const, label: t("wizard.migration.importFromAnotherAgent") }]
          : []),
      ],
      initialValue: hasExistingModelConfig ? "keep-model" : "quickstart",
    });
  const normalizeSetupFlow = async (choice: SetupFlowChoice) => {
    const keepExistingModelConfig = choice === "keep-model";
    let flow = keepExistingModelConfig ? "quickstart" : choice;
    if (opts.mode === "remote" && flow === "quickstart") {
      await prompter.note(t("wizard.setup.quickstartOnlyLocal"), t("wizard.setup.quickstartTitle"));
      flow = "advanced";
    }
    return { flow, keepExistingModelConfig };
  };
  const flowFromPrompt = explicitFlow === undefined && !importIntent;
  let { flow, keepExistingModelConfig } = await normalizeSetupFlow(
    explicitFlow ?? (importIntent ? "import" : await promptSetupFlow()),
  );

  if (snapshot.exists && !keepExistingModelConfig) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      t("wizard.setup.existingConfigTitle"),
    );
  }

  let usedImportFlow = false;
  let acknowledgeMigrationPromotion: (() => Promise<void>) | undefined;
  let importedInferenceVerified = false;
  while (opts.importFrom || flow === "import" || flow.startsWith("import:")) {
    const importFrom = opts.importFrom ?? (flow.startsWith("import:") ? flow.slice(7) : undefined);
    let migrationOutcome: Awaited<ReturnType<typeof runSetupMigrationImport>>;
    try {
      migrationOutcome = await runSetupMigrationImport({
        opts: {
          ...opts,
          ...(importFrom ? { importFrom } : {}),
        },
        baseConfig,
        detections: migrationDetections,
        prompter,
        runtime,
        readConfigFile: readValidSetupConfigFile,
        async commitConfigFile(cfg, expectedConfig) {
          const latest = await readSetupConfigFileSnapshot();
          if (!latest.valid) {
            throw new Error("Migration target config became invalid. Run `openclaw doctor`.");
          }
          const latestConfig = latest.exists ? (latest.sourceConfig ?? latest.config) : {};
          if (!isDeepStrictEqual(latestConfig, expectedConfig)) {
            throw new ConfigMutationConflictError("config changed during migration promotion");
          }
          return await writeWizardConfigFile(cfg, {
            allowConfigSizeDrop: true,
            baseSnapshot: latest,
            ...(latest.hash !== undefined ? { baseHash: latest.hash } : {}),
          });
        },
        allowProviderBack: flowFromPrompt,
        continueOnboarding: true,
      });
      if (migrationOutcome.kind === "back") {
        ({ flow, keepExistingModelConfig } = await normalizeSetupFlow(await promptSetupFlow()));
        continue;
      }
    } catch (error) {
      const canReturnToSetupMode =
        error instanceof SetupMigrationFreshnessError ||
        error instanceof SetupMigrationTargetChangedError;
      if (!canReturnToSetupMode || !flowFromPrompt) {
        throw error;
      }
      await prompter.note(formatErrorMessage(error), t("wizard.setup.existingConfigTitle"));
      ({ flow, keepExistingModelConfig } = await normalizeSetupFlow(await promptSetupFlow()));
      continue;
    }
    usedImportFlow = true;
    acknowledgeMigrationPromotion = migrationOutcome.acknowledgePromotion;
    const migratedSnapshot = await readSetupConfigFileSnapshot();
    if (!migratedSnapshot.valid) {
      throw new Error("Migration produced an invalid OpenClaw config. Run `openclaw doctor`.");
    }
    currentSetupSnapshot = migratedSnapshot;
    baseConfig = migratedSnapshot.runtimeConfig ?? migratedSnapshot.config;
    setupConfigMergeBase = structuredClone(baseConfig);
    const importedModelRef = resolveAgentModelPrimaryValue(baseConfig.agents?.defaults?.model);
    importedInferenceVerified =
      migrationOutcome.kind === "verified-inference" &&
      importedModelRef === migrationOutcome.modelRef;
    keepExistingModelConfig = importedInferenceVerified;
    flow = "quickstart";
    break;
  }
  const importSuppliedRoster = usedImportFlow && listAgentEntries(baseConfig).length > 0;
  if (importSuppliedRoster && opts.agentName !== undefined) {
    runtime.error(
      "--agent-name cannot be combined with an import that supplies an agent roster. Remove --agent-name or choose an import without agents.",
    );
    runtime.exit(1);
    return;
  }
  const wizardFlow: WizardFlow = flow === "advanced" ? "advanced" : "quickstart";
  const hasExplicitQuickstartGatewayOverrides =
    wizardFlow === "quickstart" && hasQuickstartGatewayOverrides(opts);

  const quickstartGateway: QuickstartGatewayDefaults = resolveQuickstartGatewayDefaults(
    baseConfig,
    opts,
  );

  if (flow === "quickstart") {
    await prompter.note(
      formatQuickstartGatewaySummary(
        quickstartGateway,
        quickstartGateway.hasExisting && !hasExplicitQuickstartGatewayOverrides,
      ),
      "QuickStart",
    );
  }

  const localPort = quickstartGateway.port;
  const localUrl = `ws://127.0.0.1:${localPort}`;
  let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const resolvedGatewayToken = await resolveSetupSecretInputString({
      config: baseConfig,
      value: quickstartGateway.token,
      path: "gateway.auth.token",
      env: process.env,
    });
    if (resolvedGatewayToken) {
      localGatewayToken = resolvedGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        t("wizard.setup.secretRefProbeFailed", { field: "gateway.auth.token" }),
        formatErrorMessage(error),
      ].join("\n"),
      t("wizard.gateway.auth"),
    );
  }
  let localGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  try {
    const resolvedGatewayPassword = await resolveSetupSecretInputString({
      config: baseConfig,
      value: quickstartGateway.password,
      path: "gateway.auth.password",
      env: process.env,
    });
    if (resolvedGatewayPassword) {
      localGatewayPassword = resolvedGatewayPassword;
    }
  } catch (error) {
    await prompter.note(
      [
        t("wizard.setup.secretRefProbeFailed", { field: "gateway.auth.password" }),
        formatErrorMessage(error),
      ].join("\n"),
      t("wizard.gateway.auth"),
    );
  }

  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: localGatewayToken,
    password: localGatewayPassword,
  });
  const storedRemoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url);
  const optionRemoteUrl = normalizeOptionalString(opts.remoteUrl);
  const optionRemoteToken = normalizeOptionalString(opts.remoteToken);
  const optionRemotePassword = normalizeOptionalString(opts.remotePassword);
  const remoteUrlChanged = opts.remoteUrl !== undefined && optionRemoteUrl !== storedRemoteUrl;
  const remoteSeedConfig: OpenClawConfig =
    opts.remoteUrl === undefined &&
    opts.remoteToken === undefined &&
    opts.remotePassword === undefined
      ? baseConfig
      : {
          ...baseConfig,
          gateway: {
            ...baseConfig.gateway,
            remote: {
              ...baseConfig.gateway?.remote,
              ...(opts.remoteUrl !== undefined ? { url: optionRemoteUrl } : {}),
              ...(opts.remoteToken !== undefined
                ? { token: optionRemoteToken }
                : opts.remotePassword !== undefined || remoteUrlChanged
                  ? { token: undefined }
                  : {}),
              ...(opts.remotePassword !== undefined
                ? { password: optionRemotePassword }
                : opts.remoteToken !== undefined || remoteUrlChanged
                  ? { password: undefined }
                  : {}),
            },
          },
        };
  const seededRemoteUrl = remoteSeedConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteOnboard = seededRemoteUrl ? await import("../commands/onboard-remote.js") : null;
  const remoteUrl =
    seededRemoteUrl && remoteOnboard?.validateGatewayWebSocketUrl(seededRemoteUrl) === undefined
      ? seededRemoteUrl
      : "";
  const remoteProbeAuth = remoteUrl
    ? await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: remoteSeedConfig,
        env: process.env,
        mode: "remote",
        explicitAuth: { token: optionRemoteToken, password: optionRemotePassword },
        ...(remoteUrlChanged
          ? { urlOverride: optionRemoteUrl, urlOverrideSource: "cli" as const }
          : {}),
      })
    : null;
  if (remoteProbeAuth?.warning) {
    await prompter.note(
      ["Could not resolve remote gateway SecretRef for setup probe.", remoteProbeAuth.warning].join(
        "\n",
      ),
      "Gateway auth",
    );
  }
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        ...(baseConfig.gateway?.remote?.edgeAuth ? { config: baseConfig } : {}),
        token: remoteProbeAuth?.auth.token,
        ...(remoteProbeAuth?.auth.password ? { password: remoteProbeAuth.auth.password } : {}),
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: t("wizard.setup.whatSetup"),
          options: [
            {
              value: "local",
              label: t("wizard.setup.localGateway"),
              hint: localProbe.ok
                ? t("wizard.setup.localGatewayReachable", { url: localUrl })
                : t("wizard.setup.localGatewayMissing", { url: localUrl }),
            },
            {
              value: "remote",
              label: t("wizard.setup.remoteGateway"),
              hint: !remoteUrl
                ? t("wizard.setup.remoteGatewayMissing")
                : remoteProbe?.ok
                  ? t("wizard.setup.remoteGatewayReachable", { url: remoteUrl })
                  : t("wizard.setup.remoteGatewayUnreachable", { url: remoteUrl }),
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } =
      remoteOnboard ?? (await import("../commands/onboard-remote.js"));
    const { applySkipBootstrapConfig } = await loadOnboardConfigModule();
    const { logConfigUpdated } = await loadConfigLoggingModule();
    let nextConfig = await promptRemoteGatewayConfig(remoteSeedConfig, prompter, {
      secretInputMode: opts.secretInputMode,
      ...(opts.remoteUrl !== undefined && storedRemoteUrl
        ? { edgeAuthOriginUrl: storedRemoteUrl }
        : {}),
    });
    if (opts.skipBootstrap) {
      nextConfig = applySkipBootstrapConfig(nextConfig);
    }
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    prompter.disableBackNavigation?.();
    await writeSetupConfigFile(nextConfig, {
      allowConfigSizeDrop: false,
    });
    logConfigUpdated(runtime);
    await prompter.outro(t("wizard.setup.remoteConfigured"));
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message: t("wizard.setup.workspaceDirectory"),
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const requestedWorkspaceDir = resolveUserPath(
    workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE,
  );

  const { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } =
    await loadOnboardConfigModule();
  const hasAuthoredRoster =
    importSuppliedRoster || hasResolvedRosterBeforeMigrations(currentSetupSnapshot);
  const { workspaceDir, allowWorkspaceChange } = await resolveSetupWorkspaceSelection({
    baseConfig,
    requestedWorkspaceDir,
    prompter,
    hasAuthoredRoster,
  });
  if (opts.authChoice === undefined) {
    const { inferAuthChoiceFromFlags } =
      await import("../commands/onboard-non-interactive/local/auth-choice-inference.js");
    const inferred = inferAuthChoiceFromFlags(opts, { config: baseConfig, workspaceDir });
    if (inferred.matches.length > 1) {
      runtime.error(
        `Multiple provider credential flags (${inferred.matches.map((match) => match.label).join(", ")}). Use one flag or pass --auth-choice explicitly.`,
      );
      return runtime.exit(1);
    }
    opts = inferred.choice ? { ...opts, authChoice: inferred.choice } : opts;
  }
  const firstAgent = await firstAgentOnboarding.promptFirstOnboardingAgent(
    hasAuthoredRoster,
    opts.agentName,
    prompter,
    opts.nonInteractive,
  );
  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(
    baseConfig,
    requestedWorkspaceDir,
    { allowWorkspaceChange: allowWorkspaceChange || !hasAuthoredRoster },
  );
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }
  const preModelAuthConfig = nextConfig;
  let stagedModelAuth: SetupModelAuthCandidate | undefined;
  const hasExplicitAuthSetup = opts.authChoice !== undefined && opts.authChoice !== "skip";
  if (!keepExistingModelConfig || hasExplicitAuthSetup) {
    stagedModelAuth = await runSetupModelAuthStep({
      config: nextConfig,
      opts,
      prompter,
      runtime,
      preserveExistingModelSelection: keepExistingModelConfig,
    });
    nextConfig = stagedModelAuth.config;
  }

  const { configureGatewayForSetup } = await import("./setup.gateway-config.js");
  const gateway = await configureGatewayForSetup({
    flow: wizardFlow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    secretInputMode: opts.secretInputMode,
    prompter,
    runtime,
  });
  const { ensureOnboardingAgent } = await import("../commands/onboard-agent.js");
  const onboardingAgent = await ensureOnboardingAgent({
    config: gateway.nextConfig,
    workspace: workspaceDir,
    preserveCandidateRoster: usedImportFlow,
    baseConfig,
    ...(firstAgent ? { firstAgent } : {}),
  });
  nextConfig = onboardingAgent.config;
  const migrationWarnings = onboardingAgent.sessionMigrationWarnings;
  await firstAgentOnboarding.showSessionMigrationWarnings(prompter, migrationWarnings);

  let liveModelVerified = false;
  let setupConfigPersisted = false;
  // keepExistingModelConfig is latched before auth setup, so this distinguishes
  // a route supplied by the import from one configured normally after the import.
  if (
    opts.nonInteractive !== true &&
    !importedInferenceVerified &&
    resolveAgentModelPrimaryValue(nextConfig.agents?.defaults?.model) !== undefined &&
    ((usedImportFlow && keepExistingModelConfig) || opts.authChoice !== "skip")
  ) {
    const verificationTarget = resolveOnboardingSetupTarget(nextConfig);
    const verification = await offerLiveModelVerification({
      config: nextConfig,
      ...(stagedModelAuth
        ? {
            initialCandidate: {
              ...stagedModelAuth,
              config: nextConfig,
            },
          }
        : {}),
      opts,
      prompter,
      runtime,
      workspaceDir: verificationTarget.workspaceDir,
      writeConfig: async (config) =>
        await writeSetupConfigFile(config, { allowConfigSizeDrop: false }),
      required: usedImportFlow && keepExistingModelConfig,
    });
    nextConfig = verification.config;
    liveModelVerified = verification.verified;
    setupConfigPersisted = verification.persisted;
    if (!verification.verified && verification.attempted && stagedModelAuth) {
      // Gateway/roster decisions may be persisted after an optional failed probe, but the
      // unverified model/auth delta must be removed atomically before that first write.
      nextConfig = applyMergePatch(
        nextConfig,
        createMergePatch(stagedModelAuth.config, preModelAuthConfig),
      ) as OpenClawConfig;
    } else if (!verification.verified && stagedModelAuth) {
      // Declining an optional probe is not a failed verification; keep the
      // provider/model choice the user just made and persist it once here.
      await stagedModelAuth.persistAuthProfiles();
    }
  } else if (stagedModelAuth) {
    // Non-interactive setup has no live-verification step by contract.
    await stagedModelAuth.persistAuthProfiles();
  }

  if (!setupConfigPersisted) {
    // Persist gateway/roster decisions only after the interactive verification boundary.
    nextConfig = await writeSetupConfigFile(nextConfig, {
      allowConfigSizeDrop: false,
    });
  }

  prompter.disableBackNavigation?.();
  if (opts.skipChannels) {
    await prompter.note(t("wizard.setup.skipChannels"), t("wizard.setup.channelsTitle"));
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { createChannelSetupTransaction, setupChannels } =
      await import("../commands/onboard-channels.js");
    const channelSetup = createChannelSetupTransaction({ runtime });
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowIMessageInstall: true,
      allowSignalInstall: true,
      deferStatusUntilSelection: flow === "quickstart",
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
      onPostWriteHook: (hook) => channelSetup.onPostWriteHook(hook),
    });
    nextConfig = await channelSetup.commit(
      nextConfig,
      async (config) => await writeSetupConfigFile(config, { allowConfigSizeDrop: false }),
    );
  }

  if (opts.skipChannels) {
    nextConfig = await writeSetupConfigFile(nextConfig, {
      allowConfigSizeDrop: false,
    });
  }
  let onboardingTarget = resolveOnboardingSetupTarget(nextConfig);
  const { logConfigUpdated } = await loadConfigLoggingModule();
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(onboardingTarget.workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
    agentId: onboardingTarget.agentId,
  });

  if (!usedImportFlow) {
    const { runSetupMemoryImportStep } = await import("./setup.memory-import.js");
    await runSetupMemoryImportStep({ config: nextConfig, prompter, runtime });
  }

  if (opts.skipSearch) {
    await prompter.note(t("wizard.setup.skipSearch"), t("wizard.setup.searchTitle"));
  } else {
    const { runSearchSetupFlow } = await import("../flows/search-setup.js");
    const searchSetup = await runSearchSetupFlow(nextConfig, runtime, prompter, {
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
    nextConfig = searchSetup.config;
  }

  if (opts.skipSkills) {
    await prompter.note(t("wizard.setup.skipSkills"), t("wizard.setup.skillsTitle"));
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, onboardingTarget.workspaceDir, runtime, prompter, {
      nodeManager: opts.nodeManager,
    });
  }

  let commitAppRecommendationResult: (() => void) | undefined;
  if (flow !== "quickstart") {
    const { setupOfficialPluginInstalls } = await import("./setup.official-plugins.js");
    nextConfig = await setupOfficialPluginInstalls({
      config: nextConfig,
      prompter,
      runtime,
      workspaceDir: onboardingTarget.workspaceDir,
    });
    const { setupAppRecommendations } = await import("./setup.app-recommendations.js");
    const recommendationOutcome = await setupAppRecommendations({
      config: nextConfig,
      prompter,
      runtime,
      workspaceDir: onboardingTarget.workspaceDir,
      modelRouteVerified: liveModelVerified,
    });
    nextConfig = recommendationOutcome.config;
    commitAppRecommendationResult = recommendationOutcome.commitResult;
    const { setupPluginConfig } = await import("./setup.plugin-config.js");
    nextConfig = await setupPluginConfig({
      config: nextConfig,
      prompter,
      workspaceDir: onboardingTarget.workspaceDir,
    });
  }

  if (!opts.skipHooks) {
    const { enableDefaultOnboardingInternalHooks } = await import("../commands/onboard-hooks.js");
    nextConfig = enableDefaultOnboardingInternalHooks(nextConfig);
  }

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  nextConfig = await writeSetupConfigFile(nextConfig, {
    allowConfigSizeDrop: false,
  });
  onboardingTarget = resolveOnboardingSetupTarget(nextConfig);
  commitAppRecommendationResult?.();

  const { finalizeSetupWizard } = await import("./setup.finalize.js");
  const finalizeResult = await finalizeSetupWizard({
    flow: wizardFlow,
    opts,
    baseConfig,
    hadExistingConfig: snapshot.exists,
    nextConfig,
    workspaceDir: onboardingTarget.workspaceDir,
    settings: gateway.settings,
    prompter,
    runtime,
  });
  await acknowledgeMigrationPromotion?.();
  if (finalizeResult.launchedTui) {
    runtime.exit(0);
  }
}
