/**
 * Resolves CLI runtime aliases to provider/model auth labels and execution ids.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope-config.js";
import { resolveExplicitAuthOrderSelection } from "./auth-profiles/order.js";
import { getPreparedRuntimeAuthProfileStoreSnapshotCore } from "./auth-profiles/runtime-snapshots.js";
import {
  isCliRuntimeModelBackendForProvider,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { readPreparedProviderAuthFacts } from "./prepared-provider-auth-facts.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "./provider-auth-aliases.js";

const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli", "openai-codex"]);

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
      (activeAuth.startsWith("oauth") ||
        activeAuth.startsWith("token") ||
        activeAuth.startsWith("native")))
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

type RuntimeAuthAliasParams = {
  cfg?: OpenClawConfig;
  metadataSnapshot?: ProviderAuthAliasLookupParams["metadataSnapshot"];
};

function resolveRuntimeAuthProvider(provider: string, params: RuntimeAuthAliasParams): string {
  return resolveProviderIdForAuth(provider, {
    config: params.cfg,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  });
}

function resolveProfileRuntimeAlias(
  params: RuntimeAuthAliasParams & {
    provider: string;
    profileProvider: string | undefined;
  },
): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const profileProvider = normalizeProviderId(params.profileProvider ?? "");
  if (!provider || !profileProvider) {
    return undefined;
  }
  const providerAuthKey = resolveRuntimeAuthProvider(provider, params);
  const profileAuthKey = resolveRuntimeAuthProvider(profileProvider, params);
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

function resolveCliRuntimeFromAuthProfile(
  params: RuntimeAuthAliasParams & {
    provider: string;
    authProfileId?: string;
    agentId?: string;
  },
): string | undefined {
  const configuredProfiles = params.cfg?.auth?.profiles ?? {};
  // Login and auth-order commands own the credential store, not config metadata.
  // Reuse its published snapshot without reopening SQLite on a request path.
  const agentDir = params.agentId ? resolveAgentDir(params.cfg ?? {}, params.agentId) : undefined;
  const store = getPreparedRuntimeAuthProfileStoreSnapshotCore(
    agentDir,
    resolveLegacyInheritedAuthDir(params.cfg ?? {}),
  );
  if (params.authProfileId?.trim()) {
    const profileId = params.authProfileId.trim();
    return resolveProfileRuntimeAlias({
      ...params,
      provider: params.provider,
      profileProvider: (configuredProfiles[profileId] ?? store?.profiles[profileId])?.provider,
    });
  }

  const provider = normalizeProviderId(params.provider);
  const providerAuthKey = resolveRuntimeAuthProvider(provider, params);
  const selection = resolveExplicitAuthOrderSelection({
    storeOrder: store?.order,
    configuredOrder: params.cfg?.auth?.order,
    providerKey: provider,
    providerAuthKey,
  });
  for (const profileId of selection.order ?? []) {
    const profile = configuredProfiles[profileId] ?? store?.profiles[profileId];
    if (!profile?.provider) {
      continue;
    }
    const profileAuthKey = resolveRuntimeAuthProvider(profile.provider, params);
    if (profileAuthKey !== providerAuthKey) {
      continue;
    }
    return resolveProfileRuntimeAlias({
      ...params,
      provider,
      profileProvider: profile.provider,
    });
  }

  if (
    selection.order !== undefined &&
    (selection.order.length === 0 ||
      selection.order.some((profileId) => store?.profiles[profileId] !== undefined))
  ) {
    // Keep empty orders and existing stored profiles authoritative. Only an order
    // of missing profiles may use the canonical stale-profile repair below.
    return undefined;
  }

  const compatibleProfileIds = Object.entries(configuredProfiles)
    .filter(([, profile]) => {
      if (!profile?.provider) {
        return false;
      }
      return resolveRuntimeAuthProvider(profile.provider, params) === providerAuthKey;
    })
    .map(([profileId]) => profileId);
  const [profileId] = compatibleProfileIds;
  if (profileId && compatibleProfileIds.length === 1) {
    return resolveProfileRuntimeAlias({
      ...params,
      provider,
      profileProvider: configuredProfiles[profileId]?.provider,
    });
  }
  return resolveNativeLoginCliRuntime({ provider, cfg: params.cfg, agentDir });
}

/**
 * A provider with no stored credential still runs when an owning native runtime holds a login
 * (for example Claude CLI or Codex app-server). The prepared generation records that fact as
 * secret-free provider auth; request paths read it instead of re-probing provider plugins.
 */
function resolveNativeLoginCliRuntime(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): string | undefined {
  const cfg = params.cfg ?? {};
  const facts = readPreparedProviderAuthFacts(
    params.agentDir ?? resolveAgentDir(cfg, resolveDefaultAgentId(cfg)),
  );
  if (!facts) {
    return undefined;
  }
  for (const binding of listCliRuntimeModelBackendBindings()) {
    if (binding.provider === params.provider && facts[binding.runtime]) {
      return binding.runtime;
    }
  }
  return facts[params.provider]?.runtime;
}

export function resolveCliRuntimeExecutionProvider(
  params: RuntimeAuthAliasParams & {
    provider: string;
    agentId?: string;
    modelId?: string;
    authProfileId?: string;
  },
): string | undefined {
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
