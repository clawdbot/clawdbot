// Model list result building resolves visible model catalogs for an agent and
// strips runtime-only provider params before sending the browse API payload.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailability,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import { hasSyntheticLocalProviderAuthConfig } from "../../agents/model-auth.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadModelCatalogSnapshotForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import {
  findModelCatalogRouteDonor,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "../../agents/model-catalog-route.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import {
  createOpenAIModelRoutesResolver,
  openAIModelCatalogRoutePolicy,
} from "../../agents/openai-model-routes.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";
import { resolveManifestProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;
type ModelsListEntry = Pick<
  ModelCatalogEntry,
  "alias" | "contextWindow" | "id" | "input" | "name" | "provider" | "reasoning"
> & { available?: boolean };
type ModelsListEntryWithCapabilities = ModelsListEntry & { apiKeySupported?: boolean };
type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
type ModelsListAvailability = ModelAuthAvailability;
type ModelsListEntryEvaluation = ModelAuthAvailabilityEvaluation;

let loggedSlowModelsListCatalog = false;

// Unknown views are rejected by protocol validation first; this helper keeps the
// handler default explicit for older clients that omit the field.
function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  const view = params.view;
  return view === "configured" || view === "provider-config" || view === "all" ? view : "default";
}

function resolvePositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Project explicitly onto the public protocol shape. Route, base URL, auth,
// runtime, and cost facts stay private to server-side selection.
function buildPublicModelProjection(entry: ModelCatalogEntry): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
  };
}

function listEnabledSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
}): readonly string[] {
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeOpenAIExternalProfiles: boolean;
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  // Browse reads persisted auth because another CLI process may have refreshed
  // it after the Gateway execution snapshot was built.
  const authStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: false,
  });
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(params),
    externalCliProviderIds: params.includeOpenAIExternalProfiles ? ["openai"] : [],
    routeResolverFactory: params.routeResolverFactory,
  });
}

function resolveLegacyEntryAvailability(params: {
  authResolver: ModelAuthAvailabilityResolver;
  entry: ModelCatalogEntry;
  primaryAvailability: ModelsListAvailability;
  cfg: OpenClawConfig;
  agentId: string;
}): ModelsListAvailability {
  if (params.primaryAvailability === true) {
    return true;
  }
  let available = params.primaryAvailability;
  const runtimeProvider = resolveCliRuntimeExecutionProvider({
    provider: params.entry.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.entry.id,
  });
  if (
    runtimeProvider &&
    normalizeProviderId(runtimeProvider) !== normalizeProviderId(params.entry.provider)
  ) {
    const runtimeAvailable = params.authResolver.resolveProviderAuthAvailability(runtimeProvider);
    if (runtimeAvailable === true) {
      return true;
    }
    if (available === false && runtimeAvailable === undefined) {
      available = undefined;
    }
  }
  return available;
}

function createModelsListEntryEvaluator(params: {
  cfg: OpenClawConfig;
  agentId: string;
  authResolver: ModelAuthAvailabilityResolver;
  preferredProfileId?: string;
  lockedProfileId?: string;
}): (
  entry: ModelCatalogEntry,
  routeVariants?: readonly ModelCatalogEntry[],
) => Promise<ModelsListEntryEvaluation> {
  const pending = new Map<string, Promise<ModelsListEntryEvaluation>>();
  return (entry, routeVariants = [entry]) => {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
    const cacheKey = resolveGatewayModelCatalogRouteKey(entry);
    const cached = pending.get(cacheKey);
    if (cached) {
      return cached;
    }
    const next = Promise.resolve().then(() => {
      const evaluation = params.authResolver.evaluateModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
        ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
        observedRoutes: routeVariants.map((variant) => ({
          api: variant.api,
          baseUrl: variant.baseUrl,
        })),
      });
      return evaluation.routeResolution === null && normalizeProviderId(entry.provider) !== "openai"
        ? {
            ...evaluation,
            availability: resolveLegacyEntryAvailability({
              authResolver: params.authResolver,
              entry,
              primaryAvailability: evaluation.availability,
              cfg: params.cfg,
              agentId: params.agentId,
            }),
          }
        : evaluation;
    });
    pending.set(cacheKey, next);
    return next;
  };
}

function resolveGatewayModelCatalogRouteKey(entry: ModelCatalogEntry): string {
  return (
    openAIModelCatalogRoutePolicy.resolveIdentity(entry)?.key ??
    `${normalizeProviderId(entry.provider)}/${entry.id}`
  );
}

