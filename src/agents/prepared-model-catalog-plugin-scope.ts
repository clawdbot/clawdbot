/**
 * Which plugins may contribute to a model catalog (openclaw-crb2).
 *
 * WHY THIS EXISTS. The prepared-model-catalog worker had no gateway request scope, so its
 * registry load fell through to `metadataSnapshot.pluginIds` — *every* installed plugin.
 * Measured on a live gateway: 156 plugins, 55 actually loaded, **44.6 seconds**, inside a
 * throwaway worker thread, with real side effects (it opened `graph-context.db` and
 * registered channel hooks). Terminating that worker mid-import is the suspected trigger for
 * V8 `Check failed: node->IsInUse()`, which aborts the WHOLE gateway process and kills every
 * in-flight agent run.
 *
 * THE DANGER, AND HOW THIS MODULE ANSWERS IT. Narrowing the plugin set risks *silently*
 * dropping models from the catalog — a worse failure than the crash, because nothing
 * announces it. Two deliberate choices contain that:
 *
 *   1. **Be greedy.** Any manifest signal that could plausibly contribute provider or model
 *      surface keeps the plugin. We are optimising away `beads`, `slack`, `discord` and
 *      `browser` — plugins with no provider signal whatsoever — not shaving the set to a
 *      minimum. A false *include* costs milliseconds; a false *exclude* loses a model.
 *   2. **Fail crashing, never silently.** {@link assertPreparedModelCatalogWorkerCoverage}
 *      compares what the catalog actually produced against what the manifests said to expect
 *      and THROWS on any shortfall. A wrong scope becomes a loud, attributable error naming
 *      the missing providers instead of a quietly shorter model list.
 *
 * Everything here reads the manifest metadata snapshot, which is built WITHOUT importing any
 * plugin — so computing the scope costs nothing and cannot itself trigger the bug.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const log = createSubsystemLogger("agents/prepared-model-catalog-scope");

/** Why a plugin was kept. Recorded per plugin so the log explains itself. */
type ModelScopeReason =
  | "providers"
  | "model-catalog"
  | "model-support"
  | "model-pricing"
  | "model-id-normalization"
  | "cli-backends"
  | "provider-endpoints"
  | "provider-request"
  | "provider-auth"
  | "secret-provider-integrations"
  | "agent-harness"
  | "setup-providers"
  | "auto-enable-providers"
  | "owner-map";

export type ModelCatalogPluginScope = {
  /** Plugin ids to load. Always a superset of what the catalog strictly needs. */
  pluginIds: string[];
  /** Kept plugin id -> the signals that kept it. For the log and for tests. */
  keptReasons: Map<string, ModelScopeReason[]>;
  /** Plugin ids deliberately excluded — the whole point of the exercise. */
  excludedPluginIds: string[];
  /** Provider ids the manifests say the catalog should be able to produce. */
  expectedProviderIds: string[];
  /** Manifest aliases mapped to the canonical provider ids emitted by the catalog. */
  catalogProviderAliases: ReadonlyMap<string, string>;
};

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    // SAFETY: the runtime object guard above is sufficient because Object.keys reads keys only.
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return Boolean(value);
}

/**
 * Every manifest signal that makes a plugin model-relevant.
 *
 * Deliberately broad. `modelSupport`, `modelPricing` and `modelIdNormalization` do not
 * themselves publish models, but a plugin carrying them is unambiguously in the model
 * business, and keeping it costs one import.
 */
function scoreRecord(record: PluginManifestRecord): ModelScopeReason[] {
  const reasons: ModelScopeReason[] = [];
  if (nonEmpty(record.providers)) {
    reasons.push("providers");
  }
  if (nonEmpty(record.modelCatalog)) {
    reasons.push("model-catalog");
  }
  if (nonEmpty(record.modelSupport)) {
    reasons.push("model-support");
  }
  if (nonEmpty(record.modelPricing)) {
    reasons.push("model-pricing");
  }
  if (nonEmpty(record.modelIdNormalization)) {
    reasons.push("model-id-normalization");
  }
  if (nonEmpty(record.cliBackends)) {
    reasons.push("cli-backends");
  }
  if (nonEmpty(record.providerEndpoints)) {
    reasons.push("provider-endpoints");
  }
  if (nonEmpty(record.providerRequest)) {
    reasons.push("provider-request");
  }
  if (
    nonEmpty(record.providerAuthAliases) ||
    nonEmpty(record.providerAuthChoices) ||
    nonEmpty(record.providerUsageAuthEnvVars) ||
    nonEmpty(record.syntheticAuthRefs)
  ) {
    reasons.push("provider-auth");
  }
  if (nonEmpty(record.secretProviderIntegrations)) {
    reasons.push("secret-provider-integrations");
  }
  if (nonEmpty(record.autoEnableWhenConfiguredProviders)) {
    reasons.push("auto-enable-providers");
  }
  if (nonEmpty(record.setup)) {
    reasons.push("setup-providers");
  }
  // THE TRAP, and it is not hypothetical. Agent-harness plugins — claude/claude-bridge,
  // codex, glm-bridge, copilot — declare `activation.onAgentHarnesses` and NOTHING else on
  // this list. `augmentPreparedModelCatalogWithAgentHarness` needs them. Dropping them here
  // deletes the runtime chooser's bindings, which is exactly the openclaw-ahp8 bug arriving
  // from the opposite direction.
  if (nonEmpty(record.activation?.onAgentHarnesses)) {
    reasons.push("agent-harness");
  }
  return reasons;
}

