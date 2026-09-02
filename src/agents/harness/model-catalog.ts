import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { resolveModelRefFromString } from "../model-selection-shared.js";
import { resolveModelCatalogIdentityKey } from "../openai-model-routes.js";
import type { PreparedModelRuntimeInput } from "../prepared-model-runtime.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../workspace.js";
import { resolveAgentHarnessPolicy } from "./policy.js";
import type { AgentHarnessPluginSelection } from "./runtime-plugin-load-plan.js";

type LoadHarnessModelCatalog = NonNullable<
  PluginRegistry["agentHarnesses"][number]["harness"]["loadModelCatalog"]
>;

function normalizeRouteBaseUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function routeVariantKey(
  entry: ModelCatalogEntry,
  identityKey = resolveModelCatalogIdentityKey(entry),
): string {
  return [identityKey, entry.api ?? "", normalizeRouteBaseUrl(entry.baseUrl)].join("\0");
}

function mergeHarnessCompat(
  observed: ModelCatalogEntry["compat"],
  provider: ModelCatalogEntry["compat"],
): ModelCatalogEntry["compat"] {
  if (!observed && !provider) {
    return undefined;
  }
  const compat = { ...provider, ...observed };
  if (observed?.supportedReasoningEfforts?.length === 0) {
    return { ...compat, supportsReasoningEffort: false, supportedReasoningEfforts: [] };
  }
  const efforts = [
    ...new Set([
      ...(provider?.supportedReasoningEfforts ?? []),
      ...(observed?.supportedReasoningEfforts ?? []),
    ]),
  ];
  return efforts.length > 0
    ? { ...compat, supportsReasoningEffort: true, supportedReasoningEfforts: efforts }
    : compat;
}

function enrichHarnessRows(
  rows: readonly ModelCatalogEntry[],
  snapshot: ModelCatalogSnapshot,
): ModelCatalogEntry[] {
  const routeDonors = new Map<string, ModelCatalogEntry>();
  const identityDonors = new Map<string, ModelCatalogEntry>();
  let donorsPrepared = false;
  return rows.map((entry) => {
    // Native discovery owns these capabilities; host donors cannot invent its transport.
    if (entry.nativeRuntime) {
      return entry;
    }
    if (!donorsPrepared) {
      // First donor wins: live snapshot entries take precedence over static rows.
      for (const donor of [...snapshot.entries, ...(snapshot.staticEntries ?? [])]) {
        const identityKey = resolveModelCatalogIdentityKey(donor);
        const routeKey = routeVariantKey(donor, identityKey);
        if (!routeDonors.has(routeKey)) {
          routeDonors.set(routeKey, donor);
        }
        if (!identityDonors.has(identityKey)) {
          identityDonors.set(identityKey, donor);
        }
      }
      donorsPrepared = true;
    }
    const identityKey = resolveModelCatalogIdentityKey(entry);
    const donor =
      routeDonors.get(routeVariantKey(entry, identityKey)) ??
      (entry.api === undefined && entry.baseUrl === undefined
        ? identityDonors.get(identityKey)
        : undefined);
    if (!donor) {
      return entry;
    }
    const compat = mergeHarnessCompat(entry.compat, donor.compat);
    const mergedParams =
      donor.params || entry.params ? { ...donor.params, ...entry.params } : undefined;
    return {
      ...donor,
      ...entry,
      ...(mergedParams ? { params: mergedParams } : {}),
      ...(compat ? { compat } : {}),
    };
  });
}

function resolveHarnessRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  selection: AgentHarnessPluginSelection;
  snapshot: ModelCatalogSnapshot;
}): string {
  const requestedRuntime = normalizeOptionalAgentRuntimeId(params.selection.runtime);
  if (requestedRuntime && !isDefaultAgentRuntimeId(requestedRuntime)) {
    return requestedRuntime;
  }
  const refKey = resolveModelCatalogIdentityKey({
    provider: params.selection.provider,
    id: params.selection.modelId,
  });
  const routeEntry = [...params.snapshot.entries, ...(params.snapshot.staticEntries ?? [])].find(
    (entry) => resolveModelCatalogIdentityKey(entry) === refKey,
  );
  return resolveAgentHarnessPolicy({
    provider: params.selection.provider,
    modelId: params.selection.modelId,
    modelApi: routeEntry?.api,
    modelBaseUrl: routeEntry?.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  }).runtime;
}

