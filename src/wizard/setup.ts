import { normalizeProviderId } from "../agents/provider-id.js";
import { formatCliCommand } from "../cli/command-format.js";
import { commitConfigWriteWithPendingPluginInstalls } from "../cli/plugins-install-record-commit.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import { createConfigIO, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { detectSetupMigrationSources, runSetupMigrationImport } from "./setup.migration-import.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import {
  getSecurityConfirmMessage,
  getSecurityNoteMessage,
  getSecurityNoteTitle,
} from "./setup.security-note.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./setup.types.js";

type SetupFlowChoice = WizardFlow | "import";

type AuthChoiceModule = typeof import("../commands/auth-choice.js");
type ConfigLoggingModule = typeof import("../config/logging.js");
type ModelPickerModule = typeof import("../commands/model-picker.js");

let authChoiceModulePromise: Promise<AuthChoiceModule> | undefined;
let configLoggingModulePromise: Promise<ConfigLoggingModule> | undefined;
let modelPickerModulePromise: Promise<ModelPickerModule> | undefined;

function loadAuthChoiceModule(): Promise<AuthChoiceModule> {
  authChoiceModulePromise ??= import("../commands/auth-choice.js");
  return authChoiceModulePromise;
}

function loadConfigLoggingModule(): Promise<ConfigLoggingModule> {
  configLoggingModulePromise ??= import("../config/logging.js");
  return configLoggingModulePromise;
}

function loadModelPickerModule(): Promise<ModelPickerModule> {
  modelPickerModulePromise ??= import("../commands/model-picker.js");
  return modelPickerModulePromise;
}

async function writeWizardConfigFile(config: OpenClawConfig): Promise<OpenClawConfig> {
  const committed = await commitConfigWriteWithPendingPluginInstalls({
    nextConfig: config,
    commit: async (nextConfig, writeOptions) => {
      return await replaceConfigFile({
        nextConfig,
        writeOptions: { ...writeOptions, allowConfigSizeDrop: true },
        afterWrite: { mode: "auto" },
      });
    },
  });
  return committed.config;
}

async function readSetupConfigFileSnapshot() {
  return await createConfigIO({ pluginValidation: "skip" }).readConfigFileSnapshot();
}