/**
 * Compute the model-contributing plugin set from manifest metadata alone.
 *
 * Returns every plugin id when the snapshot cannot be read confidently — see the empty-set
 * guard below. Degrading to "load everything" restores the old slow-but-correct behaviour
 * rather than risking an empty catalog.
 */
export function resolveModelCatalogPluginScope(
  metadataSnapshot: PluginMetadataSnapshot,
): ModelCatalogPluginScope {
  const records = metadataSnapshot.manifestRegistry?.plugins ?? [];
  const allPluginIds = [...(metadataSnapshot.pluginIds ?? records.map((r) => r.id))];

  const keptReasons = new Map<string, ModelScopeReason[]>();
  const expectedProviderIds = new Set<string>();
  const catalogProviderAliases = new Map<string, string>();

  for (const record of records) {
    const reasons = scoreRecord(record);
    if (reasons.length > 0) {
      keptReasons.set(record.id, reasons);
    }
    for (const providerId of Object.keys(record.modelCatalog?.providers ?? {})) {
      expectedProviderIds.add(normalizeProviderId(providerId));
    }
    for (const providerId of Object.keys(record.modelCatalog?.discovery ?? {})) {
      expectedProviderIds.add(normalizeProviderId(providerId));
    }
    for (const [aliasId, target] of Object.entries(record.modelCatalog?.aliases ?? {})) {
      const alias = normalizeProviderId(aliasId);
      const canonical = normalizeProviderId(target.provider);
      // Match createPreparedModelCatalogProviderNormalizer exactly: duplicate aliases retain
      // the first nonempty target in manifest order. Coverage must canonicalize through the
      // same owner as the catalog or it can reject a correct worker result.
      if (alias && canonical && !catalogProviderAliases.has(alias)) {
        catalogProviderAliases.set(alias, canonical);
      }
    }
  }

  // Belt and braces: the snapshot's owner maps retain every plugin that owns a provider-facing
  // surface, including aliases and setup-only ids. Those surface keys are deliberately NOT
  // output expectations: the catalog emits canonical provider ids, while aliases exist only to
  // select their owner. Canonical expectations come from the manifest records above.
  const owners = metadataSnapshot.owners;
  for (const map of [owners?.providers, owners?.modelCatalogProviders, owners?.setupProviders]) {
    if (!map) {
      continue;
    }
    for (const ownerIds of map.values()) {
      for (const ownerId of ownerIds) {
        if (!keptReasons.has(ownerId)) {
          keptReasons.set(ownerId, ["owner-map"]);
        }
      }
    }
  }
  // CLI backend ids are harness/runtime surfaces, not necessarily model provider ids. Their
  // owners must survive the worker narrowing, but requiring those surface ids to appear as
  // catalog providers would make the result guard reject valid harness-only plugins.
  if (owners?.cliBackends) {
    for (const ownerIds of owners.cliBackends.values()) {
      for (const ownerId of ownerIds) {
        if (!keptReasons.has(ownerId)) {
          keptReasons.set(ownerId, ["owner-map"]);
        }
      }
    }
  }

  const pluginIds = [...keptReasons.keys()];
  const excludedPluginIds = allPluginIds.filter((id) => !keptReasons.has(id));

  // GUARD: an empty scope means our reading of the snapshot is wrong, not that no plugin
  // provides models. Fall back to loading everything — slow and correct beats fast and empty.
  if (pluginIds.length === 0) {
    log.warn(
      `model-catalog plugin scope resolved to ZERO plugins from ${records.length} manifest record(s); ` +
        `falling back to the full set of ${allPluginIds.length} (openclaw-crb2). ` +
        `This is a bug in scope resolution, not a valid state.`,
    );
    return {
      pluginIds: allPluginIds,
      keptReasons,
      excludedPluginIds: [],
      expectedProviderIds: [...expectedProviderIds],
      catalogProviderAliases,
    };
  }

  return {
    pluginIds,
    keptReasons,
    excludedPluginIds,
    expectedProviderIds: [...expectedProviderIds],
    catalogProviderAliases,
  };
}

