// Model list result building resolves visible model catalogs for an agent and
// strips runtime-only provider params before sending the browse API payload.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type {
  ModelAuthAvailability,
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import { hasSyntheticLocalProviderAuthConfig } from "../../agents/model-auth-provider-config.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadPreparedModelCatalogSnapshotForBrowse,
  modelCatalogBrowseRequiresFullDiscovery,
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
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { createModelsListAuthResolver } from "./models-list-auth-resolver.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListEntry = Pick<
  ModelChoice,
  "alias" | "contextWindow" | "id" | "input" | "name" | "provider" | "reasoning"
> & { available?: boolean; supportsTools?: boolean };
type ModelsListEntryWithCapabilities = ModelChoice;
type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
type ModelsListAvailability = ModelAuthAvailability;
type ModelsListEntryEvaluation = ModelAuthAvailabilityEvaluation;
type ModelsListResult = {
  models: ModelsListEntryWithCapabilities[];
  providerOutcomes?: readonly ProviderCatalogOutcome[];
};

let loggedSlowModelsListCatalog = false;

// Unknown views are rejected by protocol validation first; this helper keeps the
// handler default explicit for older clients that omit the field.
function resolveModelsListView(params: Record<string, unknown>): ModelCatalogBrowseView {
  const view = params.view;
  return view === "configured" || view === "provider-config" || view === "all" ? view : "default";
}

// Project explicitly onto the public protocol shape. Concrete route, base URL,
// auth, and cost facts stay private; runtime intent is attached separately.
function buildPublicModelProjection(entry: ModelCatalogEntry): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
  };
}

function resolveModelChoiceAgentRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
}): GatewayAgentRuntime | undefined {
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelApi: params.entry.api,
    modelBaseUrl: params.entry.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  });
  if (harnessPolicy.runtime === "auto") {
    return undefined;
  }
  return projectWorkerPlacementAgentRuntime({
    id: harnessPolicy.runtime,
    source: harnessPolicy.runtimeSource ?? "implicit",
  });
}

function resolveLegacyEntryAvailability(params: {
  authResolver: ModelAuthAvailabilityResolver;
  entry: ModelCatalogEntry;
  primaryAvailability: ModelsListAvailability;
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
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
    metadataSnapshot: params.metadataSnapshot,
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
  metadataSnapshot: PluginMetadataSnapshot;
  providerOutcomes?: readonly ProviderCatalogOutcome[];
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
      const resolved =
        evaluation.routeResolution === null && normalizeProviderId(entry.provider) !== "openai"
          ? {
              ...evaluation,
              availability: resolveLegacyEntryAvailability({
                authResolver: params.authResolver,
                entry,
                primaryAvailability: evaluation.availability,
                cfg: params.cfg,
                agentId: params.agentId,
                metadataSnapshot: params.metadataSnapshot,
              }),
            }
          : evaluation;
      const provider = normalizeProviderId(entry.provider);
      // Stored credentials prove presence, not acceptance. Apply the live rejection only to the
      // profile discovery tested; widening it would hide routes backed by another valid profile.
      return params.providerOutcomes?.some(
        (outcome) =>
          outcome.status === "auth-rejected" &&
          normalizeProviderId(outcome.provider) === provider &&
          (outcome.profileId === undefined || outcome.profileId === resolved.selectedProfileId),
      )
        ? { ...resolved, availability: false }
        : resolved;
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

/** Configured dynamic-catalog providers that omit explicit model inventory. */
function listConfiguredRuntimeDiscoveryProviderIds(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">,
): Set<string> {
  const ids = new Set<string>();
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object" || !metadataSnapshot) {
    return ids;
  }
  const dynamicProviders = new Set<string>();
  for (const plugin of metadataSnapshot.plugins) {
    for (const [providerRaw, mode] of Object.entries(plugin.modelCatalog?.discovery ?? {})) {
      const providerId = normalizeProviderId(providerRaw);
      if (providerId && (mode === "runtime" || mode === "refreshable")) {
        dynamicProviders.add(providerId);
      }
    }
  }
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (providerId && dynamicProviders.has(providerId) && !Array.isArray(provider?.models)) {
      ids.add(providerId);
    }
  }
  return ids;
}

