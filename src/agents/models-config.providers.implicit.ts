/**
 * Discovers implicit model-provider config from plugin provider catalogs and
 * static catalogs. It merges discovered provider models with explicit config
 * while preserving user-controlled provider fields.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ManifestModelIdNormalizationSource } from "../plugins/manifest-model-id-normalization.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  prepareProviderStaticCatalog,
  resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog,
  runProviderStaticCatalog,
  type PreparedProviderStaticCatalog,
} from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import { prepareProviderExternalAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveManifestSyntheticAuthProviderRefState } from "../plugins/synthetic-auth.runtime.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";
import { mergeProviderModels, type SourceModelFields } from "./models-config.merge.js";
import {
  buildPluginCatalogConfig,
  prepareProviderCatalogRun,
  reportProviderCatalogSecretFailure,
} from "./models-config.providers.catalog-context.js";
import {
  resolveImplicitProviderDiscoveryScope,
  type ProviderDiscoveryScope,
} from "./models-config.providers.discovery-scope.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secrets.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secrets.js";

const log = createSubsystemLogger("agents/model-providers");

const PROVIDER_IMPLICIT_MERGERS: Partial<
  Record<
    string,
    (params: { existing: ProviderConfig | undefined; implicit: ProviderConfig }) => ProviderConfig
  >
> = {
  ollama: ({ implicit }) => implicit,
};

const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

type ImplicitProviderParams = {
  agentDir: string;
  authStore?: AuthProfileStore;
  config?: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerDiscoveryProviderIds?: readonly string[];
  staticCatalogProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
  sourceModelFields?: SourceModelFields;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  providerDiscoveryScope?: ProviderDiscoveryScope;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
};

function resolveLiveProviderCatalogTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return null;
  }
  const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
  if (!raw) {
    return 15_000;
  }
  const parsed = Number(raw);
  return /^[+]?\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 15_000;
}

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

function mergeImplicitProviderConfig(params: {
  providerId: string;
  existing: ProviderConfig | undefined;
  implicit: ProviderConfig;
  dynamicProviderModels?: boolean;
  sourceModelFields?: SourceModelFields;
  manifestPlugins?: ManifestModelIdNormalizationSource;
}): ProviderConfig {
  const { providerId, existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
  if (merge) {
    return merge({ existing, implicit });
  }
  return mergeProviderModels(implicit, existing, {
    providerId,
    sourceModelFields: params.sourceModelFields,
    manifestPlugins: params.manifestPlugins,
    preserveConfiguredModelMembership:
      !params.dynamicProviderModels && Array.isArray(existing.models) && existing.models.length > 0,
  });
}

function resolveImplicitProviderAuthMarker(params: {
  ctx: ImplicitProviderContext;
  providerId: string;
  provider: ProviderConfig;
}): ProviderConfig {
  return resolveMissingProviderApiKey({
    providerKey: params.providerId,
    provider: params.provider,
    env: params.ctx.env,
    profileApiKey: undefined,
  });
}

function resolveConfiguredImplicitProvider(params: {
  configuredProviders?: Record<string, ProviderConfig> | null;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  for (const providerId of params.providerIds) {
    const configured = findNormalizedProviderValue(
      params.configuredProviders ?? undefined,
      providerId,
    );
    if (configured) {
      return configured;
    }
  }
  return undefined;
}

function resolveExistingImplicitProviderFromContext(params: {
  ctx: ImplicitProviderContext;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  return (
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.explicitProviders,
      providerIds: params.providerIds,
    }) ??
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.config?.models?.providers,
      providerIds: params.providerIds,
    })
  );
}

function hasProviderWildcardVisibility(params: {
  config?: OpenClawConfig;
  providerId: string;
}): boolean {
  return parseConfiguredModelVisibilityEntries({ cfg: params.config }).providerWildcards.has(
    normalizeProviderId(params.providerId),
  );
}

function hasRuntimeProviderCatalog(
  provider: import("../plugins/types.js").ProviderPlugin,
): boolean {
  return typeof provider.catalog?.run === "function";
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  providers: import("../plugins/types.js").ProviderPlugin[],
  order: import("../plugins/types.js").ProviderCatalogOrder,
  preparedStaticResults?: ReadonlyMap<
    import("../plugins/types.js").ProviderPlugin,
    PreparedProviderStaticCatalog["entries"][number]["result"]
  >,
): Promise<Record<string, ProviderConfig> | undefined> {
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const catalogConfig = buildPluginCatalogConfig(ctx);
  const selectedProviderIds = ctx.providerDiscoveryScope
    ? new Set([...ctx.providerDiscoveryScope.values()].flat())
    : undefined;
  const catalogCountsByPluginId = new Map<string, number>();
  for (const provider of providers) {
    if (!provider.catalog && !provider.staticCatalog) {
      continue;
    }
    const pluginId = provider.pluginId ?? normalizeProviderId(provider.id);
    catalogCountsByPluginId.set(pluginId, (catalogCountsByPluginId.get(pluginId) ?? 0) + 1);
  }
  for (const provider of byOrder[order]) {
    const pluginId = provider.pluginId ?? normalizeProviderId(provider.id);
    const ownerProviderIds = ctx.providerDiscoveryScope?.get(pluginId);
    const providerIds =
      ctx.providerDiscoveryScope === undefined
        ? undefined
        : catalogCountsByPluginId.get(pluginId) === 1
          ? (ownerProviderIds ?? [])
          : (ownerProviderIds ?? []).filter((id) => matchesProviderPluginRef(provider, id));
    if (providerIds?.length === 0) {
      continue;
    }
    const resolveCatalogProviderApiKey = (providerId?: string) => {
      const resolvedProviderId = providerId?.trim() || provider.id;
      const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
      if (resolved.apiKey) {
        return resolved;
      }

      if (
        !findNormalizedProviderValue(
          {
            [provider.id]: true,
            ...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
            ...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true])),
          },
          resolvedProviderId,
        )
      ) {
        return resolved;
      }

      const synthetic = provider.resolveSyntheticAuth?.({
        config: catalogConfig,
        provider: resolvedProviderId,
        providerConfig: catalogConfig.models?.providers?.[resolvedProviderId],
      });
      const syntheticApiKey = synthetic?.apiKey?.trim();
      if (!syntheticApiKey) {
        return resolved;
      }

      return {
        apiKey: isNonSecretApiKeyMarker(syntheticApiKey)
          ? syntheticApiKey
          : resolveNonEnvSecretRefApiKeyMarker("file"),
        discoveryApiKey: undefined,
      };
    };

    if (ctx.providerDiscoveryEntriesOnly === true && !provider.staticCatalog) {
      // Mandatory startup accepts only provider facts that do not execute live discovery.
      continue;
    }
    const useStaticCatalog =
      Boolean(provider.staticCatalog) &&
      (ctx.providerDiscoveryEntriesOnly === true || !hasRuntimeProviderCatalog(provider));
    // Static catalogs are preferred for entries-only discovery and as a fallback
    // when runtime discovery produces no usable provider config.
    const hasPreparedStaticResult = preparedStaticResults?.has(provider) === true;
    let result;
    if (useStaticCatalog) {
      result = hasPreparedStaticResult
        ? preparedStaticResults.get(provider)
        : await runProviderStaticCatalog({ provider });
    } else {
      result = await runProviderCatalogWithTimeout({
        provider,
        authStore: ctx.authStore,
        ...(providerIds !== undefined ? { providerIds } : {}),
        config: catalogConfig,
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        env: ctx.env,
        resolveProviderApiKey: resolveCatalogProviderApiKey,
        resolveProviderAuth: (providerId, options) =>
          ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
        reportCatalogOutcome: ctx.onProviderCatalogOutcome,
        timeoutMs: ctx.providerDiscoveryTimeoutMs ?? resolveLiveProviderCatalogTimeoutMs(ctx.env),
      });
    }
    if (!result && !useStaticCatalog && provider.staticCatalog) {
      result = await runProviderStaticCatalog({ provider });
    }
    if (!result) {
      continue;
    }
    const normalizedResult = normalizePluginDiscoveryResult({
      provider,
      result,
    });
    for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) {
      if (selectedProviderIds && !selectedProviderIds.has(normalizeProviderId(providerId))) {
        continue;
      }
      const mergedProvider = mergeImplicitProviderConfig({
        providerId,
        existing:
          discovered[providerId] ??
          resolveExistingImplicitProviderFromContext({
            ctx,
            providerIds: [
              providerId,
              provider.id,
              ...(provider.aliases ?? []),
              ...(provider.hookAliases ?? []),
            ],
          }),
        implicit: implicitProvider,
        dynamicProviderModels: hasProviderWildcardVisibility({
          config: ctx.config,
          providerId,
        }),
        sourceModelFields: ctx.sourceModelFields,
        manifestPlugins: ctx.pluginMetadataSnapshot,
      });
      discovered[providerId] = resolveImplicitProviderAuthMarker({
        ctx,
        providerId,
        provider: mergedProvider,
      });
    }
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

async function runProviderCatalogWithTimeout(
  params: Parameters<typeof runProviderCatalog>[0] & {
    agentDir: string;
    authStore: AuthProfileStore;
    timeoutMs: number | null;
  },
): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | undefined> {
  const timeoutMs = params.timeoutMs ?? undefined;
  const timeoutError = new Error(
    `provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const catalogParams = {
    ...params,
    isActive: () => active,
    reportCatalogOutcome: (outcome: ProviderCatalogOutcome) => {
      if (active) {
        params.reportCatalogOutcome?.(outcome);
      }
    },
  };
  const runCatalog = async () => {
    const prepared = await prepareProviderCatalogRun(catalogParams);
    if (!active) {
      return undefined;
    }
    const result = await runProviderCatalog(prepared);
    return prepared.finalizeCatalogResult ? prepared.finalizeCatalogResult(result) : result;
  };
  try {
    if (!timeoutMs) {
      return await runCatalog();
    }
    const catalogRun = runCatalog();
    // Live discovery should not hang startup; a timeout skips this provider while
    // preserving the rest of the prepared catalog.
    return await Promise.race([
      catalogRun,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(timeoutError);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (await reportProviderCatalogSecretFailure(error, params)) {
      return undefined;
    }
    if (error !== timeoutError) {
      throw error;
    }
    for (const provider of params.providerIds ?? [params.provider.id]) {
      params.reportCatalogOutcome?.({ provider, status: "unavailable" });
    }
    if (error === timeoutError) {
      const message = formatErrorMessage(error);
      log.warn(`${message}; skipping provider discovery`);
    }
    return undefined;
  } finally {
    // A timed-out hook can still finish; its late reports no longer own this publication.
    active = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Prepares sterile provider catalog results for one workspace/config generation. */