async function resolveAuthChoiceModelSelectionPolicy(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolvePreferredProviderForAuthChoice: (params: {
    choice: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<string | undefined>;
}): Promise<{
  preferredProvider?: string;
  promptWhenAuthChoiceProvided: boolean;
  allowKeepCurrent: boolean;
}> {
  const preferredProvider = await params.resolvePreferredProviderForAuthChoice({
    choice: params.authChoice,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });

  const [{ resolveManifestProviderAuthChoice }, { resolvePluginSetupProvider }] = await Promise.all(
    [import("../plugins/provider-auth-choices.js"), import("../plugins/setup-registry.js")],
  );
  const manifestChoice = resolveManifestProviderAuthChoice(params.authChoice, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  if (manifestChoice) {
    const setupProvider = resolvePluginSetupProvider({
      provider: manifestChoice.providerId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: [manifestChoice.pluginId],
    });
    const setupMethod = setupProvider?.auth.find(
      (method) => normalizeProviderId(method.id) === normalizeProviderId(manifestChoice.methodId),
    );
    const setupPolicy =
      setupMethod?.wizard?.modelSelection ?? setupProvider?.wizard?.setup?.modelSelection;
    return {
      preferredProvider,
      promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
      allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
    };
  }

  const { resolvePluginProviders, resolveProviderPluginChoice } =
    await import("../plugins/provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const resolvedChoice = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  const matchedProvider =
    resolvedChoice?.provider ??
    (() => {
      const preferredId = preferredProvider?.trim();
      if (!preferredId) {
        return undefined;
      }
      return providers.find(
        (provider) => typeof provider.id === "string" && provider.id.trim() === preferredId,
      );
    })();
  const setupPolicy =
    resolvedChoice?.wizard?.modelSelection ?? matchedProvider?.wizard?.setup?.modelSelection;

  return {
    preferredProvider,
    promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
    allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
  };
}

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(getSecurityNoteMessage(), getSecurityNoteTitle());

  const ok = await params.prompter.confirm({
    message: getSecurityConfirmMessage(),
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError(t("wizard.setup.riskNotAccepted"));
  }
}

export async function runSetupWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv | undefined,
  prompter: WizardPrompter,
) {
  runtime ??= defaultRuntime;
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro(t("wizard.setup.intro"));
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readSetupConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid
    ? snapshot.exists
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {}
    : {};

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
  const migrationDetections = await detectSetupMigrationSources({ config: baseConfig, runtime });
  const firstMigrationDetection = migrationDetections[0];
  const importOption = firstMigrationDetection
    ? {
        value: "import" as const,
        label: `Import from ${firstMigrationDetection.label}`,
        ...(firstMigrationDetection.source ? { hint: firstMigrationDetection.source } : {}),
      }
    : undefined;
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
  let flow: SetupFlowChoice =
    explicitFlow ??
    (await prompter.select({
      message: t("wizard.setup.setupMode"),
      options: [
        { value: "quickstart", label: t("wizard.setup.flowQuickstart"), hint: quickstartHint },
        { value: "advanced", label: t("wizard.setup.flowAdvanced"), hint: manualHint },
        ...(importOption ? [importOption] : []),
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(t("wizard.setup.quickstartOnlyLocal"), t("wizard.setup.quickstartTitle"));
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      t("wizard.setup.existingConfigTitle"),
    );

    const action = await prompter.select({
      message: t("wizard.setup.configHandling"),
      options: [
        { value: "keep", label: t("wizard.setup.keepCurrent") },
        { value: "modify", label: t("wizard.setup.modifyCurrent") },
        { value: "reset", label: t("wizard.setup.resetBefore") },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: t("wizard.setup.resetScope"),
        options: [
          { value: "config", label: t("wizard.setup.resetConfig") },
          {
            value: "config+creds+sessions",
            label: t("wizard.setup.resetConfigCredsSessions"),
          },
          {
            value: "full",
            label: t("wizard.setup.resetFull"),
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    }
  }

  if (opts.importFrom || flow === "import") {
    await runSetupMigrationImport({
      opts,
      baseConfig,
      detections: migrationDetections,
      prompter,
      runtime,
      commitConfigFile: writeWizardConfigFile,
    });
    return;
  }
  const wizardFlow: WizardFlow = flow;

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

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
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  let remoteGatewayToken = normalizeSecretInputString(baseConfig.gateway?.remote?.token);
  try {
    const resolvedRemoteGatewayToken = await resolveSetupSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.remote?.token,
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
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { applySkipBootstrapConfig } = await import("../commands/onboard-config.js");
    const { logConfigUpdated } = await loadConfigLoggingModule();
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, {
      secretInputMode: opts.secretInputMode,
    });
    if (opts.skipBootstrap) {
      nextConfig = applySkipBootstrapConfig(nextConfig);
    }
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    nextConfig = await writeWizardConfigFile(nextConfig);
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

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } =
    await import("../commands/onboard-config.js");
  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }

  const authChoiceFromPrompt = opts.authChoice === undefined;
  let authChoice: AuthChoice | undefined = opts.authChoice;
  let authStore:
    | ReturnType<(typeof import("../agents/auth-profiles.runtime.js"))["ensureAuthProfileStore"]>
    | undefined;
  let promptAuthChoiceGrouped:
    | (typeof import("../commands/auth-choice-prompt.js"))["promptAuthChoiceGrouped"]
    | undefined;
  if (authChoiceFromPrompt) {
    const { ensureAuthProfileStore } = await import("../agents/auth-profiles.runtime.js");
    ({ promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js"));
    authStore = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
  }
  while (true) {
    if (authChoiceFromPrompt) {
      authChoice = await promptAuthChoiceGrouped!({
        prompter,
        store: authStore!,
        includeSkip: true,
        config: nextConfig,
        workspaceDir,
      });
    }
    if (authChoice === undefined) {
      throw new WizardCancelledError(t("wizard.setup.authChoiceRequired"));
    }

    if (authChoice === "custom-api-key") {
      const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
      const customResult = await promptCustomApiConfig({
        prompter,
        runtime,
        config: nextConfig,
        secretInputMode: opts.secretInputMode,
      });
      nextConfig = customResult.config;
      break;
    }
    if (authChoice === "skip") {
      // Explicit skip should stay cold: do not bootstrap auth/profile machinery
      // or run model/auth checks when the caller already chose to skip setup.
      if (authChoiceFromPrompt) {
        const { applyPrimaryModel, promptDefaultModel } = await loadModelPickerModule();
        const modelSelection = await promptDefaultModel({
          config: nextConfig,
          prompter,
          allowKeep: true,
          ignoreAllowlist: true,
          includeProviderPluginSetups: false,
          loadCatalog: false,
          workspaceDir,
          runtime,
        });
        if (modelSelection.config) {
          nextConfig = modelSelection.config;
        }
        if (modelSelection.model) {
          nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
        }

        const { warnIfModelConfigLooksOff } = await loadAuthChoiceModule();
        await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
      }
      break;
    }

    const [
      { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff },
      { applyPrimaryModel, promptDefaultModel },
    ] = await Promise.all([loadAuthChoiceModule(), loadModelPickerModule()]);
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        ...opts,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;
    if (authResult.retrySelection) {
      if (authChoiceFromPrompt) {
        continue;
      }
      break;
    }
    if (authResult.agentModelOverride) {
      nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
    }

    const authChoiceModelSelectionPolicy = await resolveAuthChoiceModelSelectionPolicy({
      authChoice,
      config: nextConfig,
      workspaceDir,
      resolvePreferredProviderForAuthChoice,
    });
    const shouldPromptModelSelection =
      authChoiceFromPrompt || authChoiceModelSelectionPolicy?.promptWhenAuthChoiceProvided;
    if (shouldPromptModelSelection) {
      const modelSelection = await promptDefaultModel({
        config: nextConfig,
        prompter,
        allowKeep: authChoiceModelSelectionPolicy?.allowKeepCurrent ?? true,
        ignoreAllowlist: true,
        includeProviderPluginSetups: true,
        preferredProvider: authChoiceModelSelectionPolicy?.preferredProvider,
        browseCatalogOnDemand: true,
        workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        nextConfig = modelSelection.config;
      }
      if (modelSelection.model) {
        nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
    break;
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

  if (opts.skipChannels ?? opts.skipProviders) {
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
      allowSignalInstall: true,
      deferStatusUntilSelection: flow === "quickstart",
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  nextConfig = await writeWizardConfigFile(nextConfig);
  const { logConfigUpdated } = await loadConfigLoggingModule();
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });

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
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Plugin configuration (sandbox backends, tool plugins, etc.)
  if (flow !== "quickstart") {
    const { setupOfficialPluginInstalls } = await import("./setup.official-plugins.js");
    nextConfig = await setupOfficialPluginInstalls({
      config: nextConfig,
      prompter,
      runtime,
      workspaceDir,
    });
    const { setupPluginConfig } = await import("./setup.plugin-config.js");
    nextConfig = await setupPluginConfig({
      config: nextConfig,
      prompter,
      workspaceDir,
    });
  }

  if (!opts.skipHooks) {
    // Setup hooks (session memory on /new)
    const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
    nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
  }

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  nextConfig = await writeWizardConfigFile(nextConfig);

  const { finalizeSetupWizard } = await import("./setup.finalize.js");
  const { launchedTui } = await finalizeSetupWizard({
    flow: wizardFlow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
