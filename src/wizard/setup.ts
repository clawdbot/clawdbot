import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import type { GatewayAuthChoice, OnboardMode, OnboardOptions } from "../commands/onboard-types.js";
import { resolveGatewayPort } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
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
import {
  detectSetupMigrationSources,
  listSetupMigrationOptions,
  runSetupMigrationImport,
} from "./setup.migration-import.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import {
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

function hasConfiguredDefaultModel(config: OpenClawConfig): boolean {
  return resolveAgentModelPrimaryValue(config.agents?.defaults?.model) !== undefined;
}

async function offerLiveModelVerification(params: {
  config: OpenClawConfig;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  writeConfig: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  required?: boolean;
}): Promise<{ config: OpenClawConfig; verified: boolean }> {
  if (!params.required) {
    const shouldTest = await params.prompter.confirm({
      message: t("wizard.setup.testAiAccess"),
      initialValue: true,
    });
    if (!shouldTest) {
      return { config: params.config, verified: false };
    }
  }
  const { verifySetupInferenceConfig } = await import("../system-agent/setup-inference.js");
  const verify = async (candidate: SetupModelAuthCandidate) => {
    const progress = params.prompter.progress(t("wizard.setup.testAiProgress"));
    const result = await withConsoleSubsystemsSuppressed(() =>
      verifySetupInferenceConfig({
        config: candidate.config,
        runtime: params.runtime,
        authProfiles: candidate.authProfiles,
      }),
    );
    progress.stop();
    if (result.ok) {
      await params.prompter.note(
        t("wizard.setup.testAiSuccess", { seconds: (result.latencyMs / 1000).toFixed(1) }),
        t("wizard.setup.testAiTitle"),
      );
    } else {
      await params.prompter.note(
        t("wizard.setup.testAiFailure", { reason: result.error }),
        t("wizard.setup.testAiTitle"),
      );
    }
    return result;
  };

  let candidate: SetupModelAuthCandidate = {
    config: params.config,
    authProfiles: [],
    persistAuthProfiles: async () => {},
  };
  let shouldPersistCandidate = false;
  while (true) {
    const result = await verify(candidate);
    if (result.ok) {
      if (!shouldPersistCandidate) {
        return { config: params.config, verified: true };
      }
      await candidate.persistAuthProfiles(result.authProfiles);
      const config = await params.writeConfig(candidate.config);
      return { config, verified: true };
    }
    if (result.authProfiles) {
      candidate.authProfiles = result.authProfiles;
    }
    if (
      !params.required &&
      (await params.prompter.select({
        message: t("wizard.setup.testAiFailureChoice"),
        options: [
          { value: "fix", label: t("wizard.setup.testAiFix") },
          { value: "continue", label: t("wizard.setup.testAiContinue") },
        ],
      })) === "continue"
    ) {
      return { config: params.config, verified: false };
    }

    // Attempts N>1 share the same gate and staged credentials until the user replaces them.
    candidate = await runSetupModelAuthStep({
      config: params.config,
      stagedCandidate: candidate,
      opts: { ...params.opts, authChoice: undefined },
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir: params.workspaceDir,
    });
    shouldPersistCandidate = true;
  }
}

function isSetupImportFlowChoice(flow: SetupFlowChoice): boolean {
  return flow === "import" || flow.startsWith("import:");
}

