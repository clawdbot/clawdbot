import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { hasProviderStaticCatalogForFilter } from "./list.provider-catalog.js";
import { loadConfiguredListModelRegistry, loadListModelRegistry } from "./list.registry-load.js";
import {
  appendAllModelRowSources,
  appendConfiguredModelRowSources,
  modelRowSourcesRequireRegistry,
} from "./list.row-sources.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

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
  const { ensureAuthProfileStore, resolveOpenClawAgentDir } = await import("./list.runtime.js");
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = ensureAuthProfileStore();
  const agentDir = resolveOpenClawAgentDir();

  let modelRegistry: ModelRegistry | undefined;
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const useProviderCatalogFastPath =
    opts.all && providerFilter
      ? await hasProviderStaticCatalogForFilter({ cfg, providerFilter })
      : false;
  const shouldLoadRegistry = modelRowSourcesRequireRegistry({
    all: opts.all,
    providerFilter,
    useProviderCatalogFastPath,
  });
  const loadRegistryState = async () => {
    const loaded = await loadListModelRegistry(cfg, { providerFilter });
    modelRegistry = loaded.registry;
    discoveredKeys = loaded.discoveredKeys;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  };
  try {
    if (shouldLoadRegistry) {
      await loadRegistryState();
    } else if (!opts.all) {
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
    let rowContext = buildRowContext(useProviderCatalogFastPath);
    const initialAppend = await appendAllModelRowSources({
      rows,
      context: rowContext,
      modelRegistry,
      useProviderCatalogFastPath,
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
        useProviderCatalogFastPath: false,
      });
    }
  } else {
    const registry = modelRegistry;
    if (!registry) {
      runtime.error("Model registry unavailable.");
      process.exitCode = 1;
      return;
    }
    appendConfiguredModelRowSources({
      rows,
      entries,
      modelRegistry: registry,
      context: buildRowContext(false),
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
