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
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "../../auth-choice-legacy.js";
import { normalizeSecretInputModeInput } from "../../auth-choice.apply-helpers.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "../../auth-choice.apply.api-providers.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom-config.js";
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
}): Promise<OpenClawConfig | null> {
  const { opts, runtime, baseConfig } = params;
  let authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: opts.tokenProvider,
    config: params.nextConfig,
    env: process.env,
  });
  const nextConfig = params.nextConfig;
  const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
  if (opts.secretInputMode && !requestedSecretInputMode) {
    runtime.error(
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    runtime.exit(1);
    return null;
  }
  const toStoredSecretInput = (resolved: ResolvedNonInteractiveApiKey): SecretInput | null => {
    const storePlaintextSecret = requestedSecretInputMode !== "ref"; // pragma: allowlist secret
    if (storePlaintextSecret) {
      return resolved.key;
    }
    if (resolved.source !== "env") {
      return resolved.key;
    }
    if (!resolved.envVarName) {
      // Secret refs need a durable env-var id; provider auto-detection without
      // a concrete name cannot be serialized as a config reference.
      runtime.error(
        [
          `Unable to determine which environment variable to store as a ref for provider "${authChoice}".`,
          "Set an explicit provider env var and retry, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      runtime.exit(1);
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
      secretInputMode: requestedSecretInputMode,
    });
  const toApiKeyCredential = (paramsLocal: {
    provider: string;
    resolved: ResolvedNonInteractiveApiKey;
    email?: string;
    metadata?: Record<string, string>;
  }): ApiKeyCredential | null => {
    const storeSecretRef =
      requestedSecretInputMode === "ref" && paramsLocal.resolved.source === "env"; // pragma: allowlist secret
    if (storeSecretRef) {
      if (!paramsLocal.resolved.envVarName) {
        // Plugin profile credentials have the same secret-ref contract as core
        // provider config: the stored ref must name a specific env variable.
        runtime.error(
          [
            `--secret-input-mode ref requires an explicit environment variable for provider "${paramsLocal.provider}".`,
            "Set the provider API key env var and retry, or use --secret-input-mode plaintext.",
          ].join("\n"),
        );
        runtime.exit(1);
        return null;
      }
      return {
        type: "api_key",
        provider: paramsLocal.provider,
        keyRef: {
          source: "env",
          provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
            preferFirstProviderForSource: true,
          }),
          id: paramsLocal.resolved.envVarName,
        },
        ...(paramsLocal.email ? { email: paramsLocal.email } : {}),
        ...(paramsLocal.metadata ? { metadata: paramsLocal.metadata } : {}),
      };
    }
    return {
      type: "api_key",
      provider: paramsLocal.provider,
      key: paramsLocal.resolved.key,
      ...(paramsLocal.email ? { email: paramsLocal.email } : {}),
      ...(paramsLocal.metadata ? { metadata: paramsLocal.metadata } : {}),
    };
  };
  if (isDeprecatedAuthChoice(authChoice, { config: nextConfig, env: process.env })) {
    // Keep deprecated aliases out of the config by normalizing them before
    // either plugin dispatch or built-in setup handling.
    const replacement = resolveDeprecatedAuthChoiceReplacement(authChoice, {
      config: nextConfig,
      env: process.env,
    });
    if (replacement) {
      runtime.log(replacement.message);
      authChoice = replacement.normalized;
    } else {
      runtime.error(
        formatDeprecatedNonInteractiveAuthChoiceError(authChoice, {
          config: nextConfig,
          env: process.env,
        })!,
      );
      runtime.exit(1);
      return null;
    }
  }

  const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
    resolveApiKey: (input) =>
      resolveApiKey({
        ...input,
        cfg: baseConfig,
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
    runtime.error(
      [
        `Auth choice "${params.authChoice}" was not matched to a provider setup flow.`,
        'For Anthropic legacy token auth, use "--auth-choice setup-token --token-provider anthropic --token <token>" or pass "--auth-choice token --token-provider anthropic".',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice as string, {
    config: nextConfig,
    env: process.env,
  });
  if (deprecatedChoice) {
    runtime.error(
      `${JSON.stringify(authChoice as string)} is no longer supported. Use --auth-choice ${JSON.stringify(deprecatedChoice.choiceId)} instead.`,
    );
    runtime.exit(1);
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
        cfg: baseConfig,
        flagValue: customAuth.apiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime,
        required: false,
      });
      let customApiKeyInput: SecretInput | undefined;
      if (resolvedCustomApiKey) {
        const storeCustomApiKeyAsRef = requestedSecretInputMode === "ref"; // pragma: allowlist secret
        if (storeCustomApiKeyAsRef) {
          // Reuse the same SecretInput conversion as core providers so custom
          // endpoints preserve env-ref storage semantics.
          const stored = toStoredSecretInput(resolvedCustomApiKey);
          if (!stored) {
            return null;
          }
          customApiKeyInput = stored;
        } else {
          customApiKeyInput = resolvedCustomApiKey.key;
        }
      }
      const result = applyCustomApiConfig({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        modelId: customAuth.modelId,
        compatibility: customAuth.compatibility,
        apiKey: customApiKeyInput,
        providerId: customAuth.providerId,
        supportsImageInput: customAuth.supportsImageInput,
      });
      if (result.providerIdRenamedFrom && result.providerId) {
        runtime.log(
          `Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
        );
      }
      return result.config;
    } catch (err) {
      if (err instanceof CustomApiError) {
        switch (err.code) {
          case "missing_required":
          case "invalid_compatibility":
            runtime.error(err.message);
            break;
          default:
            runtime.error(`Invalid custom provider config: ${err.message}`);
            break;
        }
        runtime.exit(1);
        return null;
      }
      const reason = formatErrorMessage(err);
      runtime.error(`Invalid custom provider config: ${reason}`);
      runtime.exit(1);
      return null;
    }
  }

  if (
    authChoice === "oauth" ||
    authChoice === "chutes" ||
    authChoice === "minimax-global-oauth" ||
    authChoice === "minimax-cn-oauth"
  ) {
    runtime.error(
      authChoice === "oauth"
        ? 'Auth choice "oauth" is no longer supported directly. Use "--auth-choice setup-token --token-provider anthropic" for Anthropic legacy token auth, or a provider-specific OAuth choice.'
        : "OAuth requires interactive mode.",
    );
    runtime.exit(1);
    return null;
  }

  return nextConfig;
}
