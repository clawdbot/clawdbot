/** Implementation of `openclaw models list`. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveLegacyInheritedAuthDir } from "../../agents/legacy-inherited-auth-dir.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
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
import { formatErrorWithStack } from "./list.errors.js";
import { ensureFlagCompatibility } from "./list.options.js";
import { printModelTable } from "./list.table.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";
import { resolveModelsTargetAgent } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type PromotionsModule = typeof import("./list.promotions.js");
type RegistryModule = typeof import("./list.registry.js");
type CatalogModule = typeof import("./list.rows.js");

const promotionsModuleLoader = createLazyImportLoader<PromotionsModule>(
  () => import("./list.promotions.js"),
);
const registryModuleLoader = createLazyImportLoader<RegistryModule>(
  () => import("./list.registry.js"),
);
const catalogModuleLoader = createLazyImportLoader<CatalogModule>(() => import("./list.rows.js"));

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
    import("../../agents/auth-profiles/store-runtime.js"),
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
  const { entries } = resolveConfiguredModelEntries({
    cfg,
    agentId,
    ...DISPLAY_MODEL_PARSE_OPTIONS,
    canonicalizeRef: providerAliasCanonicalizer.ref,
  });
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
  const includePreparedCatalog = Boolean(opts.all || providerFilter);
  let preparedRuntimeAuthModes: PreparedAgentCredentialModes | undefined;
  let modelRegistry: ModelRegistry | undefined;
  let registryModels: Model[] = [];
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const cliRuntimeProviderIds = [
    ...new Set(
      (opts.local ? [] : entries)
        .filter(
          (entry) =>
            !providerFilter ||
            providerAliasCanonicalizer.provider(entry.ref.provider) === providerFilter,
        )
        .map((entry) =>
          resolveCliRuntimeExecutionProvider({
            provider: entry.ref.provider,
            modelId: entry.ref.model,
            cfg,
            agentId,
            metadataSnapshot,
          }),
        )
        .map((provider) => normalizeProviderId(provider ?? ""))
        .filter((provider) => provider && provider !== "openai"),
    ),
  ];
  try {
    if (includePreparedCatalog) {
      const { loadModelRegistry } = await registryModuleLoader.load();
      const loaded = await loadModelRegistry(cfg, {
        agentId,
        agentDir,
        providerFilter,
        normalizeModels: Boolean(providerFilter),
        workspaceDir,
      });
      modelRegistry = loaded.registry;
      registryModels = loaded.models;
      discoveredKeys = loaded.discoveredKeys;
      availableKeys = loaded.availableKeys;
      availabilityErrorMessage = loaded.availabilityErrorMessage;
      preparedRuntimeAuthModes = Object.fromEntries(
        cliRuntimeProviderIds.flatMap((provider) => {
          const mode = loaded.authModes[provider];
          return mode ? [[provider, mode] as const] : [];
        }),
      );
    } else if (!opts.all && opts.local) {
      const { loadConfiguredListModelRegistry } = await registryModuleLoader.load();
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
  const unpreparedCliRuntimeProviderIds = includePreparedCatalog
    ? cliRuntimeProviderIds.filter((provider) => !preparedRuntimeAuthModes?.[provider])
    : [];
  if (unpreparedCliRuntimeProviderIds.length) {
    try {
      const scopedAuthModes = await (
        await import("../../agents/prepared-model-runtime.scoped-catalog.js")
      ).prepareScopedReadOnlyModelAuthModes(
        { config: cfg, env: process.env, workspaceDir },
        unpreparedCliRuntimeProviderIds,
        metadataSnapshot,
      );
      preparedRuntimeAuthModes = { ...preparedRuntimeAuthModes, ...scopedAuthModes };
    } catch (err) {
      runtime.error(
        `CLI runtime auth lookup failed; leaving availability unknown:\n${formatErrorWithStack(err)}`,
      );
    }
  }
  const authIndex = createModelListAuthIndex({
    cfg,
    authStore,
    agentId,
    agentDir,
    workspaceDir,
    metadataSnapshot,
    preparedRuntimeAuthModes,
    // Default output can append authenticated catalog rows beyond the configured
    // default, so keep the nonprompting OpenAI CLI overlay available in every view.
    externalCliProviderIds: ["openai"],
  });
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
  const promotionsModulePromise = humanReadable ? promotionsModuleLoader.load() : undefined;
  const promotionsRefreshPromise = promotionsModulePromise
    ?.then((promotionsModule) => promotionsModule.startPromotionsFeedRefresh())
    .catch(() => undefined);
  const rowContext = {
    cfg,
    agentId,
    agentDir,
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    authIndex,
    canonicalizeProvider: providerAliasCanonicalizer.provider,
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
    metadataSnapshot,
    workspaceDir,
  };
  const { buildModelListRows } = await catalogModuleLoader.load();
  const rows = await buildModelListRows({
    includePreparedCatalog,
    entries,
    context: rowContext,
    modelRegistry,
    registryModels,
  });

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