function resolveProviderConfigInventoryEntries(params: {
  authoredEntries: readonly ModelCatalogEntry[];
  canonicalEntries: readonly ModelCatalogEntry[];
  discoveryOnlyProviderIds?: ReadonlySet<string>;
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
  if (params.discoveryOnlyProviderIds) {
    // Providers configured without explicit model lists (for example litellm)
    // surface their key-scoped discovered rows as the configured inventory.
    for (const canonicalEntry of params.canonicalEntries) {
      const key = resolveGatewayModelCatalogRouteKey(canonicalEntry);
      if (seen.has(key)) {
        continue;
      }
      if (!params.discoveryOnlyProviderIds.has(normalizeProviderId(canonicalEntry.provider))) {
        continue;
      }
      seen.add(key);
      inventory.push(canonicalEntry);
    }
  }
  return inventory;
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: {
  cfg: OpenClawConfig;
  agentId: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preferredProfileId?: string;
  lockedProfileId?: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
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
    metadataSnapshot,
    preparedAuthStore: params.preparedAuthStore,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    workspaceDir,
    routeResolverFactory: params.routeResolverFactory,
  });
  const evaluateEntry = createModelsListEntryEvaluator({
    cfg: params.cfg,
    agentId: params.agentId,
    authResolver,
    metadataSnapshot,
    providerOutcomes: params.snapshot.providerOutcomes,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
  });
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    evaluateEntry,
    metadataSnapshot,
    authStore: params.preparedAuthStore,
    authModes: params.preparedRuntimeAuthModes,
    authMaterializations: params.preparedRuntimeAuthMaterializations,
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
  agentId: string;
  evaluateEntry(entry: ModelCatalogEntry): Promise<ModelsListEntryEvaluation>;
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}): Promise<ModelsListEntryWithCapabilities[]> {
  return Promise.all(
    params.catalog.map(async (entry): Promise<ModelsListEntryWithCapabilities> => {
      const evaluation = await params.evaluateEntry(entry);
      const syntheticLocalAvailable =
        evaluation.availability === undefined &&
        evaluation.routeResolution === null &&
        normalizeProviderId(entry.provider) !== "openai" &&
        hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider: entry.provider });
      const available = evaluation.availability ?? (syntheticLocalAvailable ? true : undefined);
      // Legacy views keep emitting a boolean because existing clients treat
      // omission as selectable. Inventory consumers preserve unknown state.
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const agentRuntime = resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      });
      const thinkingProfile =
        typeof entry.reasoning === "boolean"
          ? resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              modelCatalog: params.catalog,
            })
          : undefined;
      return {
        ...buildPublicModelProjection(entry),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...thinkingProfile,
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
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const { capabilities, resolveProvider } = resolveModelProviderCapabilities({
    config: params.cfg,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
  return {
    providers: new Map(
      capabilities.map(({ provider, apiKeySupported }) => [provider, apiKeySupported]),
    ),
    resolveProvider,
  };
}

type BuildModelsListResultParams = {
  context: GatewayRequestContext;
  agentId?: string;
  params: Record<string, unknown>;
  preloadedCatalog?: {
    agentId: string;
    config: OpenClawConfig;
    snapshot: ModelCatalogSnapshot;
    /** The owner already ran full discovery for this exact snapshot. */
    fullyDiscovered?: boolean;
  };
  catalogProjector?: ReturnType<typeof createGatewayAgentModelCatalogProjector>;
  preloadedOnly?: boolean;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
};

export async function buildModelsListResult(
  params: BuildModelsListResultParams,
): Promise<ModelsListResult> {
  const initialConfig = params.context.getRuntimeConfig();
  const initialAgentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(initialConfig));
  const view = resolveModelsListView(params.params);
  const preparedOnly = params.params.preparedOnly === true;
  const refresh = params.params.refresh === true;
  const preloadedCatalog =
    params.preloadedCatalog?.agentId === initialAgentId &&
    preparedModelRuntimeConfigsMatch(params.preloadedCatalog.config, initialConfig)
      ? params.preloadedCatalog
      : undefined;
  let loadedSnapshot: Awaited<ReturnType<typeof loadDeferredCatalog>> | undefined;
  let loadedReadOnly = true;
  let usedPreloadedCatalog = false;
  const handleCatalogTimeout = (timeoutMs: number) => {
    if (loggedSlowModelsListCatalog) {
      return;
    }
    loggedSlowModelsListCatalog = true;
    params.context.logGateway.debug(
      `models.list continuing without model catalog after ${timeoutMs}ms`,
    );
  };
  let snapshot = await loadPreparedModelCatalogSnapshotForBrowse({
    cfg: initialConfig,
    agentId: initialAgentId,
    view,
    preparedOnly,
    refresh,
    loadCatalog: async (loadParams) => {
      loadedReadOnly = loadParams.readOnly ?? true;
      // A read-only preload cannot satisfy a full-discovery request. Reuse it only when the
      // owner carried the completed-discovery fact with the exact snapshot.
      if (
        preloadedCatalog &&
        (loadedReadOnly || (params.preloadedOnly && preloadedCatalog.fullyDiscovered === true))
      ) {
        usedPreloadedCatalog = true;
        return preloadedCatalog.snapshot;
      }
      if (params.preloadedOnly) {
        return { entries: [], routeVariants: [] };
      }
      loadedSnapshot = await loadDeferredCatalog(params.context, initialAgentId, {
        readOnly: loadedReadOnly,
        refreshAuth: refresh && loadedReadOnly,
        refreshFullCatalog: loadParams.refresh === true,
      });
      return loadedSnapshot;
    },
    onTimeout: handleCatalogTimeout,
  });
  if (
    loadedSnapshot &&
    loadedReadOnly &&
    !preparedOnly &&
    modelCatalogBrowseRequiresFullDiscovery({
      cfg: loadedSnapshot.config,
      agentId: loadedSnapshot.agentId,
      view,
    })
  ) {
    const escalationAgentId = loadedSnapshot.agentId;
    let escalationTimedOut = false;
    let fullSnapshot: typeof loadedSnapshot | undefined;
    const escalatedCatalog = await loadPreparedModelCatalogSnapshotForBrowse({
      cfg: loadedSnapshot.config,
      agentId: escalationAgentId,
      view,
      refresh,
      loadCatalog: async ({ readOnly }) => {
        fullSnapshot = await loadDeferredCatalog(params.context, escalationAgentId, {
          readOnly,
          refreshAuth: refresh && readOnly,
          refreshFullCatalog: refresh,
        });
        return fullSnapshot;
      },
      timeoutFullDiscovery: true,
      onTimeout: (timeoutMs) => {
        escalationTimedOut = true;
        handleCatalogTimeout(timeoutMs);
      },
    });
    if (!escalationTimedOut && fullSnapshot) {
      if (!publishedModelCatalogOwnerMatchesAgent(fullSnapshot, escalationAgentId)) {
        return { models: [] };
      }
      loadedSnapshot = fullSnapshot;
      snapshot = escalatedCatalog;
    }
  }
  if (
    loadedSnapshot &&
    params.agentId !== undefined &&
    !publishedModelCatalogOwnerMatchesAgent(loadedSnapshot, initialAgentId)
  ) {
    return { models: [] };
  }
  const ownerSnapshot =
    loadedSnapshot ??
    (preloadedCatalog && params.catalogProjector
      ? undefined
      : await readPreparedCatalog(params.context, initialAgentId));
  const cfg = ownerSnapshot?.config ?? initialConfig;
  const agentId = ownerSnapshot?.agentId ?? initialAgentId;
  const workspaceDir =
    ownerSnapshot?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const { entries: catalog, routeVariants, providerOutcomes } = snapshot;
  const outcomeProjection = providerOutcomes?.length ? { providerOutcomes } : {};
  const preparedProjectionOwner = ownerSnapshot ?? params.catalogProjector;
  const metadataSnapshot = preparedProjectionOwner?.metadataSnapshot;
  const preparedAuthStore = ownerSnapshot?.authStore ?? params.catalogProjector?.authStore;
  if (!metadataSnapshot || !preparedAuthStore) {
    throw new Error("Gateway model catalog owner omitted prepared metadata or auth state");
  }
  const preparedRuntimeAuthModes = preparedProjectionOwner?.authModes;
  const preparedRuntimeAuthMaterializations = preparedProjectionOwner?.authMaterializations;
  const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
  const capableProviders = includeProviderCapabilities
    ? apiKeyProviderCapabilities({ cfg, metadataSnapshot, workspaceDir })
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
        discoveryOnlyProviderIds: listConfiguredRuntimeDiscoveryProviderIds(
          sourceConfig,
          metadataSnapshot,
        ),
      }),
      routeVariants,
      ...(providerOutcomes?.length ? { providerOutcomes } : {}),
    };
    const inventoryProjector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId,
      snapshot: inventorySnapshot,
      metadataSnapshot,
      preparedAuthStore,
      preparedRuntimeAuthModes,
      preparedRuntimeAuthMaterializations,
      ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
    });
    const inventory = await inventoryProjector.projectCatalog();
    return {
      models: await buildPublicModelsListEntries({
        catalog: inventory,
        cfg,
        agentId,
        evaluateEntry: inventoryProjector.evaluateEntry,
        includeInput: true,
        preserveUnknownAvailability: true,
        ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
      }),
      ...outcomeProjection,
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
    manifestPlugins: metadataSnapshot?.plugins,
  });
  const evaluateEntry =
    (usedPreloadedCatalog ? params.catalogProjector?.evaluateEntry : undefined) ??
    createModelsListEntryEvaluator({
      cfg,
      agentId,
      authResolver: createModelsListAuthResolver({
        cfg,
        agentId,
        metadataSnapshot,
        preparedAuthStore,
        preparedRuntimeAuthModes,
        preparedRuntimeAuthMaterializations,
        workspaceDir,
        routeResolverFactory: params.routeResolverFactory,
      }),
      metadataSnapshot,
      providerOutcomes,
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
      agentId,
      evaluateEntry,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    }),
    ...outcomeProjection,
  };
}
