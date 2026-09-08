// Resolves public model catalogs without exposing runtime-only provider params.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadPreparedModelCatalogSnapshotForBrowse,
  modelCatalogBrowseRequiresFullDiscovery,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { createModelCatalogView } from "../../agents/model-catalog-view.js";
import {
  resolveLogicalModelCatalogEntryState,
  prepareLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import {
  dedupeModelCatalogEntries,
  modelCatalogLogicalKey,
} from "../../agents/model-selection-shared.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import {
  createOpenAIModelRoutesResolver,
  openAIModelCatalogRoutePolicy,
} from "../../agents/openai-model-routes.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import {
  createModelsListAuthProjection,
  type ModelsListAuthProjectionParams,
} from "./models-list-auth-resolver.js";
import {
  listConfiguredRuntimeDiscoveryProviderIds,
  resolveProviderConfigInventoryEntries,
} from "./models-list-configured-static.js";
import { prepareModelsListHarnessCatalog } from "./models-list-harness-catalog.js";
import {
  buildPublicModelProjection,
  projectProviderCatalogOutcomes,
  resolveModelChoiceAgentRuntime,
} from "./models-list-public-projection.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListEntryWithCapabilities = ModelChoice;
type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
type ModelsListResult = {
  models: ModelsListEntryWithCapabilities[];
  providerOutcomes?: ReturnType<typeof projectProviderCatalogOutcomes>;
};
type PreparedModelsListResult = {
  read: () => ModelsListResult;
  isCurrent: () => boolean;
};

let loggedSlowModelsListCatalog = false;