/** Emit the scope decision in full. Cheap, and the only record of what we chose not to load. */
export function logModelCatalogPluginScope(scope: ModelCatalogPluginScope): void {
  const byReason = new Map<ModelScopeReason, number>();
  for (const reasons of scope.keptReasons.values()) {
    for (const reason of reasons) {
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
  }
  const reasonSummary = [...byReason.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  log.warn(
    `model-catalog plugin scope (openclaw-crb2): loading=${scope.pluginIds.length} ` +
      `excluded=${scope.excludedPluginIds.length} expectedProviders=${scope.expectedProviderIds.length} ` +
      `reasons: ${reasonSummary}`,
  );
  log.warn(`model-catalog plugin scope EXCLUDED: ${scope.excludedPluginIds.toSorted().join(",")}`);
}

/**
 * Fail crashing if the scoped catalog lost a provider the manifests promised.
 *
 * This is the safety net that makes the narrowing acceptable. It compares producedProviderIds
 * against the manifest-derived expectation and throws — loudly, naming the missing ids —
 * rather than returning a quietly shorter catalog.
 *
 * `allowMissingProviderIds` exists because a provider can legitimately be absent when it is
 * disabled or unconfigured; callers pass the ids they already know are inactive. Anything
 * missing beyond that set is a scope defect and must crash.
 */
function assertModelCatalogCoversExpectedProviders(params: {
  scope: ModelCatalogPluginScope;
  producedProviderIds: Iterable<string>;
  allowMissingProviderIds?: Iterable<string>;
}): void {
  const canonicalize = (providerId: string) => {
    const normalized = normalizeProviderId(providerId);
    return params.scope.catalogProviderAliases.get(normalized) ?? normalized;
  };
  const produced = new Set([...params.producedProviderIds].map(canonicalize));
  const allowed = new Set([...(params.allowMissingProviderIds ?? [])].map(canonicalize));
  const missing = params.scope.expectedProviderIds
    .filter((id) => !produced.has(id) && !allowed.has(id))
    .toSorted();

  if (missing.length === 0) {
    log.warn(
      `model-catalog scope verified (openclaw-crb2): ${produced.size} provider(s) produced, ` +
        `${params.scope.expectedProviderIds.length} expected, 0 missing`,
    );
    return;
  }

  // Deliberately fatal. A silently short catalog is the failure mode this whole change was
  // required not to introduce; crashing here is the price of admission for the narrowing.
  throw new Error(
    `prepared model catalog scope dropped ${missing.length} expected provider(s) ` +
      `(openclaw-crb2): ${missing.join(", ")}. ` +
      `Loaded ${params.scope.pluginIds.length} plugin(s), excluded ${params.scope.excludedPluginIds.length}. ` +
      `This means the model-contributing plugin scope is wrong — do NOT relax this check; ` +
      `add the missing signal to scoreRecord() in prepared-model-catalog-plugin-scope.ts.`,
  );
}

/** Validate the catalog the worker is about to return, not a reconstructed proxy catalog. */
export function assertPreparedModelCatalogWorkerCoverage(params: {
  scope: ModelCatalogPluginScope;
  snapshot: ModelCatalogSnapshot;
  activeProviderIds: Iterable<string>;
}): void {
  const producedProviderIds = new Set<string>();
  for (const entry of [
    ...params.snapshot.entries,
    ...params.snapshot.routeVariants,
    ...(params.snapshot.staticEntries ?? []),
  ]) {
    producedProviderIds.add(entry.provider);
  }
  for (const outcome of params.snapshot.providerOutcomes ?? []) {
    producedProviderIds.add(outcome.provider);
  }
  const activeProviderIds = new Set(
    [...params.activeProviderIds].map((providerId) => {
      const normalized = normalizeProviderId(providerId);
      return params.scope.catalogProviderAliases.get(normalized) ?? normalized;
    }),
  );
  assertModelCatalogCoversExpectedProviders({
    scope: params.scope,
    producedProviderIds,
    allowMissingProviderIds: params.scope.expectedProviderIds.filter(
      (providerId) => !activeProviderIds.has(providerId),
    ),
  });
}
