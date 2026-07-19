/** Implementation of `openclaw models list`. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseModelRef } from "../../agents/model-selection.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createModelListAuthIndex } from "./list.auth-index.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { canonicalizeModelCatalogProviderAlias } from "./provider-aliases.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type PromotionsModule = typeof import("./list.promotions.js");
type RegistryLoadModule = typeof import("./list.registry-load.js");
type RowSourcesModule = typeof import("./list.row-sources.js");
type SourcePlanModule = typeof import("./list.source-plan.js");

const promotionsModuleLoader = createLazyImportLoader<PromotionsModule>(
  () => import("./list.promotions.js"),
);
const registryLoadModuleLoader = createLazyImportLoader<RegistryLoadModule>(
  () => import("./list.registry-load.js"),
);
const rowSourcesModuleLoader = createLazyImportLoader<RowSourcesModule>(
  () => import("./list.row-sources.js"),
);
const sourcePlanModuleLoader = createLazyImportLoader<SourcePlanModule>(
  () => import("./list.source-plan.js"),
);

function loadRegistryLoadModule(): Promise<RegistryLoadModule> {
  return registryLoadModuleLoader.load();
}

function loadRowSourcesModule(): Promise<RowSourcesModule> {
  return rowSourcesModuleLoader.load();
}

function loadSourcePlanModule(): Promise<SourcePlanModule> {
  return sourcePlanModuleLoader.load();
}

/** Lists configured, catalog, and runtime-discovered models as text, plain, or JSON. */
export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const parsedProviderFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    if (/\s/u.test(raw)) {
      runtime.error(
        `Invalid provider filter "${raw}". Use a provider id such as "moonshot", not a display label.`,
      );
      process.exitCode = 1;
      return null;
    }
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER, DISPLAY_MODEL_PARSE_OPTIONS);
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(raw);
  })();
  if (parsedProviderFilter === null) {
    return;
  }
  const [
    { loadAuthProfileStoreWithoutExternalProfiles },
    { resolveAgentWorkspaceDir, resolveDefaultAgentDir, resolveDefaultAgentId },
    { resolveDefaultAgentWorkspaceDir },
  ] = await Promise.all([
    import("../../agents/auth-profiles/store.js"),
    import("../../agents/agent-scope.js"),
    import("../../agents/workspace.js"),
  ]);
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveDefaultAgentDir(cfg);
  const authStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const metadataSnapshot = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir,
    env: process.env,
  });
  const providerFilter = parsedProviderFilter
    ? canonicalizeModelCatalogProviderAlias(parsedProviderFilter, {
        cfg,
        metadataSnapshot,
      })
    : undefined;
  const { entries } = resolveConfiguredEntries(cfg, metadataSnapshot);
  const authIndex = createModelListAuthIndex({
    cfg,
    authStore,
    agentDir,
    workspaceDir,
    metadataSnapshot,
    // Default output can append authenticated catalog rows beyond the configured
    // default, so keep the nonprompting OpenAI CLI overlay available in every view.
    externalCliProviderIds: ["openai"],
  });

  let modelRegistry: ModelRegistry | undefined;
  let registryModels: Model[] = [];
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const enableSourcePlanCascade = Boolean(opts.all) || Boolean(providerFilter);
  // Full/provider-filtered lists may need runtime, manifest, and registry rows.
  // Defer that planning so default configured-only output stays cheap.
  const sourcePlanModule = enableSourcePlanCascade ? await loadSourcePlanModule() : undefined;
  const sourcePlan = sourcePlanModule
    ? await sourcePlanModule.planAllModelListSources({
        all: opts.all,
        enableCascade: enableSourcePlanCascade,
        providerFilter,
        cfg,
        agentId,
        agentDir,
        metadataSnapshot,
      })
    : undefined;
  const shouldLoadRegistry = sourcePlan?.requiresInitialRegistry ?? false;
  const loadRegistryState = async (optsLocal?: {
    normalizeModels?: boolean;
    loadAvailability?: boolean;
  }) => {
    const { loadListModelRegistry } = await loadRegistryLoadModule();
    const loaded = await loadListModelRegistry(cfg, {
      agentId,
      agentDir,
      providerFilter,
      normalizeModels: optsLocal?.normalizeModels ?? Boolean(providerFilter),
      loadAvailability: optsLocal?.loadAvailability,
      workspaceDir,
    });
    modelRegistry = loaded.registry;
    registryModels = loaded.models;
    discoveredKeys = loaded.discoveredKeys;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  };
  try {
    if (shouldLoadRegistry) {
      await loadRegistryState();
    } else if (!opts.all && opts.local) {
      const { loadConfiguredListModelRegistry } = await loadRegistryLoadModule();
      const loaded = await loadConfiguredListModelRegistry(cfg, entries, {
        agentId,
        agentDir,
        providerFilter,
        workspaceDir,
      });
      modelRegistry = loaded.registry;
      discoveredKeys = loaded.discoveredKeys;
      availableKeys = loaded.availableKeys;
    }
  } catch (err) {
    runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
    process.exitCode = 1;
    return;
  }
  const buildRowContext = (skipRuntimeModelSuppression: boolean) => ({
    cfg,
    agentId,
    agentDir,
    authIndex,
    availableKeys,
    configuredByKey,
    discoveredKeys,
    filter: {
      provider: providerFilter,
      local: opts.local,
    },
    skipRuntimeModelSuppression,
    metadataSnapshot,
    workspaceDir,
  });
  const rows: ModelRow[] = [];

  if (enableSourcePlanCascade) {
    const { appendAllModelRowSources } = await loadRowSourcesModule();
    if (!sourcePlan || !sourcePlanModule) {
      throw new Error("models list source plan was not initialized");
    }
    let rowContext = buildRowContext(sourcePlan.skipRuntimeModelSuppression);
    const initialAppend = await appendAllModelRowSources({
      rows,
      entries,
      context: rowContext,
      modelRegistry,
      registryModels,
      sourcePlan,
    });
    if (initialAppend.requiresRegistryFallback) {
      const useScopedRegistryFallback = sourcePlan.kind === "provider-runtime-scoped";
      // Runtime-scoped providers can fail catalog availability while still being
      // useful for a provider-filtered list; retry through the registry fallback.
      try {
        await loadRegistryState(
          useScopedRegistryFallback
            ? {
                normalizeModels: false,
                loadAvailability: false,
              }
            : undefined,
        );
      } catch (err) {
        runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
        process.exitCode = 1;
        return;
      }
      rows.length = 0;
      rowContext = buildRowContext(useScopedRegistryFallback);
      await appendAllModelRowSources({
        rows,
        entries,
        context: rowContext,
        modelRegistry,
        registryModels,
        sourcePlan: useScopedRegistryFallback
          ? sourcePlan
          : sourcePlanModule.createRegistryModelListSourcePlan(),
      });
    }
  } else {
    const { appendConfiguredModelRowSources } = await loadRowSourcesModule();
    await appendConfiguredModelRowSources({
      rows,
      entries,
      modelRegistry,
      context: buildRowContext(!modelRegistry),
    });
  }

  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }

  // Promotion decorations are best-effort: claim tags come from local
  // provenance, and the discovery section reads a cadence-gated feed cache.
  // Neither may break the core listing; stale refreshes have a short timeout.
  const promotionsModule = await promotionsModuleLoader.load();
  try {
    promotionsModule.applyPromotionClaimTags(rows);
  } catch {
    // Tags are annotation-only.
  }
  if (rows.length === 0) {
    runtime.log("No models found.");
  } else {
    printModelTable(rows, runtime, opts);
  }
  if (!opts.json && !opts.plain) {
    // Runs on the empty listing too: a fresh install with zero configured
    // models is exactly the user passive discovery is for. Compares against
    // the configured entries, not the rendered rows — filtered and --all
    // listings show a different set.
    try {
      await promotionsModule.printAvailablePromotionsSection({
        configuredKeys: new Set(entries.map((entry) => entry.key)),
        runtime,
      });
    } catch {
      // Passive discovery must never fail the listing.
    }
  }
  requestExitAfterOneShotOutput(runtime);
}
