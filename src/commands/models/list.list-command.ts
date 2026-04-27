import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type RegistryLoadModule = typeof import("./list.registry-load.js");
type RowSourcesModule = typeof import("./list.row-sources.js");
type ProviderCatalogModule = typeof import("./list.provider-catalog.js");

let registryLoadModulePromise: Promise<RegistryLoadModule> | undefined;
let rowSourcesModulePromise: Promise<RowSourcesModule> | undefined;
let providerCatalogModulePromise: Promise<ProviderCatalogModule> | undefined;

function loadRegistryLoadModule(): Promise<RegistryLoadModule> {
  registryLoadModulePromise ??= import("./list.registry-load.js");
  return registryLoadModulePromise;
}

function loadRowSourcesModule(): Promise<RowSourcesModule> {
  rowSourcesModulePromise ??= import("./list.row-sources.js");
  return rowSourcesModulePromise;
}

function loadProviderCatalogModule(): Promise<ProviderCatalogModule> {
  providerCatalogModulePromise ??= import("./list.provider-catalog.js");
  return providerCatalogModulePromise;
}

function modelRowSourcesRequireRegistry(params: {
  all?: boolean;
  providerFilter?: string;
  useManifestCatalogFastPath: boolean;
  useProviderCatalogFastPath: boolean;
  useProviderIndexCatalogFastPath: boolean;
}): boolean {
  if (!params.all) {
    return false;
  }
  if (params.providerFilter) {
    return false;
  }
  return true;
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
  const [{ loadAuthProfileStoreWithoutExternalProfiles }, { resolveOpenClawAgentDir }] =
    await Promise.all([
      import("../../agents/auth-profiles/store.js"),
      import("../../agents/agent-paths.js"),
    ]);
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = loadAuthProfileStoreWithoutExternalProfiles();
  const agentDir = resolveOpenClawAgentDir();

  let modelRegistry: ModelRegistry | undefined;
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  let manifestCatalogRows: readonly NormalizedModelCatalogRow[] = [];
  let providerIndexCatalogRows: readonly NormalizedModelCatalogRow[] = [];
  if (opts.all && providerFilter) {
    const { loadStaticManifestCatalogRowsForList } = await import("./list.manifest-catalog.js");
    manifestCatalogRows = loadStaticManifestCatalogRowsForList({ cfg, providerFilter });
  }
  const useManifestCatalogFastPath = manifestCatalogRows.length > 0;
  if (!useManifestCatalogFastPath && opts.all && providerFilter) {
    const { loadProviderIndexCatalogRowsForList } =
      await import("./list.provider-index-catalog.js");
    providerIndexCatalogRows = loadProviderIndexCatalogRowsForList({ cfg, providerFilter });
  }
  const useProviderIndexCatalogFastPath = providerIndexCatalogRows.length > 0;
  const useProviderCatalogFastPath = await (async () => {
    if (
      useManifestCatalogFastPath ||
      useProviderIndexCatalogFastPath ||
      !opts.all ||
      !providerFilter
    ) {
      return false;
    }
    const { hasProviderStaticCatalogForFilter } = await loadProviderCatalogModule();
    return hasProviderStaticCatalogForFilter({ cfg, providerFilter });
  })();
  const shouldLoadRegistry = modelRowSourcesRequireRegistry({
    all: opts.all,
    providerFilter,
    useManifestCatalogFastPath,
    useProviderCatalogFastPath,
    useProviderIndexCatalogFastPath,
  });
  const loadRegistryState = async () => {
    const { loadListModelRegistry } = await loadRegistryLoadModule();
    const loaded = await loadListModelRegistry(cfg, { providerFilter });
    modelRegistry = loaded.registry;
    discoveredKeys = loaded.discoveredKeys;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  };
  try {
    if (shouldLoadRegistry) {
      await loadRegistryState();
    } else if (!opts.all && opts.local) {
      const { loadConfiguredListModelRegistry } = await loadRegistryLoadModule();
      const loaded = loadConfiguredListModelRegistry(cfg, entries, { providerFilter });
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
    authStore,
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

  if (opts.all) {
    const { appendAllModelRowSources } = await loadRowSourcesModule();
    let rowContext = buildRowContext(
      useManifestCatalogFastPath || useProviderCatalogFastPath || useProviderIndexCatalogFastPath,
    );
    const initialAppend = await appendAllModelRowSources({
      rows,
      context: rowContext,
      modelRegistry,
      manifestCatalogRows,
      providerIndexCatalogRows,
      useManifestCatalogFastPath,
      useProviderCatalogFastPath,
      useProviderIndexCatalogFastPath,
    });
    if (initialAppend.requiresRegistryFallback) {
      try {
        await loadRegistryState();
      } catch (err) {
        runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
        process.exitCode = 1;
        return;
      }
      rows.length = 0;
      rowContext = buildRowContext(false);
      await appendAllModelRowSources({
        rows,
        context: rowContext,
        modelRegistry,
        manifestCatalogRows: [],
        providerIndexCatalogRows: [],
        useManifestCatalogFastPath: false,
        useProviderCatalogFastPath: false,
        useProviderIndexCatalogFastPath: false,
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
