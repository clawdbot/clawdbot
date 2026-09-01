import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
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

export async function augmentModelCatalogWithAgentHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  defaultProvider: string;
  defaultModel?: string;
  snapshot: ModelCatalogSnapshot;
  pluginRegistry?: PluginRegistry | null;
  onError?: (error: unknown) => void;
}): Promise<ModelCatalogSnapshot> {
  const rawDefaultModel = params.defaultModel?.trim();
  if (!rawDefaultModel) {
    return params.snapshot;
  }
  const ref = resolveModelRefFromString({
    cfg: params.cfg,
    raw: rawDefaultModel,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
  })?.ref;
  if (!ref) {
    return params.snapshot;
  }
  const refKey = resolveModelCatalogIdentityKey({ provider: ref.provider, id: ref.model });
  const routeEntry = [...params.snapshot.entries, ...(params.snapshot.staticEntries ?? [])].find(
    (entry) => resolveModelCatalogIdentityKey(entry) === refKey,
  );
  const runtime = resolveAgentHarnessPolicy({
    provider: ref.provider,
    modelId: ref.model,
    modelApi: routeEntry?.api,
    modelBaseUrl: routeEntry?.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  }).runtime;
  if (runtime === "auto" || runtime === "openclaw") {
    return params.snapshot;
  }
  const pluginRegistry = params.pluginRegistry ?? getActivePluginRegistry();
  const harness = pluginRegistry?.agentHarnesses.find(
    (entry) => entry.harness.id === runtime,
  )?.harness;
  if (!harness?.loadModelCatalog) {
    return params.snapshot;
  }
  try {
    const listedRows = await harness.loadModelCatalog({
      config: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    if (!params.pluginRegistry && getActivePluginRegistry() !== pluginRegistry) {
      return params.snapshot;
    }
    if (listedRows.length === 0) {
      return params.snapshot;
    }
    const rows = enrichHarnessRows(listedRows, params.snapshot);
    return {
      ...params.snapshot,
      entries: dedupeByKey([...rows, ...params.snapshot.entries], resolveModelCatalogIdentityKey),
      routeVariants: dedupeByKey([...rows, ...params.snapshot.routeVariants], routeVariantKey),
    };
  } catch (error) {
    params.onError?.(error);
    return params.snapshot;
  }
}

export function augmentPreparedModelCatalogWithAgentHarness(params: {
  input: PreparedModelRuntimeInput;
  snapshot: ModelCatalogSnapshot;
  pluginRegistry?: PluginRegistry;
}): Promise<ModelCatalogSnapshot> {
  const agentId = params.input.agentId ?? resolveDefaultAgentId(params.input.config);
  return augmentModelCatalogWithAgentHarness({
    cfg: params.input.config,
    agentId,
    agentDir: params.input.agentDir,
    workspaceDir:
      params.input.workspaceDir ??
      resolveAgentWorkspaceDir(params.input.config, agentId) ??
      resolveDefaultAgentWorkspaceDir(),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: resolveAgentEffectiveModelPrimary(params.input.config, agentId),
    snapshot: params.snapshot,
    pluginRegistry: params.pluginRegistry,
  });
}