export async function prepareImplicitProviderStaticCatalog(
  params: Pick<
    ImplicitProviderParams,
    | "config"
    | "env"
    | "pluginMetadataSnapshot"
    | "providerDiscoveryProviderIds"
    | "staticCatalogProviderIds"
    | "workspaceDir"
  >,
): Promise<PreparedProviderStaticCatalog> {
  const env = params.env ?? process.env;
  const discoveryScope = resolveImplicitProviderDiscoveryScope(params);
  const providers = await resolveRuntimePluginDiscoveryProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: discoveryScope ? [...discoveryScope.keys()] : undefined,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    discoveryEntriesOnly: true,
    includeSyntheticAuthProviders: true,
  });
  const staticCatalogProviderIds = params.staticCatalogProviderIds
    ? new Set(params.staticCatalogProviderIds.map((provider) => normalizeProviderId(provider)))
    : undefined;
  const prepared = await prepareProviderStaticCatalog({
    providers: staticCatalogProviderIds
      ? providers.filter((provider) => {
          if ([...staticCatalogProviderIds].some((id) => matchesProviderPluginRef(provider, id))) {
            return true;
          }
          const ownerProviderIds = provider.pluginId
            ? discoveryScope?.get(provider.pluginId)
            : undefined;
          // A family can publish several identities from one static hook without aliases.
          return (
            ownerProviderIds?.some((id) => staticCatalogProviderIds.has(id)) === true &&
            providers.filter(
              (candidate) => candidate.pluginId === provider.pluginId && candidate.staticCatalog,
            ).length === 1
          );
        })
      : providers,
  });
  // Synthetic auth consumes the complete configured provider entrypoint set. Static results may
  // be narrower because startup only executes hooks for unresolved configured model refs.
  return Object.freeze({
    providers: Object.freeze(providers),
    entries: prepared.entries,
  });
}