function resolveModelsListView(params: Record<string, unknown>): ModelCatalogBrowseView {
  const view = params.view;
  return view === "configured" || view === "provider-config" || view === "all" ? view : "default";
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: ModelsListAuthProjectionParams) {
  const authProjection = createModelsListAuthProjection(params);
  const { evaluateEntry, evaluateNative, snapshot } = authProjection;
  const view = createModelCatalogView({
    cfg: params.cfg,
    catalog: snapshot.entries,
    routeVariants: snapshot.routeVariants.length > 0 ? snapshot.routeVariants : snapshot.entries,
  });
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    ...authProjection,
    projectCatalog: () =>
      (projectedCatalog ??= Promise.all(
        view.logicalEntries.map(async (entry) => {
          const routeVariants = view.variantsOf(entry) ?? [entry];
          const evaluation = evaluateNative(entry, await evaluateEntry(entry, routeVariants));
          const { entry: projected, donor } = view.project(entry, evaluation);
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

function createPublicModelsListProjector(params: {
  thinkingCatalog: ModelCatalogEntry[];
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}) {
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, ModelsListEntryWithCapabilities>();
  return (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
  ): ModelsListEntryWithCapabilities => {
    let preparedEntry = prepared.get(entry);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
      const alias = configuredEntry?.aliases.at(-1);
      const publicEntry = configuredEntry?.aliasDisabled
        ? Object.assign({}, entry, { alias: undefined })
        : alias && alias !== entry.alias
          ? Object.assign({}, entry, { alias })
          : entry;
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const agentRuntime = resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      });
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              modelCatalog: params.thinkingCatalog,
              configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
              thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
            });
      const fastModeState = resolveFastModeState({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: entry.provider,
        model: entry.id,
      });
      preparedEntry = {
        ...buildPublicModelProjection(publicEntry),
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...thinkingProfile,
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && params.apiKeyCapabilities?.providers.has(capabilityProvider)
          ? {
              apiKeySupported: params.apiKeyCapabilities.providers.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
      };
      prepared.set(entry, preparedEntry);
    }
    // Legacy views require a boolean; inventory consumers preserve unknown state.
    const projectedAvailability = params.preserveUnknownAvailability
      ? evaluation.availability
      : (evaluation.availability ?? false);
    return Object.assign(
      {},
      preparedEntry,
      projectedAvailability === undefined ? {} : { available: projectedAvailability },
      projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {},
    );
  };
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
  requesterProfileId?: string;
  params: Record<string, unknown>;
  preloadedCatalog?: {
    agentId: string;
    config: OpenClawConfig;
    snapshot: ModelCatalogSnapshot;
  };
  catalogProjector?: ReturnType<typeof createGatewayAgentModelCatalogProjector>;
  preloadedOnly?: boolean;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
};

export async function buildModelsListResult(
  params: BuildModelsListResultParams,
): Promise<ModelsListResult> {
  return (await prepareModelsListResult(params)).read();
}

/** Prepares catalog work once; the returned reader revalidates native readiness without I/O. */
export async function prepareModelsListResult(
  params: BuildModelsListResultParams,
): Promise<PreparedModelsListResult> {
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
  let catalogTimedOut = false;
  const handleCatalogTimeout = (timeoutMs: number) => {
    catalogTimedOut = true;
    if (loggedSlowModelsListCatalog) {
      return;
    }
    loggedSlowModelsListCatalog = true;
    params.context.logGateway.warn(
      `models.list catalog load exceeded ${timeoutMs}ms; using the prepared catalog when available`,
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
        (loadedReadOnly ||
          (params.preloadedOnly && isPreparedModelCatalogFull(preloadedCatalog.snapshot)))
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
        ...(!preparedOnly ? { refreshFullCatalog: refresh ? true : "stale" } : {}),
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
          refreshFullCatalog: refresh ? true : "stale",
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
        return { read: () => ({ models: [] }), isCurrent: () => true };
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
    return { read: () => ({ models: [] }), isCurrent: () => true };
  }
  const ownerSnapshot =
    loadedSnapshot ??
    (preloadedCatalog && params.catalogProjector
      ? undefined
      : await readPreparedCatalog(params.context, initialAgentId));
  if (catalogTimedOut && ownerSnapshot) {
    snapshot = ownerSnapshot;
  }
  const cfg = ownerSnapshot?.config ?? initialConfig;
  const agentId = ownerSnapshot?.agentId ?? initialAgentId;
  const workspaceDir =
    ownerSnapshot?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const preparedProjectionOwner = ownerSnapshot ?? params.catalogProjector;
  const metadataSnapshot = preparedProjectionOwner?.metadataSnapshot;
  const preparedAuthStore = ownerSnapshot?.authStore ?? params.catalogProjector?.authStore;
  const preparedPluginRegistry = preparedProjectionOwner?.pluginRegistry;
  const preparedOwnerIsCurrent = preparedProjectionOwner?.isCurrent;
  // Native readiness belongs to the prepared generation, even across config publication.
  const isCurrent = () =>
    params.context.getRuntimeConfig() === initialConfig && preparedOwnerIsCurrent?.() === true;
  if (!metadataSnapshot || !preparedAuthStore) {
    throw new Error("Gateway model catalog owner omitted prepared metadata or auth state");
  }
  const preparedCatalog = await prepareModelsListHarnessCatalog({
    cfg,
    agentId,
    agentDir: ownerSnapshot?.agentDir,
    workspaceDir,
    snapshot,
    view,
    metadataSnapshot,
    pluginRegistry: preparedPluginRegistry,
    isCurrent,
    observationConfig: preparedProjectionOwner?.observationConfig,
    allowHarnessDiscovery: params.preloadedOnly !== true && !preparedOnly,
    onError: (error) =>
      params.context.logGateway.debug(
        `models.list continuing without harness catalog: ${String(error)}`,
      ),
  });
  snapshot = preparedCatalog.snapshot;
  const { defaultModel } = preparedCatalog;
  const preparedRuntimeAuthModes = preparedProjectionOwner?.authModes;
  const preparedRuntimeAuthMaterializations = preparedProjectionOwner?.authMaterializations;
  const projector =
    (usedPreloadedCatalog ? params.catalogProjector : undefined) ??
    createGatewayAgentModelCatalogProjector({
      cfg,
      agentId,
      agentDir: ownerSnapshot?.agentDir,
      workspaceDir,
      snapshot: { ...snapshot, entries: preparedCatalog.catalog },
      metadataSnapshot,
      preparedAuthStore,
      preparedRuntimeAuthModes,
      preparedRuntimeAuthMaterializations,
      // A complete catalog and its synthetic-auth probes cross the worker boundary together.
      preparedSyntheticAuthComplete: ownerSnapshot?.catalogComplete === true,
      // Provider-config inventory describes shared authored configuration, not personal accounts.
      requesterProfileId: view === "provider-config" ? undefined : params.requesterProfileId,
      routeResolverFactory: params.routeResolverFactory,
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
    });
  const catalog = dedupeModelCatalogEntries([
    ...preparedCatalog.catalog,
    ...projector.snapshot.entries,
  ]);
  const evaluateNative: typeof projector.evaluateNative = (entry, host) => {
    const native = projector.evaluateNative(entry, host);
    return native !== host && params.context.getRuntimeConfig() !== initialConfig
      ? { ...native, availability: false }
      : native;
  };
  const { routeVariants, providerOutcomes } = projector.snapshot;
  const publicProviderOutcomes = projectProviderCatalogOutcomes(providerOutcomes);
  const outcomeProjection = publicProviderOutcomes?.length
    ? { providerOutcomes: publicProviderOutcomes }
    : {};
  const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
  const capableProviders = includeProviderCapabilities
    ? apiKeyProviderCapabilities({ cfg, metadataSnapshot, workspaceDir })
    : undefined;
  const configuredEntriesByKey = resolveConfiguredModelEntries({
    cfg,
    agentId,
    defaultModel,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  }).byKey;
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
      pluginRegistry: preparedPluginRegistry,
      isCurrent,
      observationConfig: preparedProjectionOwner?.observationConfig,
      ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
    });
    const inventory = await inventoryProjector.projectCatalog();
    const entries = await Promise.all(
      inventory.map(async (entry) => ({
        entry,
        host: await inventoryProjector.evaluateEntry(entry),
      })),
    );
    const projectPublic = createPublicModelsListProjector({
      thinkingCatalog: catalog,
      cfg,
      agentId,
      configuredEntriesByKey,
      includeInput: true,
      preserveUnknownAvailability: true,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    });
    return {
      isCurrent: () => isCurrent() && inventoryProjector.isCurrent(),
      read: () => ({
        models: entries.map(({ entry, host }) => projectPublic(entry, evaluateNative(entry, host))),
        ...outcomeProjection,
      }),
    };
  }
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: metadataSnapshot,
  });
  const { evaluateEntry } = projector;
  const evaluationKey = (entry: ModelCatalogEntry) =>
    openAIModelCatalogRoutePolicy.resolveIdentity(entry)?.key ?? modelCatalogLogicalKey(entry);
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const readCatalog = await prepareLogicalVisibleModelCatalog({
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
    prepareEntry: async (entry, variants) => {
      const host = await evaluateEntry(entry, variants);
      return () => {
        const evaluation = evaluateNative(entry, host);
        evaluations.set(evaluationKey(entry), evaluation);
        const routeManaged = evaluation.routeResolution !== null;
        const syntheticLocal =
          !routeManaged &&
          normalizeProviderId(entry.provider) !== "openai" &&
          evaluation.availability === undefined &&
          evaluation.evidence === "synthetic";
        return resolveLogicalModelCatalogEntryState({
          evaluation,
          authBacked: evaluation.availability === true || syntheticLocal,
          routePolicy: openAIModelCatalogRoutePolicy,
        });
      };
    },
  });
  const projectPublic = createPublicModelsListProjector({
    thinkingCatalog: catalog,
    cfg,
    agentId,
    configuredEntriesByKey,
    ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
  });
  return {
    isCurrent: () => isCurrent() && projector.isCurrent(),
    read: () => ({
      models: readCatalog().map((entry) => {
        const evaluation = evaluations.get(evaluationKey(entry));
        if (!evaluation) {
          throw new Error("Model catalog publication omitted prepared auth evaluation");
        }
        return projectPublic(entry, evaluation);
      }),
      ...outcomeProjection,
    }),
  };
}
