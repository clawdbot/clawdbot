/** Implementation of `openclaw models list`. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveLegacyInheritedAuthDir } from "../../agents/legacy-inherited-auth-dir.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createModelListAuthIndex } from "./list.auth-index.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { ensureFlagCompatibility } from "./list.options.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";
import { resolveModelsTargetAgent } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type PromotionsModule = typeof import("./list.promotions.js");
type RegistryLoadModule = typeof import("./list.registry-load.js");
type RowSourcesModule = typeof import("./list.row-sources.js");

const promotionsModuleLoader = createLazyImportLoader<PromotionsModule>(
  () => import("./list.promotions.js"),
);
const registryLoadModuleLoader = createLazyImportLoader<RegistryLoadModule>(
  () => import("./list.registry-load.js"),
);
const rowSourcesModuleLoader = createLazyImportLoader<RowSourcesModule>(
  () => import("./list.row-sources.js"),
);

function loadRegistryLoadModule(): Promise<RegistryLoadModule> {
  return registryLoadModuleLoader.load();
}

function loadRowSourcesModule(): Promise<RowSourcesModule> {
  return rowSourcesModuleLoader.load();
}

/** Lists configured, catalog, and runtime-discovered models as text, plain, or JSON. */
export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    agent?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const rawProviderFilter = opts.provider?.trim();
  const parsedProviderFilter = (() => {
    if (!rawProviderFilter) {
      return undefined;
    }
    if (/\s/u.test(rawProviderFilter)) {
      const message = `Invalid provider filter "${sanitizeTerminalText(rawProviderFilter)}". Use a provider id such as "moonshot", not a display label.`;
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
    const parsed = parseModelRef(
      `${rawProviderFilter}/_`,
      DEFAULT_PROVIDER,
      DISPLAY_MODEL_PARSE_OPTIONS,
    );
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(rawProviderFilter);
  })();
  const humanReadable = !opts.json && !opts.plain;
  const [
    { loadAuthProfileStoreWithoutExternalProfiles },
    { resolveAgentWorkspaceDir },
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
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, {
    kind: "read",
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const metadataSnapshot = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir,
    env: process.env,
  });
  const providerAliasCanonicalizer = createModelCatalogProviderAliasCanonicalizer({
    cfg,
    metadataSnapshot,
  });
  const providerFilter = parsedProviderFilter
    ? providerAliasCanonicalizer.provider(parsedProviderFilter)
    : undefined;
  const { entries } = resolveConfiguredEntries(cfg, metadataSnapshot, agentId);
  if (providerFilter) {
    const knownProviderIds = new Set(
      [
        ...metadataSnapshot.owners.providers.keys(),
        ...metadataSnapshot.owners.modelCatalogProviders.keys(),
        ...Object.keys(cfg.models?.providers ?? {}),
        ...entries.map((entry) => entry.ref.provider),
      ].map((providerId) => providerAliasCanonicalizer.provider(providerId)),
    );
    if (!knownProviderIds.has(providerFilter)) {
      const message = `Unknown provider filter "${sanitizeTerminalText(rawProviderFilter ?? providerFilter)}" for this installation. Run ${formatCliCommand("openclaw plugins list --json")} to see installed providers, or configure it under models.providers.`;
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
  }
  const inheritedAuthDir = resolveLegacyInheritedAuthDir(cfg);
  const authStore = inheritedAuthDir
    ? loadAuthProfileStoreWithoutExternalProfiles(agentDir, { inheritedAuthDir })
    : loadAuthProfileStoreWithoutExternalProfiles(agentDir);
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
  // The default configured view remains lazy; full and filtered views share
  // the registry and the same committed model generation as the Gateway.
  const includePreparedCatalog = Boolean(opts.all || providerFilter);
  const providerDiscoveryProviderIds = (() => {
    if (opts.all && !providerFilter) {
      return undefined;
    }
    if (providerFilter) {
      return [providerFilter];
    }
    return [
      ...new Set([
        ...(authIndex.providerDiscoveryProviderIds ?? []),
        ...entries.map((entry) => entry.ref.provider),
        ...Object.keys(cfg.models?.providers ?? {}),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
  })();
  const providerRuntimeDiscoveryProviderIds = providerFilter
    ? [providerFilter]
    : opts.all
      ? undefined
      : [];
  // Default lists use authenticated providers' authored fallback rows. Live
  // account discovery remains explicit because it imports full provider runtimes.
  const providerManifestFallbackProviderIds =
    !providerFilter && !opts.all ? authIndex.providerDiscoveryProviderIds : undefined;
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
    if (includePreparedCatalog) {
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
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Model registry unavailable: ${detail}`;
    throw new ExpectedCliError({
      message,
      humanOutput: `Model registry unavailable:\n${formatErrorWithStack(err)}`,
      machineOutput: message,
    });
  }
  const promotionsModulePromise = humanReadable ? promotionsModuleLoader.load() : undefined;
  const promotionsRefreshPromise = promotionsModulePromise
    ?.then((promotionsModule) => promotionsModule.startPromotionsFeedRefresh())
    .catch(() => undefined);
  const buildRowContext = (skipRuntimeModelSuppression: boolean) => ({
    cfg,
    agentId,
    agentDir,
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    authIndex,
    providerDiscoveryProviderIds,
    providerRuntimeDiscoveryProviderIds,
    providerManifestFallbackProviderIds,
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

  if (includePreparedCatalog) {
    const { appendAllModelRowSources } = await loadRowSourcesModule();
    await appendAllModelRowSources({
      rows,
      entries,
      context: buildRowContext(false),
      modelRegistry,
      registryModels,
    });
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
  const promotionsModule = await (promotionsModulePromise ?? promotionsModuleLoader.load());
  try {
    promotionsModule.applyPromotionClaimTags(rows);
  } catch {
    // Tags are annotation-only.
  }
  if (rows.length === 0 && !opts.json && !opts.plain) {
    runtime.log("No models found.");
  } else {
    printModelTable(rows, runtime, opts);
  }
  if (promotionsRefreshPromise) {
    // Runs on the empty listing too: a fresh install with zero configured
    // models is exactly the user passive discovery is for. Compares against
    // the configured entries, not the rendered rows — filtered and --all
    // listings show a different set.
    try {
      const refresh = await promotionsRefreshPromise;
      if (refresh) {
        await promotionsModule.printAvailablePromotionsSection({
          configuredKeys: new Set(entries.map((entry) => entry.key)),
          refresh,
          runtime,
        });
      }
    } catch {
      // Passive discovery must never fail the listing.
    }
  }
  requestExitAfterOneShotOutput(runtime);
}
