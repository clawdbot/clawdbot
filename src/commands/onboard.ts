/**
 * Top-level `openclaw onboard` command entrypoint.
 *
 * It validates global setup flags, performs optional reset handling, and then
 * routes to interactive or non-interactive onboarding.
 */
import { formatCliCommand } from "../cli/command-format.js";
import { formatInvalidPortOption } from "../cli/error-format.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";
import { formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { isGatewayDaemonRuntime } from "./daemon-runtime.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "./onboard-custom-config.js";
import { runGuidedOnboarding } from "./onboard-guided.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { runInteractiveSetup } from "./onboard-interactive.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { resolveNonInteractiveApiKey as resolveNonInteractiveCredential } from "./onboard-non-interactive/api-keys.js";
import { inferAuthChoiceFromFlags } from "./onboard-non-interactive/local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./onboard-non-interactive/local/gateway-config.js";
import { validateGatewayWebSocketUrl } from "./onboard-remote.js";
import {
  isNodeManagerChoice,
  isOnboardFlow,
  type OnboardOptions,
  type ResetScope,
} from "./onboard-types.js";

const VALID_RESET_SCOPES = new Set<ResetScope>(["config", "config+creds+sessions", "full"]);
const BUILT_IN_AUTH_CHOICES = ["setup-token", "token", "apiKey", "custom-api-key", "skip"];

function rejectOption(runtime: RuntimeEnv, message: string): false {
  runtime.error(message);
  runtime.exit(1);
  return false;
}

function validatePreflightOptions(opts: OnboardOptions, runtime: RuntimeEnv): boolean {
  if (opts.mode !== undefined && opts.mode !== "local" && opts.mode !== "remote") {
    return rejectOption(
      runtime,
      `Invalid --mode "${String(opts.mode)}". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
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
        runtime,
        `Invalid ${flag} ${JSON.stringify(value)}. Use ${allowed.map((choice) => JSON.stringify(choice)).join(", ")}.`,
      );
    }
  }
  if (opts.flow !== undefined && !isOnboardFlow(opts.flow)) {
    return rejectOption(
      runtime,
      'Invalid --flow. Use "quickstart", "advanced", "manual", or "import".',
    );
  }
  if (opts.daemonRuntime !== undefined && !isGatewayDaemonRuntime(opts.daemonRuntime)) {
    return rejectOption(runtime, 'Invalid --daemon-runtime. Use "node".');
  }
  if (opts.nodeManager !== undefined && !isNodeManagerChoice(opts.nodeManager)) {
    return rejectOption(runtime, 'Invalid --node-manager. Use "npm", "pnpm", or "bun".');
  }
  if (
    opts.gatewayPort !== undefined &&
    (!Number.isFinite(opts.gatewayPort) || opts.gatewayPort <= 0 || opts.gatewayPort > 65_535)
  ) {
    return rejectOption(runtime, formatInvalidPortOption("--gateway-port"));
  }
  if (opts.nonInteractive && opts.mode === "remote" && !opts.remoteUrl?.trim()) {
    return rejectOption(
      runtime,
      `Missing --remote-url for remote mode. Example: ${formatCliCommand("openclaw onboard --non-interactive --mode remote --remote-url ws://127.0.0.1:3000")}.`,
    );
  }
  if (opts.nonInteractive && opts.mode === "remote" && opts.remoteUrl?.trim()) {
    const remoteUrlError = validateGatewayWebSocketUrl(opts.remoteUrl);
    if (remoteUrlError) {
      return rejectOption(runtime, remoteUrlError);
    }
  }
  if (
    opts.nonInteractive &&
    (opts.flow === "import" || opts.importSource || opts.importSecrets) &&
    !opts.importFrom?.trim()
  ) {
    return rejectOption(
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
    params.opts.authChoice || !params.opts.nonInteractive
      ? undefined
      : inferAuthChoiceFromFlags(params.opts, {
          config: params.baseConfig,
          workspaceDir: params.workspaceDir,
          env: process.env,
        });
  if (inferredAuthChoice && inferredAuthChoice.matches.length > 1) {
    return rejectOption(
      params.runtime,
      [
        "Multiple API key flags were provided for non-interactive setup.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
  }
  const authChoice = params.opts.authChoice ?? inferredAuthChoice?.choice;
  if (!authChoice) {
    return true;
  }
  const availableChoices = new Set([
    ...BUILT_IN_AUTH_CHOICES,
    ...formatAuthChoiceChoicesForCli({
      includeLegacyAliases: true,
      includeSkip: true,
      config: params.baseConfig,
      workspaceDir: params.workspaceDir,
      env: process.env,
    }).split("|"),
  ]);
  if (!availableChoices.has(authChoice)) {
    return rejectOption(
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
  const isGenericProviderChoice =
    authChoice === "token" || authChoice === "setup-token" || authChoice === "apiKey";
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
      params.runtime,
      `Auth choice "${authChoice}" requires --token in non-interactive setup.`,
    );
  }
  if (params.opts.nonInteractive && isGenericProviderChoice && !providerAuthChoice) {
    return rejectOption(
      params.runtime,
      `Auth choice "${authChoice}" was not matched to provider "${params.opts.tokenProvider?.trim()}".`,
    );
  }
  if (params.opts.nonInteractive && authChoice === "custom-api-key") {
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
      return rejectOption(params.runtime, message);
    }
  }
  if (params.opts.nonInteractive && authChoice !== "custom-api-key" && authChoice !== "skip") {
    const runtimeProvider = providerAuthChoice
      ? resolveProviderMatch(
          resolvePluginProviders({
            config: params.baseConfig,
            workspaceDir: params.workspaceDir,
            mode: "setup",
            includeUntrustedWorkspacePlugins: false,
            bundledProviderVitestCompat: true,
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
      workspaceDir: params.workspaceDir,
      resolveApiKey: async (input) =>
        await resolveNonInteractiveCredential({
          ...input,
          cfg: params.baseConfig,
          runtime: params.runtime,
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
 * Boolean false and undefined mean "not passed" (Commander coerces unset
 * booleans to false); explicit `--no-install-daemon` arrives as `false` via
 * resolveInstallDaemonFlag and is special-cased. `--modern` never reaches this
 * dispatch; the command layer routes it through the inference-gated OpenClaw.
 */
const GUIDED_SAFE_ONBOARD_KEYS = new Set([
  "workspace",
  "acceptRisk",
  "reset",
  "resetScope",
  "nonInteractive",
  "classic",
  "tui",
]);

function wantsClassicInteractiveSetup(opts: OnboardOptions): boolean {
  if (opts.classic === true) {
    return true;
  }
  if (opts.installDaemon !== undefined) {
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
    runtime.error(
      formatDeprecatedNonInteractiveAuthChoiceError(originalAuthChoice, {
        env: process.env,
      })!,
    );
    runtime.exit(1);
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
  if (!validatePreflightOptions(normalizedOpts, runtime)) {
    return;
  }
  if (normalizedOpts.classic && normalizedOpts.nonInteractive) {
    runtime.error(
      "--classic cannot be combined with --non-interactive. Remove --non-interactive to open the classic wizard, or remove --classic for automated setup.",
    );
    runtime.exit(1);
    return;
  }
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" && // pragma: allowlist secret
    normalizedOpts.secretInputMode !== "ref" // pragma: allowlist secret
  ) {
    runtime.error(
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`,
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
    runtime.error(
      `Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`,
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    // Non-interactive setup can write credentials and daemon config without a
    // prompt, so the operator must acknowledge the security docs explicitly.
    runtime.error(
      [
        "Non-interactive setup requires explicit risk acknowledgement.",
        "Read: https://docs.openclaw.ai/security",
        `Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
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
      !snapshot.sourceConfig
    ) {
      rejectOption(
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
}