function resolveProviderConfigInventoryEntries(params: {
  authoredEntries: readonly ModelCatalogEntry[];
  canonicalEntries: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  const canonicalByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of params.canonicalEntries) {
    const key = resolveGatewayModelCatalogRouteKey(entry);
    if (!canonicalByKey.has(key)) {
      canonicalByKey.set(key, entry);
    }
  }
  const seen = new Set<string>();
  const inventory: ModelCatalogEntry[] = [];
  for (const authoredEntry of params.authoredEntries) {
    const key = resolveGatewayModelCatalogRouteKey(authoredEntry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Authored config owns inventory membership. Canonical catalog rows own
    // route metadata; configured logical overrides are applied by the projector.
    inventory.push(canonicalByKey.get(key) ?? authoredEntry);
  }
  return inventory;
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: {
  cfg: OpenClawConfig;
  agentId: string;
  snapshot: ModelCatalogSnapshot;
  preferredProfileId?: string;
  lockedProfileId?: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}) {
  const defaultModel = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: params.snapshot.entries,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId: params.agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  });
  const workspaceDir =
    resolveAgentWorkspaceDir(params.cfg, params.agentId) ?? resolveDefaultAgentWorkspaceDir();
  const projectionCatalog =
    params.snapshot.routeVariants.length > 0
      ? params.snapshot.routeVariants
      : params.snapshot.entries;
  const routeVariantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of projectionCatalog) {
    const key = resolveGatewayModelCatalogRouteKey(entry);
    const variants = routeVariantsByKey.get(key) ?? [];
    variants.push(entry);
    routeVariantsByKey.set(key, variants);
  }
  const resolveRouteVariants = (entry: ModelCatalogEntry) =>
    routeVariantsByKey.get(resolveGatewayModelCatalogRouteKey(entry)) ?? [entry];
  const logicalEntries: ModelCatalogEntry[] = [];
  const logicalEntryKeys = new Set<string>();
  for (const entry of params.snapshot.entries) {
    const key = resolveGatewayModelCatalogRouteKey(entry);
    if (!logicalEntryKeys.has(key)) {
      logicalEntryKeys.add(key);
      logicalEntries.push(entry);
    }
  }
  const authResolver = createModelsListAuthResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    includeOpenAIExternalProfiles:
      projectionCatalog.some((entry) => normalizeProviderId(entry.provider) === "openai") ||
      [...visibilityPolicy.configuredKeys].some((key) => key.startsWith("openai/")),
    workspaceDir,
    routeResolverFactory: params.routeResolverFactory,
  });
  const evaluateEntry = createModelsListEntryEvaluator({
    cfg: params.cfg,
    agentId: params.agentId,
    authResolver,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
  });
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    evaluateEntry,
    projectCatalog: () =>
      (projectedCatalog ??= Promise.all(
        logicalEntries.map(async (entry) => {
          const routeVariants = resolveRouteVariants(entry);
          const evaluation = await evaluateEntry(entry, routeVariants);
          const state = resolveLogicalModelCatalogEntryState({
            entry,
            evaluation,
            routePolicy: openAIModelCatalogRoutePolicy,
          });
          const overrides = resolveConfiguredModelCatalogOverrides({
            cfg: params.cfg,
            entry,
            policy: openAIModelCatalogRoutePolicy,
          });
          const projected = projectModelCatalogEntryForRoute({
            entry,
            projection: state.routeProjection,
            catalog: routeVariants,
            ...(overrides ? { overrides } : {}),
          });
          if (state.routeProjection.kind !== "selected") {
            return projected;
          }
          const donor = findModelCatalogRouteDonor({
            entry,
            route: state.routeProjection.route,
            policy: openAIModelCatalogRoutePolicy,
            catalog: routeVariants,
          });
          if (donor && Object.hasOwn(donor, "compat")) {
            projected.compat = donor.compat;
          }
          if (donor && Object.hasOwn(donor, "params")) {
            projected.params = donor.params;
          }
          return projected;
        }),
      )),
  };
}

async function buildPublicModelsListEntries(params: {
  catalog: ModelCatalogEntry[];
  cfg: OpenClawConfig;
  evaluateEntry(entry: ModelCatalogEntry): Promise<ModelsListEntryEvaluation>;
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}): Promise<ModelsListEntryWithCapabilities[]> {
  return await Promise.all(
    params.catalog.map(async (entry): Promise<ModelsListEntryWithCapabilities> => {
      const evaluation = await params.evaluateEntry(entry);
      const publicEntry = buildPublicModelProjection(entry);
      const syntheticLocalAvailable =
        evaluation.availability === undefined &&
        evaluation.routeResolution === null &&
        normalizeProviderId(entry.provider) !== "openai" &&
        hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider: entry.provider });
      const available = evaluation.availability ?? (syntheticLocalAvailable ? true : undefined);
      // Legacy views keep emitting a boolean because existing clients treat
      // omission as selectable. Inventory consumers preserve unknown state.
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      return {
        ...publicEntry,
        ...(capabilityProvider && params.apiKeyCapabilities?.providers.has(capabilityProvider)
          ? {
              apiKeySupported: params.apiKeyCapabilities.providers.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
        ...(params.preserveUnknownAvailability && available === undefined
          ? {}
          : { available: available ?? false }),
      };
    }),
  );
}

