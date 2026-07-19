/** Builds web-tool secret metadata from config, plugins, and provider contracts. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebSearchCredentialResolutionSource,
} from "../plugins/types.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import {
  describeSecretResolutionError,
  isProviderScopedSecretResolutionError,
} from "./resolve-errors.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  associateSecretResolutionErrorOwners,
  isRetryableSecretDegradationReason,
  type DegradedSecretOwner,
  type SecretOwnerRefState,
} from "./runtime-degraded-state.js";
import {
  classifySecretOwnerDegradationState,
  warnDegradedSecretOwner,
} from "./runtime-owner-assignments.js";
import { digestRuntimeWebOwnerContract } from "./runtime-owner-contract.js";
import { hasCredentialBearingObjectValue } from "./runtime-secret-scan.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import { getActiveSecretsRuntimeSnapshot } from "./runtime-state.js";
import { runtimeWebSecretOwnerId } from "./runtime-web-secret-owner.js";
import {
  ensureObject,
  hasConfiguredSecretRef,
  isRecord,
  resolveRuntimeWebProviderSurface,
  resolveRuntimeWebProviderSelection,
  type RuntimeWebProviderSelectionResult,
  type RuntimeWebSecretOwner,
  type RuntimeWebUnavailableProvider,
  type SecretResolutionResult,
} from "./runtime-web-tools.shared.js";
import type {
  RuntimeWebDiagnostic,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
} from "./runtime-web-tools.types.js";
import { isExpectedResolvedSecretValue } from "./secret-value.js";

const loadRuntimeWebToolsFallbackProviders = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-fallback.runtime.js"),
  ({ runtimeWebToolsFallbackProviders }) => runtimeWebToolsFallbackProviders,
);
const loadRuntimeWebToolsPublicArtifacts = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-public-artifacts.runtime.js"),
  (mod) => mod,
);
const loadRuntimeWebToolsManifest = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-manifest.runtime.js"),
  (mod) => mod,
);

type FetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type SecretResolutionSource =
  | WebSearchCredentialResolutionSource
  | WebFetchCredentialResolutionSource;

type ResolvedRuntimeWebTools = {
  metadata: RuntimeWebToolsMetadata;
  degradedOwners: DegradedSecretOwner[];
  secretOwners: SecretOwnerRefState[];
};

type RuntimeWebProviderFailure = Omit<RuntimeWebUnavailableProvider, "contractDigest"> & {
  contractDigest?: string;
};
type RuntimeWebProviderFailureByRefKey = Map<
  string,
  NonNullable<RuntimeWebUnavailableProvider["providerFailure"]>
>;

function createUnavailableWebProviderOwner(params: {
  kind: "search" | "fetch";
  unavailable: Pick<
    RuntimeWebUnavailableProvider,
    "providerId" | "path" | "refKey" | "reason" | "providerFailure"
  >;
  degradationState?: "cold" | "stale";
}): DegradedSecretOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeWebSecretOwnerId(params.kind, params.unavailable.providerId),
    state: "unavailable",
    degradationState: params.degradationState ?? "cold",
    paths: [params.unavailable.path],
    refKeys: [params.unavailable.refKey],
    reason: params.unavailable.reason,
    ...(params.unavailable.providerFailure
      ? { providerFailures: [params.unavailable.providerFailure] }
      : {}),
  };
}

function attachWebProviderFailures(
  unavailableProviders: RuntimeWebProviderFailure[],
  providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey,
): void {
  for (const unavailable of unavailableProviders) {
    unavailable.providerFailure = providerFailuresByRefKey.get(unavailable.refKey);
  }
}

function collectUnavailableWebProviders(params: {
  kind: "search" | "fetch";
  result: RuntimeWebProviderSelectionResult;
  context: ResolverContext;
  sourceConfig: OpenClawConfig;
  metadata: RuntimeWebSearchMetadata | RuntimeWebFetchMetadata;
  degradedOwners: DegradedSecretOwner[];
}): void {
  for (const unavailable of params.result.unavailableProviders) {
    let degradationState = classifySecretOwnerDegradationState({
      ownerKind: "capability",
      ownerId: runtimeWebSecretOwnerId(params.kind, unavailable.providerId),
      refs: [unavailable.ref],
      config: params.sourceConfig,
      contractDigest: unavailable.contractDigest,
    });
    if (degradationState === "stale") {
      const active = getActiveSecretsRuntimeSnapshot();
      const activeOwner = active?.secretOwners?.find(
        (entry) =>
          entry.ownerKind === "capability" &&
          entry.ownerId === runtimeWebSecretOwnerId(params.kind, unavailable.providerId),
      );
      const value = activeOwner?.resolvedValues?.find(
        (entry) => entry.refKey === unavailable.refKey,
      )?.value;
      try {
        if (typeof value !== "string" || !unavailable.restoreResolvedValue) {
          throw new Error("last-known-good web credential is unavailable");
        }
        unavailable.restoreResolvedValue(value);
        unavailable.resolvedValue = value;
        const selectedOwner = params.result.secretOwners.find(
          (entry) =>
            entry.providerId === unavailable.providerId && entry.refKey === unavailable.refKey,
        );
        if (selectedOwner) {
          selectedOwner.resolvedValue = value;
        }
        const activeMetadata =
          params.kind === "search" ? active?.webTools.search : active?.webTools.fetch;
        if (!activeMetadata) {
          throw new Error("last-known-good web metadata is unavailable");
        }
        for (const key of Object.keys(params.metadata)) {
          delete (params.metadata as Record<string, unknown>)[key];
        }
        Object.assign(params.metadata, structuredClone(activeMetadata));
      } catch {
        degradationState = "cold";
      }
    }
    const owner = createUnavailableWebProviderOwner({
      kind: params.kind,
      unavailable,
      degradationState,
    });
    params.degradedOwners.push(owner);
    warnDegradedSecretOwner(params.context, owner);
  }
}

function toWebSecretOwnerRefState(
  kind: "search" | "fetch",
  owner: RuntimeWebSecretOwner,
): SecretOwnerRefState {
  return {
    ownerKind: "capability",
    ownerId: runtimeWebSecretOwnerId(kind, owner.providerId),
    refKeys: [owner.refKey],
    contractDigest: owner.contractDigest,
    ...(owner.resolvedValue
      ? { resolvedValues: [{ refKey: owner.refKey, value: owner.resolvedValue }] }
      : {}),
  };
}

function associateWebProviderResolutionError(params: {
  kind: "search" | "fetch";
  config: OpenClawConfig;
  error: unknown;
  unavailableProviders: RuntimeWebProviderFailure[];
}): void {
  const failureByRefKey = new Map(
    params.unavailableProviders.map((unavailable) => [unavailable.refKey, unavailable] as const),
  );
  const owners = params.unavailableProviders.map((unavailable) => {
    const owner = createUnavailableWebProviderOwner({ kind: params.kind, unavailable });
    return {
      ...owner,
      degradationState: classifySecretOwnerDegradationState({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        refs: [unavailable.ref],
        config: params.config,
        contractDigest: unavailable.contractDigest,
      }),
      failureMatched: true,
      source: "config" as const,
    };
  });
  const ownerIds = new Set(owners.map((owner) => owner.ownerId));
  const activeCoOwners = (getActiveSecretsRuntimeSnapshot()?.secretOwners ?? []).flatMap(
    (owner) => {
      if (
        owner.ownerKind !== "capability" ||
        ownerIds.has(owner.ownerId) ||
        (!owner.ownerId.startsWith("web-search:") && !owner.ownerId.startsWith("web-fetch:"))
      ) {
        return [];
      }
      const matches = owner.refKeys.flatMap((refKey) => {
        const unavailable = failureByRefKey.get(refKey);
        return unavailable ? [unavailable] : [];
      });
      const firstMatch = matches[0];
      if (!firstMatch) {
        return [];
      }
      return [
        {
          ownerKind: owner.ownerKind,
          ownerId: owner.ownerId,
          state: "unavailable" as const,
          paths: [],
          refKeys: [...owner.refKeys],
          reason: firstMatch.reason,
          degradationState: classifySecretOwnerDegradationState({
            ownerKind: owner.ownerKind,
            ownerId: owner.ownerId,
            refs: matches.map((match) => match.ref),
            config: params.config,
            contractDigest: owner.contractDigest,
          }),
          failureMatched: true,
          source: "config" as const,
          ...(firstMatch.providerFailure ? { providerFailures: [firstMatch.providerFailure] } : {}),
        },
      ];
    },
  );
  associateSecretResolutionErrorOwners(params.error, [...owners, ...activeCoOwners]);
}

function needsRuntimeWebFetchProviderDiscovery(params: {
  fetch: FetchConfig;
  rawProvider: string;
  hasPluginWebFetchConfig: boolean;
  defaults: SecretDefaults | undefined;
}): boolean {
  if (isRecord(params.fetch) && params.fetch.enabled === false) {
    return false;
  }
  if (params.hasPluginWebFetchConfig) {
    return true;
  }
  if (!isRecord(params.fetch)) {
    return false;
  }
  if (params.rawProvider) {
    return true;
  }
  // Limits-only fetch config must stay on the runtime fast path; credential-shaped values are
  // the signal that provider discovery and SecretRef resolution are actually needed.
  return hasCredentialBearingObjectValue(params.fetch, params.defaults);
}

function hasPluginScopedWebToolConfig(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): boolean {
  const entries = config.plugins?.entries;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    return Boolean(pluginConfig?.[key]);
  });
}

function inferSingleBundledPluginScopedWebToolConfigOwner(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): string | undefined {
  const entries = config.plugins?.entries;
  if (!entries) {
    return undefined;
  }
  const matches: string[] = [];
  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.enabled === false) {
      continue;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    if (!isRecord(pluginConfig?.[key])) {
      continue;
    }
    matches.push(pluginId);
    if (matches.length > 1) {
      return undefined;
    }
  }
  return matches[0];
}

function inferExactBundledPluginScopedWebToolConfigOwner(params: {
  config: OpenClawConfig;
  key: "webSearch" | "webFetch";
  pluginId: string;
}): string | undefined {
  const entry = params.config.plugins?.entries?.[params.pluginId];
  if (!isRecord(entry) || entry.enabled === false) {
    return undefined;
  }
  const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.[params.key]) ? params.pluginId : undefined;
}

type WebProviderContract = "webSearchProviders" | "webFetchProviders";

async function hasCustomWebProviderPluginRisk(params: {
  contract: WebProviderContract;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const installRecords = loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
  if (Object.keys(installRecords).length > 0) {
    return true;
  }

  const plugins = params.config.plugins;
  if (!plugins) {
    return false;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  const { resolveManifestContractPluginIds } = await loadRuntimeWebToolsManifest();
  const bundledPluginIds = new Set<string>(
    resolveManifestContractPluginIds({
      contract: params.contract,
      origin: "bundled",
      config: params.config,
      env: params.env,
    }),
  );
  // Public artifacts are complete only for bundled providers. Any configured non-bundled
  // plugin surface has to fall back to manifest/runtime discovery to avoid hiding providers.
  const hasNonBundledPluginId = (pluginId: string) => !bundledPluginIds.has(pluginId.trim());
  if (Array.isArray(plugins.allow) && plugins.allow.some(hasNonBundledPluginId)) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.some(hasNonBundledPluginId)) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).some(hasNonBundledPluginId)) {
    return true;
  }

  return false;
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): { value?: string; envVar?: string } {
  for (const envVar of names) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return { value, envVar };
    }
  }
  return {};
}

async function resolveSecretInputWithEnvFallback(params: {
  kind: "search" | "fetch";
  providerId: string;
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  value: unknown;
  path: string;
  envVars: string[];
  contractDigest: string;
  providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey;
  restrictEnvRefsToEnvVars?: boolean;
}): Promise<SecretResolutionResult<SecretResolutionSource>> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.defaults,
  });

  if (!ref) {
    const configValue = normalizeSecretInput(params.value);
    if (configValue) {
      return {
        value: configValue,
        source: "config",
        secretRefConfigured: false,
      };
    }
    const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
    if (fallback.value) {
      return {
        value: fallback.value,
        source: "env",
        fallbackEnvVar: fallback.envVar,
        secretRefConfigured: false,
      };
    }
    return {
      source: "missing",
      secretRefConfigured: false,
    };
  }

  let resolvedFromRef: string | undefined;
  let unresolvedRefReason: SecretResolutionResult<SecretResolutionSource>["unresolvedRefReason"];

  if (
    params.restrictEnvRefsToEnvVars === true &&
    ref.source === "env" &&
    !params.envVars.includes(ref.id)
  ) {
    throw new Error(`${params.path} SecretRef is not allowed for this provider.`);
  } else {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        config: params.sourceConfig,
        env: params.context.env,
        cache: params.context.cache,
        manifestRegistry: params.context.manifestRegistry,
      });
      const resolvedValue = resolved.get(secretRefKey(ref));
      if (!isExpectedResolvedSecretValue(resolvedValue, "string")) {
        const error = new Error(`${params.path} resolved to a non-string or empty value.`);
        associateWebProviderResolutionError({
          kind: params.kind,
          config: params.sourceConfig,
          error,
          unavailableProviders: [
            {
              providerId: params.providerId,
              path: params.path,
              ref,
              refKey: secretRefKey(ref),
              reason: "resolved secret value was invalid",
              contractDigest: params.contractDigest,
            },
          ],
        });
        throw error;
      }
      resolvedFromRef = normalizeSecretInput(resolvedValue);
    } catch (error) {
      const reason = describeSecretResolutionError(error);
      if (!reason || !isRetryableSecretDegradationReason(reason)) {
        // Invalid provider config or resolved values are structural failures. They must fail
        // activation before publishing an owner degradation that could imply retryability.
        if (reason) {
          associateWebProviderResolutionError({
            kind: params.kind,
            config: params.sourceConfig,
            error,
            unavailableProviders: [
              {
                providerId: params.providerId,
                path: params.path,
                ref,
                refKey: secretRefKey(ref),
                reason,
                contractDigest: params.contractDigest,
              },
            ],
          });
        }
        throw error;
      }
      unresolvedRefReason = reason;
      if (isProviderScopedSecretResolutionError(error)) {
        params.providerFailuresByRefKey.set(secretRefKey(ref), {
          source: error.source,
          provider: error.provider,
        });
      }
    }
  }

  if (resolvedFromRef) {
    return {
      value: resolvedFromRef,
      source: "secretRef",
      secretRefConfigured: true,
      secretRef: ref,
      secretRefKey: secretRefKey(ref),
    };
  }

  return {
    source: "missing",
    secretRef: ref,
    secretRefKey: secretRefKey(ref),
    unresolvedRefReason,
    secretRefConfigured: true,
  };
}

function setResolvedWebSearchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebSearchProviderEntry;
  value: string;
}): void {
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
    return;
  }
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  params.provider.setCredentialValue(search, params.value);
}

async function resolveBundledWebSearchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
  onlyPluginIds?: readonly string[];
  hasCustomWebSearchPluginRisk: boolean;
}): Promise<PluginWebSearchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  const onlyPluginIds =
    params.configuredBundledPluginId !== undefined
      ? [params.configuredBundledPluginId]
      : params.onlyPluginIds && params.onlyPluginIds.length > 0
        ? sortUniqueStrings(params.onlyPluginIds)
        : undefined;
  // Narrow plugin hints can use explicit public artifacts first; broad custom-plugin risk still
  // routes through runtime discovery because installed or path-loaded providers may participate.
  if (onlyPluginIds && onlyPluginIds.length > 0) {
    const bundled = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      config: params.sourceConfig,
      env,
      onlyPluginIds,
      origin: "bundled",
    });
  }
  if (!params.hasCustomWebSearchPluginRisk) {
    const { resolveBundledWebSearchProvidersFromPublicArtifacts } =
      await loadRuntimeWebToolsPublicArtifacts();
    const bundled = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: params.sourceConfig,
      env,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      config: params.sourceConfig,
      env,
      origin: "bundled",
    });
  }
  const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebSearchProviders({
    config: params.sourceConfig,
    env,
  });
}

async function resolveBundledWebFetchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
  hasCustomWebFetchPluginRisk: boolean;
}): Promise<PluginWebFetchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  // Web fetch has no keyless auto-detect fallback; a configured bundled owner can be resolved
  // directly without loading every provider manifest.
  if (params.configuredBundledPluginId) {
    const bundled = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
      onlyPluginIds: [params.configuredBundledPluginId],
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebFetchProviders({
      config: params.sourceConfig,
      env,
      onlyPluginIds: [params.configuredBundledPluginId],
      origin: "bundled",
    });
  }
  if (!params.hasCustomWebFetchPluginRisk) {
    const { resolveBundledWebFetchProvidersFromPublicArtifacts } =
      await loadRuntimeWebToolsPublicArtifacts();
    const bundled = resolveBundledWebFetchProvidersFromPublicArtifacts({
      config: params.sourceConfig,
      env,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebFetchProviders({
      config: params.sourceConfig,
      env,
      origin: "bundled",
    });
  }
  const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebFetchProviders({
    config: params.sourceConfig,
    env,
    // Runtime credential resolution may load only bundled providers or verified
    // official installs. Arbitrary external providers must not gain SecretRef access.
    sandboxed: true,
  });
}

function readConfiguredProviderCredential(params: {
  provider: PluginWebSearchProviderEntry;
  config: OpenClawConfig;
  search: Record<string, unknown> | undefined;
}): unknown {
  return (
    params.provider.getConfiguredCredentialValue?.(params.config) ??
    params.provider.getCredentialValue(params.search)
  );
}

function readConfiguredProviderCredentialFallback(params: {
  provider: PluginWebSearchProviderEntry;
  config: OpenClawConfig;
  search: Record<string, unknown> | undefined;
}): { path: string; value: unknown } | undefined {
  return params.provider.getConfiguredCredentialFallback?.(params.config);
}

function inactivePathsForProvider(provider: PluginWebSearchProviderEntry): string[] {
  if (provider.requiresCredential === false) {
    return [];
  }
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : [provider.credentialPath];
}

function setResolvedWebFetchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebFetchProviderEntry;
  value: string;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const fetch = ensureObject(web, "fetch");
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
    return;
  }
  params.provider.setCredentialValue(fetch, params.value);
}

function readConfiguredFetchProviderCredential(params: {
  provider: PluginWebFetchProviderEntry;
  config: OpenClawConfig;
  fetch: Record<string, unknown> | undefined;
}): unknown {
  const configuredValue = params.provider.getConfiguredCredentialValue?.(params.config);
  return configuredValue ?? params.provider.getCredentialValue(params.fetch);
}

function readConfiguredFetchProviderCredentialFallback(params: {
  provider: PluginWebFetchProviderEntry;
  config: OpenClawConfig;
  fetch: Record<string, unknown> | undefined;
}): { path: string; value: unknown } | undefined {
  return params.provider.getConfiguredCredentialFallback?.(params.config);
}

function inactivePathsForFetchProvider(provider: PluginWebFetchProviderEntry): string[] {
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : provider.credentialPath
      ? [provider.credentialPath]
      : [];
}

/**
 * Resolves runtime web search/fetch provider metadata and writes selected credentials into a
 * cloned runtime config without mutating the source config.
 */
