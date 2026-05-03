import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { createModelListAuthIndex } from "./list.auth-index.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type RegistryLoadModule = typeof import("./list.registry-load.js");
type RowSourcesModule = typeof import("./list.row-sources.js");
type SourcePlanModule = typeof import("./list.source-plan.js");

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
  const providerFilter = (() => {
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
  if (providerFilter === null) {
    return;
  }
  const [
    { loadAuthProfileStoreWithoutExternalProfiles },
    { resolveOpenClawAgentDir },
    { resolveAgentWorkspaceDir, resolveDefaultAgentId },
    { resolveDefaultAgentWorkspaceDir },
  ] = await Promise.all([
    import("../../agents/auth-profiles/store.js"),
    import("../../agents/agent-paths.js"),
    import("../../agents/agent-scope.js"),
    import("../../agents/workspace.js"),
  ]);
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = loadAuthProfileStoreWithoutExternalProfiles();
  const agentDir = resolveOpenClawAgentDir();
  const workspaceDir =
    resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ?? resolveDefaultAgentWorkspaceDir();
  const authIndex = createModelListAuthIndex({ cfg, authStore, workspaceDir });

  let modelRegistry: ModelRegistry | undefined;
  let registryModels: Model<Api>[] = [];
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const enableSourcePlanCascade = Boolean(opts.all) || Boolean(providerFilter);
  const sourcePlanModule = enableSourcePlanCascade ? await loadSourcePlanModule() : undefined;
  const sourcePlan = sourcePlanModule
    ? await sourcePlanModule.planAllModelListSources({
        all: opts.all,
        enableCascade: enableSourcePlanCascade,
        providerFilter,
        cfg,
      })
    : undefined;
  const shouldLoadRegistry = sourcePlan?.requiresInitialRegistry ?? false;
  const loadRegistryState = async (opts?: {
    normalizeModels?: boolean;
    loadAvailability?: boolean;
  }) => {
    const { loadListModelRegistry } = await loadRegistryLoadModule();
    const loaded = await loadListModelRegistry(cfg, {
      providerFilter,
      normalizeModels: opts?.normalizeModels ?? Boolean(providerFilter),
      loadAvailability: opts?.loadAvailability,
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
      const loaded = loadConfiguredListModelRegistry(cfg, entries, {
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

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