export async function augmentModelCatalogWithAgentHarnesses(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  modelSelections: readonly AgentHarnessPluginSelection[];
  snapshot: ModelCatalogSnapshot;
  pluginRegistry?: PluginRegistry | null;
  reuseLoadedNativeRuntimes?: boolean;
  onError?: (error: unknown) => void;
}): Promise<ModelCatalogSnapshot> {
  const usesActiveRegistry = params.pluginRegistry == null;
  const pluginRegistry = params.pluginRegistry ?? getActivePluginRegistry();
  const loadedNativeRuntimes = params.reuseLoadedNativeRuntimes
    ? new Set(
        [...params.snapshot.entries, ...params.snapshot.routeVariants].map(
          (entry) => entry.nativeRuntime,
        ),
      )
    : undefined;
  const seenRuntimes = new Set<string>();
  const catalogLoaders: LoadHarnessModelCatalog[] = [];
  // Every selected fallback can become the executing route. Discover each distinct runtime once
  // so catalog capabilities never depend on which runtime happens to own the primary model.
  for (const selection of params.modelSelections) {
    const runtime = resolveHarnessRuntime({ ...params, selection });
    if (
      runtime === "auto" ||
      runtime === "openclaw" ||
      seenRuntimes.has(runtime) ||
      loadedNativeRuntimes?.has(runtime)
    ) {
      continue;
    }
    seenRuntimes.add(runtime);
    const harness = pluginRegistry?.agentHarnesses.find(
      (entry) => entry.harness.id === runtime,
    )?.harness;
    if (harness?.loadModelCatalog) {
      catalogLoaders.push(harness.loadModelCatalog.bind(harness));
    }
  }
  if (catalogLoaders.length === 0) {
    return params.snapshot;
  }
  const listedRows = await Promise.all(
    catalogLoaders.map(async (loadModelCatalog) => {
      try {
        return await loadModelCatalog({
          config: params.cfg,
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
        });
      } catch (error) {
        params.onError?.(error);
        return [];
      }
    }),
  );
  if (usesActiveRegistry && getActivePluginRegistry() !== pluginRegistry) {
    return params.snapshot;
  }
  const rows = listedRows.flatMap((entries) => enrichHarnessRows(entries, params.snapshot));
  if (rows.length === 0) {
    return params.snapshot;
  }
  return {
    ...params.snapshot,
    entries: dedupeByKey([...rows, ...params.snapshot.entries], resolveModelCatalogIdentityKey),
    routeVariants: dedupeByKey([...rows, ...params.snapshot.routeVariants], routeVariantKey),
  };
}

export function augmentPreparedModelCatalogWithAgentHarnesses(params: {
  input: PreparedModelRuntimeInput;
  snapshot: ModelCatalogSnapshot;
  pluginRegistry?: PluginRegistry;
}): Promise<ModelCatalogSnapshot> {
  const agentId = params.input.agentId ?? resolveDefaultAgentId(params.input.config);
  const defaultModel = resolveAgentEffectiveModelPrimary(params.input.config, agentId)?.trim();
  const defaultRef = defaultModel
    ? resolveModelRefFromString({
        cfg: params.input.config,
        raw: defaultModel,
        defaultProvider: DEFAULT_PROVIDER,
        allowManifestNormalization: true,
        allowPluginNormalization: true,
      })?.ref
    : undefined;
  const modelSelections =
    params.input.runtimePluginSelections ??
    (defaultRef ? [{ provider: defaultRef.provider, modelId: defaultRef.model, agentId }] : []);
  return augmentModelCatalogWithAgentHarnesses({
    cfg: params.input.config,
    agentId,
    agentDir: params.input.agentDir,
    workspaceDir:
      params.input.workspaceDir ??
      resolveAgentWorkspaceDir(params.input.config, agentId) ??
      resolveDefaultAgentWorkspaceDir(),
    modelSelections,
    snapshot: params.snapshot,
    pluginRegistry: params.pluginRegistry,
    // Prepared native rows prove that this generation already captured the runtime catalog.
    // Reopening its loader would violate the lifecycle-owned no-rediscovery boundary.
    reuseLoadedNativeRuntimes: true,
  });
}
