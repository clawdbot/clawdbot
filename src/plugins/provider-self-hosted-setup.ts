import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import { CUSTOM_LOCAL_AUTH_MARKER, isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { parseConfiguredModelVisibilityEntries } from "../agents/model-selection-shared.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderNonInteractiveApiKeyResult,
} from "./types.js";

export {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";

export function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

function buildOpenAICompatibleSelfHostedProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  baseUrl: string;
  providerApiKey: string;
  modelId: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): { config: OpenClawConfig; modelRef: string; profileId: string } {
  const modelRef = `${params.providerId}/${params.modelId}`;
  const profileId = `${params.providerId}:default`;
  return {
    config: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        mode: params.cfg.models?.mode ?? "merge",
        providers: {
          ...params.cfg.models?.providers,
          [params.providerId]: {
            baseUrl: params.baseUrl,
            api: "openai-completions",
            apiKey: params.providerApiKey,
            models: [
              {
                id: params.modelId,
                name: params.modelId,
                reasoning: params.reasoning ?? false,
                input: params.input ?? ["text"],
                cost: SELF_HOSTED_DEFAULT_COST,
                contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
                maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
              },
            ],
          },
        },
      },
    },
    modelRef,
    profileId,
  };
}

type OpenAICompatibleSelfHostedProviderSetupParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export async function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<ProviderAuthResult> {
  const baseUrlRaw = await params.prompter.text({
    message: `${params.providerLabel} base URL`,
    initialValue: params.defaultBaseUrl,
    placeholder: params.defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: `${params.providerLabel} API key`,
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
    sensitive: true,
  });
  const modelIdRaw = await params.prompter.text({
    message: `${params.providerLabel} model`,
    placeholder: params.modelPlaceholder,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = (baseUrlRaw ?? "").trim().replace(/\/+$/, "");
  const apiKey = normalizeStringifiedOptionalString(apiKeyRaw) ?? "";
  const modelId = normalizeStringifiedOptionalString(modelIdRaw) ?? "";
  const credential: AuthProfileCredential = {
    type: "api_key",
    provider: params.providerId,
    key: apiKey,
  };
  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.cfg,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });

  return {
    profiles: [{ profileId: configured.profileId, credential }],
    configPatch: configured.config,
    defaultModel: configured.modelRef,
  };
}

export async function discoverOpenAICompatibleSelfHostedProvider<
  T extends Record<string, unknown>,
>(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: (params: { apiKey?: string; baseUrl?: string }) => Promise<T>;
}): Promise<{ provider: T & { apiKey: string } } | null> {
  const configuredProvider = findNormalizedProviderValue(
    params.ctx.config.models?.providers,
    params.providerId,
  );
  const configuredBaseUrl = configuredProvider
    ? normalizeOptionalString(configuredProvider.baseUrl)
    : undefined;
  if (configuredProvider) {
    const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.ctx.config });
    if (!visibility.providerWildcards.has(normalizeProviderId(params.providerId))) {
      return null;
    }
  }
  const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...(await params.buildProvider({
        apiKey: discoveryApiKey,
        ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
      })),
      apiKey,
    },
  };
}

function buildMissingNonInteractiveModelIdMessage(params: {
  authChoice: string;
  providerLabel: string;
  modelPlaceholder: string;
}): string {
  return [
    `Missing --custom-model-id for --auth-choice ${params.authChoice}.`,
    `Pass the ${params.providerLabel} model id to use, for example ${params.modelPlaceholder}.`,
  ].join("\n");
}

function isProviderOwnedSyntheticAuthMarker(
  providerId: string,
  resolved: ProviderNonInteractiveApiKeyResult,
): boolean {
  if (
    resolved.source !== "flag" ||
    !isNonSecretApiKeyMarker(resolved.key, { includeEnvVarName: false })
  ) {
    return false;
  }
  const normalizedProvider = normalizeProviderId(providerId);
  const matchesProvider = (provider: string) =>
    normalizeProviderId(provider) === normalizedProvider;
  const normalizedValue = resolved.key.trim();
  // A marker is only a keyless capability when its provider's own plugin declares it.
  return listOpenClawPluginManifestMetadata().some(
    ({ origin, manifest }) =>
      origin === "bundled" &&
      normalizeTrimmedStringList(manifest.providers).some(matchesProvider) &&
      normalizeTrimmedStringList(manifest.syntheticAuthRefs).some(matchesProvider) &&
      (normalizedValue === CUSTOM_LOCAL_AUTH_MARKER ||
        normalizeTrimmedStringList(manifest.nonSecretAuthMarkers).includes(normalizedValue)),
  );
}

export async function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<OpenClawConfig | null> {
  const baseUrl = (
    normalizeOptionalSecretInput(params.ctx.opts.customBaseUrl) ?? params.defaultBaseUrl
  ).replace(/\/+$/, "");
  const modelId = normalizeOptionalSecretInput(params.ctx.opts.customModelId);
  if (!modelId) {
    params.ctx.runtime.error(
      buildMissingNonInteractiveModelIdMessage({
        authChoice: params.ctx.authChoice,
        providerLabel: params.providerLabel,
        modelPlaceholder: params.modelPlaceholder,
      }),
    );
    params.ctx.runtime.exit(1);
    return null;
  }

  const resolved = await params.ctx.resolveApiKey({
    provider: params.providerId,
    flagValue: normalizeOptionalSecretInput(params.ctx.opts.customApiKey),
    flagName: "--custom-api-key",
    envVar: params.defaultApiKeyEnvVar,
    envVarName: params.defaultApiKeyEnvVar,
  });
  if (!resolved) {
    return null;
  }

  const usesSyntheticAuthMarker = isProviderOwnedSyntheticAuthMarker(params.providerId, resolved);
  const storesCredential = !usesSyntheticAuthMarker && resolved.source !== "profile";
  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.ctx.config,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });
  // Existing profiles own their credentials; recognized synthetic markers are
  // keyless capabilities. Neither should be serialized into a new auth profile.
  if (storesCredential) {
    const credential = params.ctx.toApiKeyCredential({
      provider: params.providerId,
      resolved,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLock({
      profileId: configured.profileId,
      credential,
      agentDir: params.ctx.agentDir,
    });
  }

  const withProfile = storesCredential
    ? applyAuthProfileConfig(configured.config, {
        profileId: configured.profileId,
        provider: params.providerId,
        mode: "api_key",
      })
    : configured.config;
  params.ctx.runtime.log(`Default ${params.providerLabel} model: ${modelId}`);
  return applyProviderDefaultModel(withProfile, configured.modelRef);
}
