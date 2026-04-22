import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import {
  appendCatalogSupplementRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  loadListModelRegistry,
} from "./list.rows.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

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
  const { ensureAuthProfileStore, ensureOpenClawModelsJson, resolveOpenClawAgentDir } =
    await import("./list.runtime.js");
  const { sourceConfig, resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = ensureAuthProfileStore();
  const agentDir = resolveOpenClawAgentDir();
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER);
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(raw);
  })();

  let modelRegistry: ModelRegistry | undefined;
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  try {
    // Keep command behavior explicit: sync models.json from the source config
    // before building the read-only model registry view.
    await ensureOpenClawModelsJson(sourceConfig ?? cfg);
    const loaded = await loadListModelRegistry(cfg, { sourceConfig });
    modelRegistry = loaded.registry;
    discoveredKeys = loaded.discoveredKeys;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  } catch (err) {
    runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
    process.exitCode = 1;
    return;
  }
  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];
  const rowContext = {
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
  };

  if (opts.all) {
    const seenKeys = appendDiscoveredRows({
      rows,
      models: modelRegistry?.getAll() ?? [],
      context: rowContext,
    });

    if (modelRegistry) {
      await appendCatalogSupplementRows({
        rows,
        modelRegistry,
        context: rowContext,
        seenKeys,
      });
    }
  } else {
    const registry = modelRegistry;
    if (!registry) {
      runtime.error("Model registry unavailable.");
      process.exitCode = 1;
      return;
    }
    appendConfiguredRows({
      rows,
      entries,
      modelRegistry: registry,
      context: rowContext,
    });
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