function resolveImportProviderFromFlowChoice(flow: SetupFlowChoice): string | undefined {
  return flow.startsWith("import:") ? flow.slice("import:".length) : undefined;
}

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
  opts: OnboardOptions,
  runtimeInput: RuntimeEnv | undefined,
  prompter: WizardPrompter,
) {
  let runtime = runtimeInput;
  runtime ??= defaultRuntime;
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  await onboardHelpers.printWizardHeader(runtime);
  await prompter.intro(t("wizard.setup.intro"));

  const snapshot = await readSetupConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid
    ? snapshot.exists
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {}
    : {};
  baseConfig = await requireRiskAcknowledgement({ opts, prompter, config: baseConfig });
  // Ordinary onboard reruns must preserve existing agents.list / bindings. Only
  // explicit reset or import flows are allowed to shrink the config — see issue
  // openclaw#84692.
  let pendingPluginInstallMigrationBaseConfig: OpenClawConfig | undefined = baseConfig;
  const writeSetupConfigFile = async (
    config: OpenClawConfig,
    optsLocal: { allowConfigSizeDrop?: boolean } = {},
  ) =>
    await writeWizardConfigFile(config, {
      ...optsLocal,
      migrationBaseConfig: pendingPluginInstallMigrationBaseConfig,
      onPendingPluginInstallMigration: () => {
        pendingPluginInstallMigrationBaseConfig = undefined;
      },
    });

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
  const hasExistingModelConfig = hasConfiguredDefaultModel(baseConfig);
  const migrationDetections = await detectSetupMigrationSources({ config: baseConfig, runtime });
  const migrationOptions = await listSetupMigrationOptions({
    baseConfig,
    detections: migrationDetections,
  });
  const importOptions = migrationOptions.map((option) => {
    const choice: { value: `import:${string}`; label: string; hint?: string } = {
      value: `import:${option.providerId}`,
      label: t("wizard.migration.importFrom", { source: option.label }),
    };
    if (option.hint) {
      choice.hint = option.hint;
    }
    return choice;
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
  let flow: SetupFlowChoice =
    explicitFlow ??
    (importIntent
      ? "import"
      : await prompter.select({
          message: t("wizard.setup.setupMode"),
          options: [
            ...(keepModelOption ? [keepModelOption] : []),
            { value: "quickstart", label: t("wizard.setup.flowQuickstart"), hint: quickstartHint },
            { value: "advanced", label: t("wizard.setup.flowAdvanced"), hint: manualHint },
            ...importOptions,
          ],
          initialValue: hasExistingModelConfig ? "keep-model" : "quickstart",
        }));

  let keepExistingModelConfig = flow === "keep-model";
  if (keepExistingModelConfig) {
    flow = "quickstart";
  }

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(t("wizard.setup.quickstartOnlyLocal"), t("wizard.setup.quickstartTitle"));
    flow = "advanced";
  }

  if (snapshot.exists && !keepExistingModelConfig) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      t("wizard.setup.existingConfigTitle"),
    );
  }

  const usedImportFlow = Boolean(opts.importFrom || isSetupImportFlowChoice(flow));
  if (usedImportFlow) {
    const importFrom = opts.importFrom ?? resolveImportProviderFromFlowChoice(flow);
    prompter.disableBackNavigation?.();
    await runSetupMigrationImport({
      opts: {
        ...opts,
        ...(importFrom ? { importFrom } : {}),
      },
      baseConfig,
      detections: migrationDetections,
      prompter,
      runtime,
      readConfigFile: readValidSetupConfigFile,
      commitConfigFile: (cfg) => writeWizardConfigFile(cfg, { allowConfigSizeDrop: true }),
      continueOnboarding: true,
    });
    const migratedSnapshot = await readSetupConfigFileSnapshot();
    if (!migratedSnapshot.valid) {
      throw new Error("Migration produced an invalid OpenClaw config. Run `openclaw doctor`.");
    }
    baseConfig = migratedSnapshot.sourceConfig ?? migratedSnapshot.config;
    pendingPluginInstallMigrationBaseConfig = baseConfig;
    keepExistingModelConfig ||= hasConfiguredDefaultModel(baseConfig);
    flow = "quickstart";
  }
  const wizardFlow: WizardFlow = flow === "advanced" ? "advanced" : "quickstart";

  const quickstartGateway: QuickstartGatewayDefaults = resolveQuickstartGatewayDefaults(baseConfig);

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return t("wizard.gateway.bindLoopback");
      }
      if (value === "lan") {
        return t("wizard.gateway.bindLan");
      }
      if (value === "custom") {
        return t("wizard.gateway.bindCustom");
      }
      if (value === "tailnet") {
        return t("wizard.gateway.bindTailnet");
      }
      return t("wizard.gateway.bindAuto");
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return t("wizard.setup.quickstartAuthTokenDefault");
      }
      return t("common.password");
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      return t(`wizard.gatewayTailscale.${value}`);
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          t("wizard.setup.quickstartKeepSettings"),
          t("wizard.setup.quickstartGatewayPort", { port: quickstartGateway.port }),
          t("wizard.setup.quickstartGatewayBind", { bind: formatBind(quickstartGateway.bind) }),
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [
                t("wizard.setup.quickstartGatewayCustomIp", {
                  host: quickstartGateway.customBindHost,
                }),
              ]
            : []),
          t("wizard.setup.quickstartGatewayAuth", {
            auth: formatAuth(quickstartGateway.authMode),
          }),
          t("wizard.setup.quickstartTailscaleExposure", {
            exposure: formatTailscale(quickstartGateway.tailscaleMode),
          }),
          t("wizard.setup.quickstartDirectChannels"),
        ]
      : [
          t("wizard.setup.quickstartGatewayPort", { port: quickstartGateway.port }),
          t("wizard.setup.quickstartGatewayBind", { bind: t("wizard.gateway.bindLoopback") }),
          t("wizard.setup.quickstartGatewayAuth", {
            auth: t("wizard.setup.quickstartAuthTokenDefault"),
          }),
          t("wizard.setup.quickstartTailscaleExposure", {
            exposure: t("wizard.gatewayTailscale.off"),
          }),
          t("wizard.setup.quickstartDirectChannels"),
        ];
    await prompter.note(quickstartLines.join("\n"), "QuickStart");
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const resolvedGatewayToken = await resolveSetupSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.token,
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
      value: baseConfig.gateway?.auth?.password,
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
  const remoteUrlChanged = opts.remoteUrl !== undefined && optionRemoteUrl !== storedRemoteUrl;
  const remoteSeedConfig: OpenClawConfig =
    opts.remoteUrl === undefined && opts.remoteToken === undefined
      ? baseConfig
      : {
          ...baseConfig,
          gateway: {
            ...baseConfig.gateway,
            remote: {
              ...baseConfig.gateway?.remote,
              ...(opts.remoteUrl !== undefined ? { url: optionRemoteUrl } : {}),
              ...(opts.remoteToken !== undefined
                ? { token: normalizeOptionalString(opts.remoteToken) }
                : remoteUrlChanged
                  ? { token: undefined }
                  : {}),
              ...(remoteUrlChanged ? { password: undefined } : {}),
            },
          },
        };
  const seededRemoteUrl = remoteSeedConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteOnboard = seededRemoteUrl ? await import("../commands/onboard-remote.js") : null;
  const remoteUrl =
    seededRemoteUrl && remoteOnboard?.validateGatewayWebSocketUrl(seededRemoteUrl) === undefined
      ? seededRemoteUrl
      : "";
  let remoteGatewayToken = normalizeSecretInputString(remoteSeedConfig.gateway?.remote?.token);
  try {
    const resolvedRemoteGatewayToken = await resolveSetupSecretInputString({
      config: remoteSeedConfig,
      value: remoteSeedConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
      env: process.env,
    });
    if (resolvedRemoteGatewayToken) {
      remoteGatewayToken = resolvedRemoteGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.remote.token SecretRef for setup probe.",
        formatErrorMessage(error),
      ].join("\n"),
      "Gateway auth",
    );
  }
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: remoteGatewayToken,
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
  const { workspaceDir, allowWorkspaceChange } = await resolveSetupWorkspaceSelection({
    baseConfig,
    requestedWorkspaceDir,
    prompter,
  });
  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(
    baseConfig,
    requestedWorkspaceDir,
    { allowWorkspaceChange },
  );
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }

  if (!keepExistingModelConfig) {
    const modelAuth = await runSetupModelAuthStep({
      config: nextConfig,
      opts,
      prompter,
      runtime,
      workspaceDir,
    });
    await modelAuth.persistAuthProfiles();
    nextConfig = modelAuth.config;
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
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  // Persist auth + gateway decisions now: channel/search/skills steps can pair
  // devices or install plugins, and a crash or cancel there must not force the
  // user to redo provider setup from scratch.
  nextConfig = await writeSetupConfigFile(nextConfig, {
    allowConfigSizeDrop: false,
  });

  let liveModelVerified = false;
  // keepExistingModelConfig is latched before auth setup, so this distinguishes
  // a route supplied by the import from one configured normally after the import.
  if (
    opts.nonInteractive !== true &&
    hasConfiguredDefaultModel(nextConfig) &&
    ((usedImportFlow && keepExistingModelConfig) || opts.authChoice !== "skip")
  ) {
    const verification = await offerLiveModelVerification({
      config: nextConfig,
      opts,
      prompter,
      runtime,
      workspaceDir,
      writeConfig: async (config) =>
        await writeSetupConfigFile(config, { allowConfigSizeDrop: false }),
      required: usedImportFlow && keepExistingModelConfig,
    });
    nextConfig = verification.config;
    liveModelVerified = verification.verified;
  }

  prompter.disableBackNavigation?.();
  if (opts.skipChannels) {
    await prompter.note(t("wizard.setup.skipChannels"), t("wizard.setup.channelsTitle"));
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { setupChannels } = await import("../commands/onboard-channels.js");
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
    });
  }

  nextConfig = await writeSetupConfigFile(nextConfig, {
    allowConfigSizeDrop: false,
  });
  const { logConfigUpdated } = await loadConfigLoggingModule();
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });

  if (!usedImportFlow) {
    const { runSetupMemoryImportStep } = await import("./setup.memory-import.js");
    await runSetupMemoryImportStep({ config: nextConfig, prompter, runtime });
  }

  if (opts.skipSearch) {
    await prompter.note(t("wizard.setup.skipSearch"), t("wizard.setup.searchTitle"));
  } else {
    const { setupSearch } = await import("../commands/onboard-search.js");
    nextConfig = await setupSearch(nextConfig, runtime, prompter, {
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  if (opts.skipSkills) {
    await prompter.note(t("wizard.setup.skipSkills"), t("wizard.setup.skillsTitle"));
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter, {
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
      workspaceDir,
    });
    const { setupAppRecommendations } = await import("./setup.app-recommendations.js");
    const recommendationOutcome = await setupAppRecommendations({
      config: nextConfig,
      prompter,
      runtime,
      workspaceDir,
      modelRouteVerified: liveModelVerified,
    });
    nextConfig = recommendationOutcome.config;
    commitAppRecommendationResult = recommendationOutcome.commitResult;
    const { setupPluginConfig } = await import("./setup.plugin-config.js");
    nextConfig = await setupPluginConfig({
      config: nextConfig,
      prompter,
      workspaceDir,
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
  commitAppRecommendationResult?.();

  const { finalizeSetupWizard } = await import("./setup.finalize.js");
  const finalizeResult = await finalizeSetupWizard({
    flow: wizardFlow,
    opts,
    baseConfig,
    hadExistingConfig: snapshot.exists,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (finalizeResult.launchedTui) {
    runtime.exit(0);
  }
}
