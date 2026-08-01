/**
 * Resolves CLI runtime aliases to provider/model auth labels and execution ids.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isCliRuntimeModelBackendForProvider,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli"]);

/** True for retired provider ids that should stay out of model selection surfaces. */
export function isRetiredModelPickerProvider(provider: string): boolean {
  return RETIRED_MODEL_PICKER_PROVIDERS.has(normalizeProviderId(provider));
}

/** Creates a provider visibility predicate for model picker rendering. */
export function createModelPickerVisibleProviderPredicate(
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): (provider: string) => boolean {
  const cliRuntimeProviders = new Set(
    listCliRuntimeProviderIds({
      config: params.config,
      env: params.env,
      includeSetupRegistry: params.includeSetupRegistry ?? false,
    }),
  );
  return (provider: string): boolean => {
    const normalized = normalizeProviderId(provider);
    return !isRetiredModelPickerProvider(normalized) && !cliRuntimeProviders.has(normalized);
  };
}

/** True for CLI runtime provider ids such as `claude-cli` and `google-gemini-cli`. */
export function isCliRuntimeProvider(
  provider: string,
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): boolean {
  const normalized = normalizeProviderId(provider);
  return listCliRuntimeProviderIds({
    config: params.config,
    env: params.env,
    includeSetupRegistry:
      params.includeSetupRegistry ?? (params.config !== undefined || params.env !== undefined),
  }).includes(normalized);
}

export function isCliRuntimeAlias(runtime: string | undefined): boolean {
  const normalized = normalizeProviderId(runtime ?? "");
  return normalized
    ? listCliRuntimeModelBackendBindings().some((binding) => binding.runtime === normalized)
    : false;
}

export function isCliRuntimeAliasForProvider(params: {
  runtime: string | undefined;
  provider: string | undefined;
  cfg?: OpenClawConfig;
}): boolean {
  return isCliRuntimeModelBackendForProvider({
    provider: params.provider,
    runtime: params.runtime,
    config: params.cfg,
  });
}

type RuntimeAliasComparisonOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
};

function canonicalizeRuntimeAliasProvider(
  provider: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  return (
    resolveCliRuntimeCanonicalProvider({
      runtime: provider,
      config: options.config,
      env: options.env,
      includeSetupRegistry:
        options.includeSetupRegistry ?? (options.config !== undefined || options.env !== undefined),
    }) ?? provider
  );
}

function normalizeRuntimeModelRefForComparison(
  raw: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(canonicalizeRuntimeAliasProvider(trimmed, options));
  }
  const canonicalProvider = normalizeProviderId(
    canonicalizeRuntimeAliasProvider(parsed.provider, options),
  );
  return `${canonicalProvider}/${parsed.modelId}`;
}

function normalizeRuntimeModelRefWithoutAlias(raw: string): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(trimmed);
  }
  return `${parsed.provider}/${parsed.modelId}`;
}

export function areRuntimeModelRefsEquivalent(
  left: string,
  right: string,
  options: RuntimeAliasComparisonOptions = {},
): boolean {
  if (normalizeRuntimeModelRefWithoutAlias(left) === normalizeRuntimeModelRefWithoutAlias(right)) {
    return true;
  }
  return (
    normalizeRuntimeModelRefForComparison(left, options) ===
    normalizeRuntimeModelRefForComparison(right, options)
  );
}

export function shouldPreferActiveRuntimeAliasAuthLabel(params: {
  runtimeAliasModelEquivalent: boolean;
  selectedAuthLabel?: string;
  activeAuthLabel?: string;
}): boolean {
  if (!params.runtimeAliasModelEquivalent) {
    return false;
  }
  const selectedAuth = normalizeOptionalLowercaseString(params.selectedAuthLabel);
  const activeAuth = normalizeOptionalLowercaseString(params.activeAuthLabel);
  if (!activeAuth || activeAuth === "unknown") {
    return false;
  }
  return (
    selectedAuth === "unknown" ||
    (Boolean(selectedAuth?.startsWith("api-key")) &&
      (activeAuth.startsWith("oauth") || activeAuth.startsWith("token")))
  );
}

function resolveConfiguredRuntime(params: {
  cfg?: OpenClawConfig;
  provider: string;
  agentId?: string;
  modelId?: string;
}): { runtime?: string; matchedProvider?: string } {
  const policy = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  return {
    runtime: policy.policy?.id?.trim() || undefined,
    matchedProvider: policy.matchedProvider,
  };
}

function resolveProfileRuntimeAlias(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId: string;
}): string | undefined {
  const profile = params.cfg?.auth?.profiles?.[params.profileId];
  if (!profile?.provider) {
    return undefined;
  }
  const provider = normalizeProviderId(params.provider);
  const profileProvider = normalizeProviderId(profile.provider);
  if (!provider || !profileProvider) {
    return undefined;
  }
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const profileAuthKey = resolveProviderIdForAuth(profileProvider, { config: params.cfg });
  if (providerAuthKey !== profileAuthKey) {
    return undefined;
  }
  if (profileProvider === provider) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime: profileProvider,
  })?.runtime;
}

function resolveCliRuntimeFromAuthProfile(params: {
  cfg?: OpenClawConfig;
  provider: string;
  authProfileId?: string;
}): string | undefined {
  if (!params.cfg?.auth?.profiles) {
    return undefined;
  }
  if (params.authProfileId?.trim()) {
    return resolveProfileRuntimeAlias({
      cfg: params.cfg,
      provider: params.provider,
      profileId: params.authProfileId.trim(),
    });
  }

  const provider = normalizeProviderId(params.provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const orderedProfileIds = [
    ...(params.cfg.auth.order?.[providerAuthKey] ?? []),
    ...(providerAuthKey === provider ? [] : (params.cfg.auth.order?.[provider] ?? [])),
  ];
  for (const profileId of orderedProfileIds) {
    const profile = params.cfg.auth.profiles[profileId];
    if (!profile?.provider) {
      continue;
    }
    const profileAuthKey = resolveProviderIdForAuth(profile.provider, { config: params.cfg });
    if (profileAuthKey !== providerAuthKey) {
      continue;
    }
    return resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId });
  }

  const compatibleProfileIds = Object.entries(params.cfg.auth.profiles)
    .filter(([, profile]) => {
      if (!profile?.provider) {
        return false;
      }
      return resolveProviderIdForAuth(profile.provider, { config: params.cfg }) === providerAuthKey;
    })
    .map(([profileId]) => profileId);
  if (compatibleProfileIds.length !== 1) {
    return undefined;
  }
  const [profileId] = compatibleProfileIds;
  return profileId
    ? resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId })
    : undefined;
}

export function resolveCliRuntimeExecutionProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelId?: string;
  authProfileId?: string;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const { runtime, matchedProvider } = resolveConfiguredRuntime({ ...params, provider });
  if (runtime === "openclaw") {
    return undefined;
  }
  if (!runtime || runtime === "auto") {
    return resolveCliRuntimeFromAuthProfile({ ...params, provider });
  }
  const effectiveProvider = provider || normalizeProviderId(matchedProvider ?? "");
  if (!effectiveProvider) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider: effectiveProvider,
    runtime,
  })?.runtime;
}
