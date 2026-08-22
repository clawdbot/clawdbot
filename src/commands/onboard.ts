/**
 * Top-level `openclaw onboard` command entrypoint.
 *
 * It validates global setup flags, performs optional reset handling, and then
 * routes to interactive or non-interactive onboarding.
 */
import { formatCliCommand } from "../cli/command-format.js";
import { formatInvalidPortOption } from "../cli/error-format.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidEnvSecretRefId } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { resolveProviderMatch } from "../plugins/provider-auth-choice-helpers.js";
import { resolvePluginProviders } from "../plugins/provider-auth-choice.runtime.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { normalizeTokenProviderInput } from "../plugins/provider-auth-input.js";
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import { withSetupMigrationTargetLock } from "../wizard/setup.migration-snapshot.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";
import { formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { GENERIC_PROVIDER_AUTH_CHOICES } from "./auth-choice-options.static.js";
import { isGatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveOnboardingSetupTarget } from "./onboard-agent-target.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "./onboard-custom-config.js";
import { runGuidedOnboarding } from "./onboard-guided.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { hasInteractiveOnboardingTty } from "./onboard-interactive-runner.js";
import { runInteractiveSetup } from "./onboard-interactive.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { resolveNonInteractiveApiKey as resolveNonInteractiveCredential } from "./onboard-non-interactive/api-keys.js";
import { inferAuthChoiceFromFlags } from "./onboard-non-interactive/local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./onboard-non-interactive/local/gateway-config.js";
import { rejectOnboardingOption as rejectOption } from "./onboard-options.js";
import { validateGatewayWebSocketUrl } from "./onboard-remote.js";
import {
  isNodeManagerChoice,
  isOnboardFlow,
  type OnboardOptions,
  type ResetScope,
} from "./onboard-types.js";

const VALID_RESET_SCOPES = new Set<ResetScope>(["config", "config+creds+sessions", "full"]);

function validatePreflightOptions(opts: OnboardOptions, runtime: RuntimeEnv): boolean {
  if (opts.mode !== undefined && opts.mode !== "local" && opts.mode !== "remote") {
    return rejectOption(
      opts,
      runtime,
      `Invalid --mode "${String(opts.mode)}". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
  }
  const remoteOnlyFlags = [
    opts.remoteUrl !== undefined ? "--remote-url" : undefined,
    opts.remoteToken !== undefined ? "--remote-token" : undefined,
    opts.remotePassword !== undefined ? "--remote-password" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (opts.nonInteractive && (opts.mode ?? "local") === "local" && remoteOnlyFlags.length > 0) {
    return rejectOption(
      opts,
      runtime,
      `${remoteOnlyFlags.join(" and ")} ${remoteOnlyFlags.length === 1 ? "requires" : "require"} --mode remote in non-interactive setup.`,
    );
  }
  for (const [flag, value] of [
    ["--remote-token", opts.remoteToken],
    ["--remote-password", opts.remotePassword],
  ] as const) {
    if (value !== undefined && !value.trim()) {
      return rejectOption(opts, runtime, `Invalid ${flag}: value cannot be empty.`);
    }
  }
  if (opts.remoteToken !== undefined && opts.remotePassword !== undefined) {
    return rejectOption(opts, runtime, "Use either --remote-token or --remote-password, not both.");
  }
  if (opts.mode === "remote") {
    const localGatewayCredentials = [
      ["--gateway-password", opts.gatewayPassword, "--remote-password"],
      ["--gateway-token", opts.gatewayToken, "--remote-token"],
      [
        "--gateway-token-ref-env",
        opts.gatewayTokenRefEnv,
        "--remote-token with --secret-input-mode ref",
      ],
    ] as const;
    for (const [flag, value, remoteFlag] of localGatewayCredentials) {
      if (value !== undefined) {
        return rejectOption(
          opts,
          runtime,
          `${flag} configures local gateway auth. Use ${remoteFlag} in remote mode.`,
        );
      }
    }
  }
  if (opts.nonInteractive && opts.secretInputMode === "ref") {
    const gatewayCredentials = [
      ["--gateway-password", opts.gatewayPassword, "OPENCLAW_GATEWAY_PASSWORD"],
      ["--remote-token", opts.remoteToken, "OPENCLAW_GATEWAY_TOKEN"],
      ["--remote-password", opts.remotePassword, "OPENCLAW_GATEWAY_PASSWORD"],
    ] as const;
    for (const [flag, value, envName] of gatewayCredentials) {
      if (value === undefined) {
        continue;
      }
      const envValue = process.env[envName]?.trim();
      if (!envValue) {
        return rejectOption(
          opts,
          runtime,
          `${flag} requires ${envName} to be set when --secret-input-mode ref is used.`,
        );
      }
      if (value.trim() !== envValue) {
        return rejectOption(
          opts,
          runtime,
          `${flag} does not match ${envName}. Set the environment variable to the same value or omit the flag.`,
        );
      }
    }
  }
  const choiceValidations: Array<readonly [string, string | undefined, readonly string[]]> = [
    ["--gateway-bind", opts.gatewayBind, ["loopback", "tailnet", "lan", "auto", "custom"]],
    ["--gateway-auth", opts.gatewayAuth, ["token", "password"]],
    ["--tailscale", opts.tailscale, ["off", "serve", "funnel"]],
    [
      "--custom-compatibility",
      opts.customCompatibility,
      ["openai", "openai-responses", "anthropic"],
    ],
  ];
  for (const [flag, value, allowed] of choiceValidations) {
    if (value !== undefined && !allowed.includes(value)) {
      return rejectOption(
        opts,
        runtime,
        `Invalid ${flag} ${JSON.stringify(value)}. Use ${allowed.map((choice) => JSON.stringify(choice)).join(", ")}.`,
      );
    }
  }
  if (opts.flow !== undefined && !isOnboardFlow(opts.flow)) {
    return rejectOption(
      opts,
      runtime,
      'Invalid --flow. Use "quickstart", "advanced", "manual", or "import".',
    );
  }
  if (opts.daemonRuntime !== undefined && !isGatewayDaemonRuntime(opts.daemonRuntime)) {
    return rejectOption(opts, runtime, 'Invalid --daemon-runtime. Use "node".');
  }
  if (opts.nodeManager !== undefined && !isNodeManagerChoice(opts.nodeManager)) {
    return rejectOption(opts, runtime, 'Invalid --node-manager. Use "npm", "pnpm", or "bun".');
  }
  if (
    opts.gatewayPort !== undefined &&
    (!Number.isFinite(opts.gatewayPort) || opts.gatewayPort <= 0 || opts.gatewayPort > 65_535)
  ) {
    return rejectOption(opts, runtime, formatInvalidPortOption("--gateway-port"));
  }
  if (opts.gatewayTokenRefEnv !== undefined) {
    const gatewayTokenRefEnv = opts.gatewayTokenRefEnv.trim();
    if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
      return rejectOption(
        opts,
        runtime,
        "Invalid --gateway-token-ref-env. Use an environment variable name like OPENCLAW_GATEWAY_TOKEN.",
      );
    }
    if (opts.gatewayToken !== undefined) {
      return rejectOption(
        opts,
        runtime,
        "Use either --gateway-token or --gateway-token-ref-env, not both. Prefer --gateway-token-ref-env to avoid writing plaintext tokens.",
      );
    }
    if (!process.env[gatewayTokenRefEnv]?.trim()) {
      return rejectOption(
        opts,
        runtime,
        `Environment variable "${gatewayTokenRefEnv}" is missing or empty. Export it first, then rerun ${formatCliCommand("openclaw onboard")}.`,
      );
    }
  }
  if (opts.nonInteractive && opts.mode === "remote" && !opts.remoteUrl?.trim()) {
    return rejectOption(
      opts,
      runtime,
      `Missing --remote-url for remote mode. Example: ${formatCliCommand("openclaw onboard --non-interactive --mode remote --remote-url ws://127.0.0.1:3000")}.`,
    );
  }
  if (opts.nonInteractive && opts.mode === "remote" && opts.remoteUrl?.trim()) {
    const remoteUrlError = validateGatewayWebSocketUrl(opts.remoteUrl);
    if (remoteUrlError) {
      return rejectOption(opts, runtime, remoteUrlError);
    }
  }
  if (
    opts.nonInteractive &&
    (opts.flow === "import" || opts.importSource || opts.importSecrets) &&
    !opts.importFrom?.trim()
  ) {
    return rejectOption(
      opts,
      runtime,
      `--import-from is required for non-interactive migration import. Run ${formatCliCommand("openclaw migrate list")} to choose a provider.`,
    );
  }
  return true;
}

async function validateResetAuthChoice(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  workspaceDir: string;
  resetScope: ResetScope;
}): Promise<boolean> {
  const inferredAuthChoice =
    params.opts.authChoice ||
    params.opts.mode === "remote" ||
    (!params.opts.nonInteractive && !wantsClassicInteractiveSetup(params.opts))
      ? undefined
      : inferAuthChoiceFromFlags(params.opts, {
          config: params.baseConfig,
          workspaceDir: params.workspaceDir,
          env: process.env,
        });
  if (inferredAuthChoice && inferredAuthChoice.matches.length > 1) {
    return rejectOption(
      params.opts,
      params.runtime,
      [
        `Multiple ${params.opts.nonInteractive ? "API key" : "provider credential"} flags were provided for ${params.opts.nonInteractive ? "non-interactive" : "interactive"} setup.`,
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
  }
  if (!params.opts.nonInteractive && inferredAuthChoice) {
    return true;
  }
  const authChoice = params.opts.authChoice ?? inferredAuthChoice?.choice;
  if (!authChoice) {
    return true;
  }
  const availableChoices = new Set(
    formatAuthChoiceChoicesForCli({
      includeSkip: true,
      config: params.baseConfig,
      workspaceDir: params.workspaceDir,
      env: process.env,
    }).split("|"),
  );
  if (!availableChoices.has(authChoice)) {
    return rejectOption(
      params.opts,
      params.runtime,
      `Auth choice "${authChoice}" was not matched to a provider setup flow. Run ${formatCliCommand("openclaw onboard")} to choose interactively.`,
    );
  }
  const providerAuthChoices: Array<ProviderAuthChoiceMetadata & { providerAliases?: string[] }> = [
    ...resolveManifestProviderAuthChoices({
      config: params.baseConfig,
      workspaceDir: params.workspaceDir,
      env: process.env,
      includeUntrustedWorkspacePlugins: false,
    }),
    ...resolveProviderInstallCatalogEntries({
      config: params.baseConfig,
      workspaceDir: params.workspaceDir,
      env: process.env,
      includeUntrustedWorkspacePlugins: false,
    }),
  ];
  const isGenericProviderChoice = GENERIC_PROVIDER_AUTH_CHOICES.includes(authChoice);
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts.tokenProvider);
  const inferredOptionKey = inferredAuthChoice?.matches[0]?.optionKey;
  const providerAuthChoice = isGenericProviderChoice
    ? providerAuthChoices.find((choice) => {
        const providerMatches = normalizedTokenProvider
          ? normalizeTokenProviderInput(choice.providerId) === normalizedTokenProvider ||
            choice.providerAliases?.some(
              (alias) => normalizeTokenProviderInput(alias) === normalizedTokenProvider,
            )
          : inferredOptionKey !== undefined && choice.optionKey === inferredOptionKey;
        const methodId = choice.methodId.toLowerCase();
        const supportsAuthKind =
          authChoice === "apiKey"
            ? methodId.includes("api") && methodId.includes("key")
            : authChoice === "setup-token"
              ? methodId === "setup-token"
              : methodId.includes("token");
        return providerMatches && supportsAuthKind;
      })
    : providerAuthChoices.find((choice) => choice.choiceId === authChoice);
  if (
    params.opts.nonInteractive &&
    isGenericProviderChoice &&
    !normalizedTokenProvider &&
    !inferredOptionKey
  ) {
    return rejectOption(
      params.opts,
      params.runtime,
      `Auth choice "${authChoice}" requires --token-provider in non-interactive setup.`,
    );
  }
  if (
    params.opts.nonInteractive &&
    (authChoice === "token" || authChoice === "setup-token") &&
    !params.opts.token?.trim()
  ) {
    return rejectOption(
      params.opts,
      params.runtime,
      `Auth choice "${authChoice}" requires --token in non-interactive setup.`,
    );
  }
  if (params.opts.nonInteractive && isGenericProviderChoice && !providerAuthChoice) {
    return rejectOption(
      params.opts,
      params.runtime,
      `Auth choice "${authChoice}" was not matched to provider "${params.opts.tokenProvider?.trim()}".`,
    );
  }
  if (!params.opts.nonInteractive || authChoice === "skip") {
    return true;
  }
  const target = resolveOnboardingSetupTarget(
    params.baseConfig,
    params.opts.agentName
      ? { name: params.opts.agentName, workspaceDir: params.workspaceDir }
      : undefined,
  );
  if (authChoice === "custom-api-key") {
    try {
      const custom = parseNonInteractiveCustomApiFlags({
        baseUrl: params.opts.customBaseUrl,
        modelId: params.opts.customModelId,
        compatibility: params.opts.customCompatibility,
        apiKey: undefined,
        providerId: params.opts.customProviderId,
        supportsImageInput: params.opts.customImageInput,
      });
      const customProviderId = resolveCustomProviderId({
        config: params.baseConfig,
        baseUrl: custom.baseUrl,
        providerId: custom.providerId,
      }).providerId;
      const customCredential = await resolveNonInteractiveCredential({
        provider: customProviderId,
        cfg: params.baseConfig,
        flagValue: params.opts.customApiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        runtime: params.runtime,
        agentDir: target.agentDir,
        workspaceDir: params.workspaceDir,
        allowProfile: params.resetScope === "config",
        required: false,
        secretInputMode: params.opts.secretInputMode,
      });
      if (params.opts.customApiKey?.trim() && !customCredential) {
        return false;
      }
      applyCustomApiConfig({
        config: params.baseConfig,
        baseUrl: custom.baseUrl,
        modelId: custom.modelId,
        compatibility: custom.compatibility,
        apiKey: undefined,
        providerId: custom.providerId,
        supportsImageInput: custom.supportsImageInput,
      });
    } catch (error) {
      const message =
        error instanceof CustomApiError &&
        (error.code === "missing_required" || error.code === "invalid_compatibility")
          ? error.message
          : `Invalid custom provider config: ${formatErrorMessage(error)}`;
      return rejectOption(params.opts, params.runtime, message);
    }
  }
  if (authChoice !== "custom-api-key") {
    const runtimeProvider = providerAuthChoice
      ? resolveProviderMatch(
          resolvePluginProviders({
            config: params.baseConfig,
            workspaceDir: params.workspaceDir,
            mode: "setup",
            includeUntrustedWorkspacePlugins: false,
            providerRefs: [providerAuthChoice.providerId],
            activate: true,
          }),
          providerAuthChoice.providerId,
        )
      : null;
    const runtimeMethod = runtimeProvider?.auth.find(
      (method) =>
        method.id === providerAuthChoice?.methodId ||
        method.wizard?.choiceId === providerAuthChoice?.choiceId,
    );
    if (!runtimeMethod?.runNonInteractive || !runtimeMethod.validateNonInteractive) {
      const reason = !runtimeMethod
        ? "provider unavailable"
        : !runtimeMethod.runNonInteractive
          ? "non-interactive setup unsupported"
          : "reset validation unavailable";
      return rejectOption(
        params.opts,
        params.runtime,
        `Auth choice "${authChoice}" cannot be safely preflighted with --reset (${reason}). Choose a provider method that supports non-interactive reset validation, or run setup without --reset.`,
      );
    }
    const valid = await runtimeMethod.validateNonInteractive({
      authChoice,
      config: params.baseConfig,
      baseConfig: params.baseConfig,
      opts: params.opts,
      runtime: params.runtime,
      agentDir: target.agentDir,
      workspaceDir: params.workspaceDir,
      resolveApiKey: async (input) =>
        await resolveNonInteractiveCredential({
          ...input,
          cfg: params.baseConfig,
          runtime: params.runtime,
          agentDir: target.agentDir,
          workspaceDir: params.workspaceDir,
          allowProfile: input.allowProfile === false ? false : params.resetScope === "config",
          secretInputMode: params.opts.secretInputMode,
        }),
    });
    if (!valid) {
      return false;
    }
  }
  return true;
}

function validateResetMigrationImport(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}): boolean {
  if (
    !params.opts.importFrom &&
    !params.opts.importSource &&
    !params.opts.importSecrets &&
    params.opts.flow !== "import"
  ) {
    return true;
  }
  return rejectOption(
    params.opts,
    params.runtime,
    "Migration import cannot be combined with --reset because provider input must be planned before any state is removed. Run the import without --reset.",
  );
}

function validateResetNonInteractiveGateway(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}): boolean {
  if (!params.opts.nonInteractive || (params.opts.mode ?? "local") === "remote") {
    return true;
  }
  return Boolean(
    applyNonInteractiveGatewayConfig({
      nextConfig: params.baseConfig,
      opts: params.opts,
      runtime: params.runtime,
      defaultPort: resolveGatewayPort(params.baseConfig),
    }),
  );
}

/**
 * Interactive onboarding defaults to guided setup. Any explicit
 * setup flag beyond this allowlist keeps the classic wizard — those flags are
 * a public automation contract and guided setup does not honor them.
 * Most false booleans mean "not passed" because the command layer normalizes
 * them with Boolean(). False-valued explicit choices preserve undefined when
 * omitted, so daemon, Tailscale-reset, and custom-model input overrides are
 * special-cased. `--modern` never reaches this dispatch; the command layer
 * routes it through the inference-gated OpenClaw.
 */
const GUIDED_SAFE_ONBOARD_KEYS = new Set([
  "workspace",
  "acceptRisk",
  "reset",
  "resetScope",
  "nonInteractive",
  "agentName",
  "tui",
  "skipUi",
  "suppressGatewayTokenOutput",
]);

function wantsClassicInteractiveSetup(opts: OnboardOptions): boolean {
  if (opts.classic === true) {
    return true;
  }
  if (opts.installDaemon !== undefined || opts.customImageInput !== undefined) {
    return true;
  }
  for (const [key, value] of Object.entries(opts)) {
    if (GUIDED_SAFE_ONBOARD_KEYS.has(key) || key === "installDaemon") {
      continue;
    }
    if (value === undefined || value === false) {
      continue;
    }
    return true;
  }
  return false;
}

/** Runs the onboard command after normalizing legacy flags and setup mode. */
export async function setupWizardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice, {
    env: process.env,
  });
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    // Non-interactive output must be deterministic; reject deprecated aliases
    // instead of printing prompts or compatibility guidance mid-flow.
    rejectOption(
      opts,
      runtime,
      formatDeprecatedNonInteractiveAuthChoiceError(originalAuthChoice, {
        env: process.env,
      })!,
    );
    return;
  }
  if (isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    runtime.log(
      resolveDeprecatedAuthChoiceReplacement(originalAuthChoice, { env: process.env })!.message,
    );
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  if (normalizedOpts.agentName !== undefined) {
    const { validateFirstOnboardingAgentName } = await import("./onboard-agent.js");
    const error = validateFirstOnboardingAgentName(normalizedOpts.agentName);
    if (error) {
      rejectOption(normalizedOpts, runtime, `Invalid --agent-name: ${error}`);
      return;
    }
  }
  if (!validatePreflightOptions(normalizedOpts, runtime)) {
    return;
  }
  if (normalizedOpts.classic && normalizedOpts.nonInteractive) {
    rejectOption(
      normalizedOpts,
      runtime,
      "--classic cannot be combined with --non-interactive. Remove --non-interactive to open the classic wizard, or remove --classic for automated setup.",
    );
    return;
  }
  if (normalizedOpts.tui && normalizedOpts.nonInteractive) {
    rejectOption(
      normalizedOpts,
      runtime,
      "--tui cannot be combined with --non-interactive. Remove --tui for automation, or remove --non-interactive to open the terminal hatch.",
    );
    return;
  }
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" && // pragma: allowlist secret
    normalizedOpts.secretInputMode !== "ref" // pragma: allowlist secret
  ) {
    rejectOption(
      normalizedOpts,
      runtime,
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`,
    );
    return;
  }

  if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
    rejectOption(
      normalizedOpts,
      runtime,
      `Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`,
    );
    return;
  }
  if (normalizedOpts.resetScope && !normalizedOpts.reset) {
    rejectOption(
      normalizedOpts,
      runtime,
      `--reset-scope requires --reset. Re-run with ${formatCliCommand(`openclaw onboard --reset --reset-scope ${normalizedOpts.resetScope}`)}.`,
    );
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    // Non-interactive setup can write credentials and daemon config without a
    // prompt, so the operator must acknowledge the security docs explicitly.
    rejectOption(
      normalizedOpts,
      runtime,
      [
        "Non-interactive setup requires explicit risk acknowledgement.",
        "Read: https://docs.openclaw.ai/security",
        `Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    return;
  }

  if (!normalizedOpts.nonInteractive && !hasInteractiveOnboardingTty()) {
    // Reset is destructive, so prove the selected interactive surface can run
    // before reading or moving any operator state.
    runtime.error(t("wizard.guided.ttyRequired"));
    runtime.exit(1);
    return;
  }

  if (process.platform === "win32") {
    runtime.log(
      [
        "Windows detected - OpenClaw runs great on WSL2!",
        "Native Windows might be trickier.",
        "Quick setup: wsl --install (one command, one reboot)",
        "Guide: https://docs.openclaw.ai/windows",
      ].join("\n"),
    );
  }

  const runSetup = normalizedOpts.nonInteractive
    ? runNonInteractiveSetup
    : wantsClassicInteractiveSetup(normalizedOpts)
      ? runInteractiveSetup
      : runGuidedOnboarding;

  const runSetupAfterOptionalReset = async () => {
    if (normalizedOpts.reset) {
      const snapshot = await readConfigFileSnapshot();
      const baseConfig = snapshot.sourceConfig ?? (snapshot.valid ? snapshot.config : {});
      const resetScope: ResetScope = normalizedOpts.resetScope ?? "config+creds+sessions";
      // Every reset scope removes the config file. Validate setup against the
      // empty config and requested/default workspace that dispatch will see.
      const setupBaseConfig: OpenClawConfig = {};
      const setupWorkspaceDir = resolveUserPath(normalizedOpts.workspace ?? DEFAULT_WORKSPACE);
      const configuredWorkspace: unknown =
        normalizedOpts.workspace ?? baseConfig.agents?.defaults?.workspace;
      if (
        resetScope === "full" &&
        normalizedOpts.workspace === undefined &&
        snapshot.exists &&
        !snapshot.valid &&
        // A snapshot always carries a sourceConfig object (empty on failure), so
        // only readError distinguishes "config could not be read" from "config
        // parsed but configures no workspace", where the default is correct.
        snapshot.readError !== undefined
      ) {
        rejectOption(
          normalizedOpts,
          runtime,
          "Cannot determine the configured workspace from an unreadable config. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
        );
        return;
      }
      if (
        resetScope === "full" &&
        configuredWorkspace !== undefined &&
        (typeof configuredWorkspace !== "string" || !configuredWorkspace.trim())
      ) {
        rejectOption(
          normalizedOpts,
          runtime,
          "Configured workspace is invalid. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
        );
        return;
      }
      // Non-full scopes never touch the workspace, so the fallback is only an
      // inert handleReset argument when an invalid config contains bad data.
      const workspaceDir = resolveUserPath(
        typeof configuredWorkspace === "string" && configuredWorkspace.trim()
          ? configuredWorkspace
          : DEFAULT_WORKSPACE,
      );
      if (
        !(await validateResetAuthChoice({
          opts: normalizedOpts,
          runtime,
          baseConfig: setupBaseConfig,
          workspaceDir: setupWorkspaceDir,
          resetScope,
        }))
      ) {
        return;
      }
      if (
        !validateResetNonInteractiveGateway({
          opts: normalizedOpts,
          runtime,
          baseConfig: setupBaseConfig,
        })
      ) {
        return;
      }
      if (!validateResetMigrationImport({ opts: normalizedOpts, runtime })) {
        return;
      }
      // Reset is deliberately the final pre-dispatch step: no rejectable option
      // checks may run after user state has moved to Trash.
      await handleReset(resetScope, workspaceDir, runtime);
    }

    await runSetup(normalizedOpts, runtime);
  };
  await withSetupMigrationTargetLock(resolveStateDir(), runSetupAfterOptionalReset);
}