/** Resolves web search/fetch secret metadata from config, plugins, and fallback runtime providers. */
export async function resolveRuntimeWebTools(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
  allowUnavailableSecretOwners?: boolean;
}): Promise<ResolvedRuntimeWebTools> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];
  const degradedOwners: DegradedSecretOwner[] = [];
  const secretOwners: SecretOwnerRefState[] = [];
  const providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey = new Map();
  const finish = (metadata: RuntimeWebToolsMetadata): ResolvedRuntimeWebTools => ({
    metadata,
    degradedOwners,
    secretOwners,
  });
  const env = { ...process.env, ...params.context.env };

  const sourceTools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : undefined;
  const sourceWeb = isRecord(sourceTools?.web) ? sourceTools.web : undefined;
  const resolvedTools = isRecord(params.resolvedConfig.tools)
    ? params.resolvedConfig.tools
    : undefined;
  const resolvedWeb = isRecord(resolvedTools?.web) ? resolvedTools.web : undefined;
  let hasCustomWebSearchRisk: Promise<boolean> | undefined;
  const getHasCustomWebSearchRisk = (): Promise<boolean> => {
    hasCustomWebSearchRisk ??= hasCustomWebProviderPluginRisk({
      contract: "webSearchProviders",
      config: params.sourceConfig,
      env,
    });
    return hasCustomWebSearchRisk;
  };
  let hasCustomWebFetchRisk: Promise<boolean> | undefined;
  const getHasCustomWebFetchRisk = (): Promise<boolean> => {
    hasCustomWebFetchRisk ??= hasCustomWebProviderPluginRisk({
      contract: "webFetchProviders",
      config: params.sourceConfig,
      env,
    });
    return hasCustomWebFetchRisk;
  };
  const legacyXSearchSource = isRecord(sourceWeb?.x_search) ? sourceWeb.x_search : undefined;
  const legacyXSearchResolved = isRecord(resolvedWeb?.x_search) ? resolvedWeb.x_search : undefined;

  // Doctor owns the migration, but runtime still needs to resolve the legacy SecretRef surface
  // so existing configs do not silently stop working before users repair them.
  if (
    legacyXSearchSource &&
    legacyXSearchResolved &&
    Object.hasOwn(legacyXSearchSource, "apiKey")
  ) {
    const legacyXSearchSourceRecord = legacyXSearchSource as Record<string, unknown>;
    const legacyXSearchResolvedRecord = legacyXSearchResolved as Record<string, unknown>;
    const resolution = await resolveSecretInputWithEnvFallback({
      kind: "search",
      providerId: "grok",
      sourceConfig: params.sourceConfig,
      context: params.context,
      defaults,
      value: legacyXSearchSourceRecord.apiKey,
      path: "tools.web.x_search.apiKey",
      envVars: ["XAI_API_KEY"],
      providerFailuresByRefKey,
      contractDigest: digestRuntimeWebOwnerContract({
        scopePath: "tools.web.x_search",
        configuredProvider: "grok",
        toolConfig: legacyXSearchSource,
        providers: [{ id: "grok" }],
        providerId: "grok",
        sourceConfig: params.sourceConfig,
      }),
    });
    if (resolution.value) {
      legacyXSearchResolvedRecord.apiKey = resolution.value;
    }
  }

  const hasPluginWebSearchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webSearch");
  const hasPluginWebFetchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webFetch");
  if (!sourceWeb && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return finish({
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics,
    });
  }
  const search = isRecord(sourceWeb?.search) ? sourceWeb.search : undefined;
  const fetch = isRecord(sourceWeb?.fetch) ? (sourceWeb.fetch as FetchConfig) : undefined;
  if (!search && !fetch && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return finish({
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics,
    });
  }
  const rawProvider = normalizeLowercaseStringOrEmpty(search?.provider);
  let configuredBundledWebSearchPluginIdHint: string | undefined;
  if (hasPluginWebSearchConfig && !(await getHasCustomWebSearchRisk())) {
    if (rawProvider) {
      configuredBundledWebSearchPluginIdHint = inferExactBundledPluginScopedWebToolConfigOwner({
        config: params.sourceConfig,
        key: "webSearch",
        pluginId: rawProvider,
      });
    }
    configuredBundledWebSearchPluginIdHint ??= inferSingleBundledPluginScopedWebToolConfigOwner(
      params.sourceConfig,
      "webSearch",
    );
  }
  const searchMetadata: RuntimeWebSearchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };
  if (search || hasPluginWebSearchConfig) {
    const searchSurface = await resolveRuntimeWebProviderSurface({
      contract: "webSearchProviders",
      rawProvider,
      providerPath: "tools.web.search.provider",
      toolConfig: search,
      diagnostics,
      metadataDiagnostics: searchMetadata.diagnostics,
      invalidAutoDetectCode: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      sourceConfig: params.sourceConfig,
      context: params.context,
      configuredBundledPluginIdHint: configuredBundledWebSearchPluginIdHint,
      resolveProviders: async ({ configuredBundledPluginId }) =>
        resolveBundledWebSearchProviders({
          sourceConfig: params.sourceConfig,
          context: params.context,
          configuredBundledPluginId,
          hasCustomWebSearchPluginRisk: await getHasCustomWebSearchRisk(),
        }),
      sortProviders: sortWebSearchProvidersForAutoDetect,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          provider,
          config,
          search: toolConfig,
        }),
      readConfiguredCredentialFallback: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredentialFallback({
          provider,
          config,
          search: toolConfig,
        }),
      ignoreKeylessProvidersForConfiguredSurface: true,
      emptyProvidersWhenSurfaceMissing: true,
      normalizeConfiguredProviderAgainstActiveProviders: true,
    });

    const searchSelection = await resolveRuntimeWebProviderSelection({
      scopePath: "tools.web.search",
      toolConfig: search,
      enabled: searchSurface.enabled,
      providers: searchSurface.providers,
      configuredProvider: searchSurface.configuredProvider,
      metadata: searchMetadata,
      diagnostics,
      sourceConfig: params.sourceConfig,
      resolvedConfig: params.resolvedConfig,
      context: params.context,
      defaults,
      allowKeylessAutoSelect: false,
      deferKeylessFallback: true,
      allowUnavailableProviders: params.allowUnavailableSecretOwners,
      onUnavailableProviders: (error) => {
        attachWebProviderFailures(error.unavailableProviders, providerFailuresByRefKey);
        associateWebProviderResolutionError({
          kind: "search",
          config: params.sourceConfig,
          error,
          unavailableProviders: error.unavailableProviders,
        });
      },
      noFallbackCode: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      autoDetectSelectedCode: "WEB_SEARCH_AUTODETECT_SELECTED",
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          provider,
          config,
          search: toolConfig,
        }),
      readConfiguredCredentialFallback: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredentialFallback({
          provider,
          config,
          search: toolConfig,
        }),
      resolveSecretInput: ({ providerId, value, path, envVars, contractDigest }) =>
        resolveSecretInputWithEnvFallback({
          kind: "search",
          providerId,
          sourceConfig: params.sourceConfig,
          context: params.context,
          defaults,
          value,
          path,
          envVars,
          contractDigest,
          providerFailuresByRefKey,
        }),
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebSearchApiKey({
          resolvedConfig,
          provider,
          value,
        }),
      inactivePathsForProvider,
      hasConfiguredSecretRef,
      mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            searchConfig: toolConfig,
            runtimeMetadata: metadata,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
          }),
        );
      },
    });
    attachWebProviderFailures(searchSelection.unavailableProviders, providerFailuresByRefKey);
    collectUnavailableWebProviders({
      kind: "search",
      result: searchSelection,
      context: params.context,
      sourceConfig: params.sourceConfig,
      metadata: searchMetadata,
      degradedOwners,
    });
    for (const owner of searchSelection.secretOwners) {
      secretOwners.push(toWebSecretOwnerRefState("search", owner));
    }
  }

  const rawFetchProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
  const fetchMetadata: RuntimeWebFetchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };
  const discoverFetchProviders = needsRuntimeWebFetchProviderDiscovery({
    fetch,
    rawProvider: rawFetchProvider,
    hasPluginWebFetchConfig,
    defaults,
  });
  if (discoverFetchProviders) {
    const fetchSurface = await resolveRuntimeWebProviderSurface({
      contract: "webFetchProviders",
      rawProvider: rawFetchProvider,
      providerPath: "tools.web.fetch.provider",
      toolConfig: fetch,
      diagnostics,
      metadataDiagnostics: fetchMetadata.diagnostics,
      invalidAutoDetectCode: "WEB_FETCH_PROVIDER_INVALID_AUTODETECT",
      sourceConfig: params.sourceConfig,
      context: params.context,
      resolveProviders: async ({ configuredBundledPluginId }) =>
        resolveBundledWebFetchProviders({
          sourceConfig: params.sourceConfig,
          context: params.context,
          configuredBundledPluginId,
          hasCustomWebFetchPluginRisk: await getHasCustomWebFetchRisk(),
        }),
      sortProviders: sortWebFetchProvidersForAutoDetect,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          provider,
          config,
          fetch: toolConfig,
        }),
      readConfiguredCredentialFallback: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredentialFallback({
          provider,
          config,
          fetch: toolConfig,
        }),
    });

    const fetchSelection = await resolveRuntimeWebProviderSelection({
      scopePath: "tools.web.fetch",
      toolConfig: fetch,
      enabled: fetchSurface.enabled,
      providers: fetchSurface.providers,
      configuredProvider: fetchSurface.configuredProvider,
      metadata: fetchMetadata,
      diagnostics,
      sourceConfig: params.sourceConfig,
      resolvedConfig: params.resolvedConfig,
      context: params.context,
      defaults,
      allowKeylessAutoSelect: true,
      deferKeylessFallback: false,
      allowUnavailableProviders: params.allowUnavailableSecretOwners,
      onUnavailableProviders: (error) => {
        attachWebProviderFailures(error.unavailableProviders, providerFailuresByRefKey);
        associateWebProviderResolutionError({
          kind: "fetch",
          config: params.sourceConfig,
          error,
          unavailableProviders: error.unavailableProviders,
        });
      },
      noFallbackCode: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
      autoDetectSelectedCode: "WEB_FETCH_AUTODETECT_SELECTED",
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          provider,
          config,
          fetch: toolConfig,
        }),
      readConfiguredCredentialFallback: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredentialFallback({
          provider,
          config,
          fetch: toolConfig,
        }),
      resolveSecretInput: ({ providerId, value, path, envVars, contractDigest }) =>
        resolveSecretInputWithEnvFallback({
          kind: "fetch",
          providerId,
          sourceConfig: params.sourceConfig,
          context: params.context,
          defaults,
          value,
          path,
          envVars,
          contractDigest,
          providerFailuresByRefKey,
          restrictEnvRefsToEnvVars: true,
        }),
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebFetchApiKey({
          resolvedConfig,
          provider,
          value,
        }),
      inactivePathsForProvider: inactivePathsForFetchProvider,
      hasConfiguredSecretRef,
      mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            fetchConfig: toolConfig,
            runtimeMetadata: metadata,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
          }),
        );
      },
    });
    attachWebProviderFailures(fetchSelection.unavailableProviders, providerFailuresByRefKey);
    collectUnavailableWebProviders({
      kind: "fetch",
      result: fetchSelection,
      context: params.context,
      sourceConfig: params.sourceConfig,
      metadata: fetchMetadata,
      degradedOwners,
    });
    for (const owner of fetchSelection.secretOwners) {
      secretOwners.push(toWebSecretOwnerRefState("fetch", owner));
    }
  }

  return finish({
    search: searchMetadata,
    fetch: fetchMetadata,
    diagnostics,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
