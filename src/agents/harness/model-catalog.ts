import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { resolveModelRefFromString } from "../model-selection-shared.js";
import { openAIModelCatalogRoutePolicy } from "../openai-model-routes.js";
import type { PreparedModelRuntimeInput } from "../prepared-model-runtime.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../workspace.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

function catalogKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return (
    openAIModelCatalogRoutePolicy.resolveIdentity(entry)?.key ??
    `${normalizeProviderId(entry.provider)}/${entry.id.trim().toLowerCase()}`
  );
}

function mergeHarnessRows(
  rows: readonly ModelCatalogEntry[],
  existing: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const merged: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...rows, ...existing]) {
    const key = catalogKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

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

function routeVariantKey(entry: ModelCatalogEntry): string {
  return [catalogKey(entry), entry.api ?? "", normalizeRouteBaseUrl(entry.baseUrl)].join("\0");
}

function mergeHarnessRouteVariants(
  rows: readonly ModelCatalogEntry[],
  existing: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const merged: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...rows, ...existing]) {
    const key = routeVariantKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function enrichHarnessRows(
  rows: readonly ModelCatalogEntry[],
  snapshot: ModelCatalogSnapshot,
): ModelCatalogEntry[] {
  const donors = [...snapshot.entries, ...(snapshot.staticEntries ?? [])];
  return rows.map((entry) => {
    const donor = donors.find((candidate) => catalogKey(candidate) === catalogKey(entry));
    return donor
      ? {
          ...donor,
          ...entry,
          ...(donor.compat || entry.compat ? { compat: { ...donor.compat, ...entry.compat } } : {}),
        }
      : entry;
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
  const routeEntry = [...params.snapshot.entries, ...(params.snapshot.staticEntries ?? [])].find(
    (entry) => catalogKey(entry) === catalogKey({ provider: ref.provider, id: ref.model }),
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
    if (listedRows.length === 0) {
      return params.snapshot;
    }
    const rows = enrichHarnessRows(listedRows, params.snapshot);
    return {
      ...params.snapshot,
      entries: mergeHarnessRows(rows, params.snapshot.entries),
      routeVariants: mergeHarnessRouteVariants(rows, params.snapshot.routeVariants),
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