function apiKeyProviderCapabilities(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const capabilities = new Map<string, boolean>();
  const resolveProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      includeUntrustedWorkspacePlugins: false,
    });
  for (const choice of resolveManifestProviderAuthChoices({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    const provider = resolveProvider(choice.providerId);
    capabilities.set(
      provider,
      capabilities.get(provider) === true || choice.methodId === "api-key",
    );
  }
  return { providers: capabilities, resolveProvider };
}

export async function buildModelsListResult(params: {
  context: GatewayRequestContext;
  agentId?: string;
  params: Record<string, unknown>;
  preloadedCatalog?: ModelCatalogSnapshot;
  catalogProjector?: ReturnType<typeof createGatewayAgentModelCatalogProjector>;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): Promise<{ models: ModelsListEntryWithCapabilities[] }> {
  const cfg = params.context.getRuntimeConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const view = resolveModelsListView(params.params);
  const snapshot = await loadModelCatalogSnapshotForBrowse({
    cfg,
    view,
    loadCatalog: async (loadParams) => {
      const readOnlyLoad = loadParams.readOnly ?? true;
      if (params.preloadedCatalog && readOnlyLoad) {
        return params.preloadedCatalog;
      }
      return await params.context.loadGatewayModelCatalogSnapshot(loadParams);
    },
    onTimeout: (timeoutMs) => {
      if (loggedSlowModelsListCatalog) {
        return;
      }
      loggedSlowModelsListCatalog = true;
      params.context.logGateway.debug(
        `models.list continuing without model catalog after ${timeoutMs}ms`,
      );
    },
  });
  const catalog = snapshot.entries;
  const routeVariants = snapshot.routeVariants;
  const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
  const capableProviders = includeProviderCapabilities
    ? apiKeyProviderCapabilities({ cfg, workspaceDir })
    : undefined;
  if (view === "provider-config") {
    const sourceConfig = getRuntimeConfigSourceSnapshot() ?? cfg;
    const authoredEntries = buildProviderConfigModelCatalogForBrowse({
      cfg: sourceConfig,
      workspaceDir,
    });
    const inventorySnapshot = {
      entries: resolveProviderConfigInventoryEntries({
        authoredEntries,
        canonicalEntries: catalog,
      }),
      routeVariants,
    };
    const inventoryProjector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId,
      snapshot: inventorySnapshot,
      ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
    });
    const inventory = await inventoryProjector.projectCatalog();
    return {
      models: await buildPublicModelsListEntries({
        catalog: inventory,
        cfg,
        evaluateEntry: inventoryProjector.evaluateEntry,
        includeInput: true,
        preserveUnknownAvailability: true,
        ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
      }),
    };
  }
  const defaultModel = resolveAgentEffectiveModelPrimary(cfg, agentId);
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  });
  const evaluateEntry =
    params.catalogProjector?.evaluateEntry ??
    createModelsListEntryEvaluator({
      cfg,
      agentId,
      authResolver: createModelsListAuthResolver({
        cfg,
        agentId,
        includeOpenAIExternalProfiles:
          catalog.some((entry) => normalizeProviderId(entry.provider) === "openai") ||
          [...visibilityPolicy.configuredKeys].some((key) => key.startsWith("openai/")),
        workspaceDir,
        routeResolverFactory: params.routeResolverFactory,
      }),
    });
  const models = await resolveLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    workspaceDir,
    view,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants,
    evaluateEntry: async (entry, variants) => {
      const evaluation = await evaluateEntry(entry, variants);
      const routeManaged = evaluation.routeResolution !== null;
      const syntheticLocal =
        !routeManaged &&
        normalizeProviderId(entry.provider) !== "openai" &&
        evaluation.availability === undefined &&
        evaluation.evidence === "synthetic";
      return resolveLogicalModelCatalogEntryState({
        entry,
        evaluation,
        authBacked: evaluation.availability === true || syntheticLocal,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
    },
  });
  return {
    models: await buildPublicModelsListEntries({
      catalog: models,
      cfg,
      evaluateEntry,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    }),
  };
}
