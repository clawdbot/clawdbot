/**
 * Non-interactive local auth-choice dispatcher.
 *
 * It normalizes legacy choices, handles secret storage mode, delegates plugin
 * setup when applicable, and applies built-in custom provider config.
 */
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveManifestDeprecatedProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import { normalizeSecretInputModeInput } from "../../../plugins/provider-auth-input.js";
import { resolveDeprecatedProviderInstallCatalogEntry } from "../../../plugins/provider-install-catalog.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "../../auth-choice-legacy.js";
import { formatAuthChoiceChoicesForCli } from "../../auth-choice-options.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "../../auth-choice.apply.api-providers.js";
import type { OnboardingAgentTarget } from "../../onboard-agent-target.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom-config.js";
import { rejectOnboardingOption } from "../../onboard-options.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

type ResolvedNonInteractiveApiKey = NonNullable<
  Awaited<ReturnType<typeof resolveNonInteractiveApiKey>>
>;

/** Applies a local non-interactive auth choice to the pending OpenClaw config. */
export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  target: OnboardingAgentTarget;
}): Promise<OpenClawConfig | null> {
  const { opts, runtime, baseConfig } = params;
  let authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: opts.tokenProvider,
    config: params.nextConfig,
    workspaceDir: params.target.workspaceDir,
    env: process.env,
  });
  const nextConfig = params.nextConfig;
  const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
  if (opts.secretInputMode && !requestedSecretInputMode) {
    rejectOnboardingOption(
      opts,
      runtime,
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    return null;
  }
  const toStoredSecretInput = (paramsLocal: {
    resolved: ResolvedNonInteractiveApiKey;
    provider: string;
    envVarName?: string;
  }): SecretInput | null => {
    const { resolved } = paramsLocal;
    const storePlaintextSecret = requestedSecretInputMode !== "ref"; // pragma: allowlist secret
    if (storePlaintextSecret) {
      return resolved.key;
    }
    if (resolved.source !== "env" || !resolved.envVarName) {
      // Existing profiles may be reused, but neither serializer may turn their
      // resolved secret or a literal flag into plaintext when refs were requested.
      const envHint = paramsLocal.envVarName
        ? `Set ${paramsLocal.envVarName} in env and retry`
        : "Set the provider API key env var and retry";
      rejectOnboardingOption(
        opts,
        runtime,
        [
          `--secret-input-mode ref requires an explicit environment variable for provider "${paramsLocal.provider}".`,
          `${envHint}, or use --secret-input-mode plaintext.`,
        ].join("\n"),
      );
      return null;
    }
    return {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
        preferFirstProviderForSource: true,
      }),
      id: resolved.envVarName,
    };
  };
  const resolveApiKey = (input: Parameters<typeof resolveNonInteractiveApiKey>[0]) =>
    resolveNonInteractiveApiKey({
      ...input,
      agentDir: params.target.agentDir,
      workspaceDir: params.target.workspaceDir,
      secretInputMode: requestedSecretInputMode,
      json: opts.json,
    });
  const toApiKeyCredential = (paramsLocal: {
    provider: string;
    resolved: ResolvedNonInteractiveApiKey;
    email?: string;
    metadata?: Record<string, string>;
  }): ApiKeyCredential | null => {
    const stored = toStoredSecretInput({
      resolved: paramsLocal.resolved,
      provider: paramsLocal.provider,
    });
    if (!stored) {
      return null;
    }
    return {
      type: "api_key",
      provider: paramsLocal.provider,
      ...(typeof stored === "string" ? { key: stored } : { keyRef: stored }),
      ...(paramsLocal.email ? { email: paramsLocal.email } : {}),
      ...(paramsLocal.metadata ? { metadata: paramsLocal.metadata } : {}),
    };
  };
  if (
    isDeprecatedAuthChoice(authChoice, {
      config: nextConfig,
      workspaceDir: params.target.workspaceDir,
      env: process.env,
    })
  ) {
    // Keep deprecated aliases out of the config by normalizing them before
    // either plugin dispatch or built-in setup handling.
    const replacement = resolveDeprecatedAuthChoiceReplacement(authChoice, {
      config: nextConfig,
      workspaceDir: params.target.workspaceDir,
      env: process.env,
    });
    if (replacement) {
      runtime.log(replacement.message);
      authChoice = replacement.normalized;
    } else {
      rejectOnboardingOption(
        opts,
        runtime,
        formatDeprecatedNonInteractiveAuthChoiceError(authChoice, {
          config: nextConfig,
          workspaceDir: params.target.workspaceDir,
          env: process.env,
        })!,
      );
      return null;
    }
  }

  const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice as string, {
    config: nextConfig,
    workspaceDir: params.target.workspaceDir,
    env: process.env,
  });
  const deprecatedInstallChoice = deprecatedChoice
    ? undefined
    : resolveDeprecatedProviderInstallCatalogEntry(authChoice as string, {
        config: nextConfig,
        workspaceDir: params.target.workspaceDir,
        env: process.env,
        includeUntrustedWorkspacePlugins: false,
      });
  const replacementChoiceId = deprecatedChoice?.choiceId ?? deprecatedInstallChoice?.choiceId;
  if (replacementChoiceId) {
    rejectOnboardingOption(
      opts,
      runtime,
      `${JSON.stringify(authChoice as string)} is no longer supported. Use --auth-choice ${JSON.stringify(replacementChoiceId)} instead.`,
    );
    return null;
  }

  const validAuthChoices = formatAuthChoiceChoicesForCli({
    includeSkip: true,
    config: nextConfig,
    workspaceDir: params.target.workspaceDir,
    env: process.env,
  }).split("|");
  if (!validAuthChoices.includes(authChoice) && !authChoice.startsWith("provider-plugin:")) {
    rejectOnboardingOption(
      opts,
      runtime,
      `Unknown --auth-choice ${JSON.stringify(authChoice)}. Valid choices: ${validAuthChoices.join(", ")}.`,
    );
    return null;
  }

  const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
    target: params.target,
    resolveApiKey: (input) =>
      resolveApiKey({
        ...input,
        cfg: nextConfig,
        runtime,
      }),
    toApiKeyCredential,
  });
  if (pluginProviderChoice !== undefined) {
    // null means the plugin path handled an error and requested exit; undefined
    // means no trusted plugin matched and core choices should continue.
    return pluginProviderChoice;
  }

  if (authChoice === "setup-token" || authChoice === "token") {
    rejectOnboardingOption(
      opts,
      runtime,
      [
        `Auth choice "${params.authChoice}" was not matched to a provider setup flow.`,
        'For Anthropic legacy token auth, use "--auth-choice setup-token --token-provider anthropic --token <token>" or pass "--auth-choice token --token-provider anthropic".',
      ].join("\n"),
    );
    return null;
  }

  if (authChoice === "custom-api-key") {
    try {
      // Custom provider setup can be optional-key: some local endpoints do not
      // require auth, but flags and env refs still need validation if present.
      const customAuth = parseNonInteractiveCustomApiFlags({
        baseUrl: opts.customBaseUrl,
        modelId: opts.customModelId,
        compatibility: opts.customCompatibility,
        apiKey: opts.customApiKey,
        providerId: opts.customProviderId,
        supportsImageInput: opts.customImageInput,
      });
      const resolvedProviderId = resolveCustomProviderId({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        providerId: customAuth.providerId,
      });
      const resolvedCustomApiKey = await resolveApiKey({
        provider: resolvedProviderId.providerId,
        cfg: nextConfig,
        flagValue: customAuth.apiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime,
        required: false,
      });
      let customApiKeyInput: SecretInput | undefined;
      if (
        resolvedCustomApiKey &&
        (requestedSecretInputMode !== "ref" || resolvedCustomApiKey.source !== "profile")
      ) {
        // Profile ownership stays in the auth store; serializing its resolved
        // value would expose plaintext and overwrite an existing SecretRef.
        const stored = toStoredSecretInput({
          resolved: resolvedCustomApiKey,
          provider: resolvedProviderId.providerId,
          envVarName: "CUSTOM_API_KEY",
        });
        if (!stored) {
          return null;
        }
        customApiKeyInput = stored;
      }
      const result = applyCustomApiConfig({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        modelId: customAuth.modelId,
        compatibility: customAuth.compatibility,
        apiKey: customApiKeyInput,
        providerId: customAuth.providerId,
        supportsImageInput: customAuth.supportsImageInput,
        target: params.target,
      });
      if (result.providerIdRenamedFrom && result.providerId) {
        runtime.log(
          `Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
        );
      }
      return result.config;
    } catch (err) {
      const message =
        err instanceof CustomApiError &&
        (err.code === "missing_required" || err.code === "invalid_compatibility")
          ? err.message
          : `Invalid custom provider config: ${err instanceof CustomApiError ? err.message : formatErrorMessage(err)}`;
      rejectOnboardingOption(opts, runtime, message);
      return null;
    }
  }

  if (
    authChoice === "chutes" ||
    authChoice === "minimax-global-oauth" ||
    authChoice === "minimax-cn-oauth"
  ) {
    rejectOnboardingOption(opts, runtime, "OAuth requires interactive mode.");
    return null;
  }

  return nextConfig;
}