/** Resolve all implicit provider configs contributed by runtime plugin discovery. */
export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  let authStore = params.authStore;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
      externalCliProviderIds: params.providerDiscoveryProviderIds,
    }));
  const discoveryScope = resolveImplicitProviderDiscoveryScope(params);
  const discoveryPluginIds = discoveryScope ? [...discoveryScope.keys()] : undefined;
  // The runtime config has already resolved SecretRefs at its owning boundary.
  // Re-resolving source refs here would execute unrelated file/exec providers on catalog reads.
  const discoveryAuthConfig = params.discoveryAuthConfig ?? params.config;
  const discoveryAuthEnv = params.discoveryAuthEnv ?? env;
  const sourceConfigForSecrets = params.providerDiscoveryEntriesOnly
    ? undefined
    : (params.sourceConfigForSecrets ?? params.config);
  const authInputs = [
    env,
    getAuthStore,
    discoveryAuthConfig,
    sourceConfigForSecrets,
    params.workspaceDir,
    discoveryAuthEnv,
  ] as const;
  const context: ImplicitProviderContext = {
    ...params,
    get authStore() {
      return getAuthStore();
    },
    env,
    ...(discoveryScope ? { providerDiscoveryScope: discoveryScope } : {}),
    resolveProviderApiKey: createProviderApiKeyResolver(...authInputs),
    resolveProviderAuth: createProviderAuthResolver(...authInputs),
  };
  const preparedStaticEntries = params.preparedStaticProviderCatalog
    ? params.preparedStaticProviderCatalog.entries.filter(
        ({ provider }) =>
          discoveryPluginIds === undefined ||
          (provider.pluginId !== undefined && discoveryPluginIds.includes(provider.pluginId)),
      )
    : undefined;
  const preparedProviders =
    params.providerDiscoveryEntriesOnly === true && params.preparedStaticProviderCatalog?.providers
      ? params.preparedStaticProviderCatalog.providers.filter(
          (provider) =>
            discoveryPluginIds === undefined ||
            (provider.pluginId !== undefined && discoveryPluginIds.includes(provider.pluginId)),
        )
      : [];
  const preparedPluginIds = new Set(
    preparedProviders.flatMap((provider) => (provider.pluginId ? [provider.pluginId] : [])),
  );
  const missingDiscoveryPluginIds =
    discoveryPluginIds?.filter((pluginId) => !preparedPluginIds.has(pluginId)) ??
    (preparedProviders.length > 0 ? undefined : discoveryPluginIds);
  const resolvedProviders =
    missingDiscoveryPluginIds === undefined || missingDiscoveryPluginIds.length > 0
      ? await resolveRuntimePluginDiscoveryProviders({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env,
          onlyPluginIds: missingDiscoveryPluginIds,
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
          ...(params.providerDiscoveryEntriesOnly === true ? { discoveryEntriesOnly: true } : {}),
        })
      : [];
  const discoveryProviders = [
    ...new Map(
      [...resolvedProviders, ...preparedProviders].map((provider) => [
        `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`,
        provider,
      ]),
    ).values(),
  ];
  const syntheticRefs = resolveManifestSyntheticAuthProviderRefState({
    config: discoveryAuthConfig,
    env,
    workspaceDir: params.workspaceDir,
    ...(params.pluginMetadataSnapshot ? { index: params.pluginMetadataSnapshot.index } : {}),
  }).refs.map(normalizeProviderId);
  const syntheticProviders = discoveryProviders.filter((provider) =>
    syntheticRefs.some((ref) => matchesProviderPluginRef(provider, ref)),
  );
  const configuredSyntheticRefs = Object.entries(
    discoveryAuthConfig?.models?.providers ?? {},
  ).flatMap(([provider, { api }]) =>
    api &&
    (syntheticRefs.includes(normalizeProviderId(api)) ||
      syntheticProviders.some((candidate) => matchesProviderPluginRef(candidate, api)))
      ? [normalizeProviderId(provider)]
      : [],
  );
  const scopedRefs = discoveryScope ? new Set([...discoveryScope.values()].flat()) : undefined;
  // Prepare declared native refs and their configured API aliases without reopening
  // unrelated discovery. Already-resolved descriptors retain hook-alias matching.
  for (const provider of new Set([...syntheticRefs, ...configuredSyntheticRefs])) {
    if (scopedRefs && !scopedRefs.has(provider)) {
      continue;
    }
    await prepareProviderExternalAuthWithPlugin({
      config: discoveryAuthConfig,
      env: discoveryAuthEnv,
      workspaceDir: params.workspaceDir,
      provider,
      context: {
        config: discoveryAuthConfig,
        provider,
        providerConfig: findNormalizedProviderValue(
          discoveryAuthConfig?.models?.providers,
          provider,
        ),
      },
    });
  }
  const hasLiveCatalog = discoveryProviders.some(hasRuntimeProviderCatalog);
  if (params.providerDiscoveryEntriesOnly !== true && hasLiveCatalog) {
    const { prepareProviderDiscoveryAuth } =
      await import("./models-config.providers.discovery-auth.runtime.js");
    Object.assign(context, await prepareProviderDiscoveryAuth(context, discoveryAuthConfig));
  }
  const preparedStaticResultsByProvider = new Map(
    preparedStaticEntries?.map(({ provider, result }) => [
      `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`,
      result,
    ]) ?? [],
  );
  const preparedStaticResults = params.preparedStaticProviderCatalog
    ? new Map(
        discoveryProviders.flatMap((provider) => {
          const key = `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`;
          return preparedStaticResultsByProvider.has(key)
            ? [[provider, preparedStaticResultsByProvider.get(key)] as const]
            : [];
        }),
      )
    : undefined;
  for (const order of PLUGIN_DISCOVERY_ORDERS) {
    mergeImplicitProviderSet(
      providers,
      await resolvePluginImplicitProviders(
        context,
        discoveryProviders,
        order,
        preparedStaticResults,
      ),
    );
  }

  return providers;
}
