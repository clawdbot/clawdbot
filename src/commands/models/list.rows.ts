import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { shouldSuppressBuiltInModel } from "../../agents/model-suppression.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadModelRegistry, toModelRow } from "./list.registry.js";
import {
  loadModelCatalog,
  loadProviderCatalogModelsForList,
  resolveModelWithRegistry,
} from "./list.runtime.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

type ConfiguredByKey = Map<string, ConfiguredEntry>;

type RowFilter = {
  provider?: string;
  local?: boolean;
};

type RowBuilderContext = {
  cfg: OpenClawConfig;
  agentDir: string;
  authStore: AuthProfileStore;
  availableKeys?: Set<string>;
  configuredByKey: ConfiguredByKey;
  discoveredKeys: Set<string>;
  filter: RowFilter;
  skipRuntimeModelSuppression?: boolean;
};

function matchesRowFilter(filter: RowFilter, model: { provider: string; baseUrl?: string }) {
  if (filter.provider && normalizeProviderId(model.provider) !== filter.provider) {
    return false;
  }
  if (filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) {
    return false;
  }
  return true;
}

function buildRow(params: {
  model: Model<Api>;
  key: string;
  context: RowBuilderContext;
  allowProviderAvailabilityFallback?: boolean;
}): ModelRow {
  const configured = params.context.configuredByKey.get(params.key);
  return toModelRow({
    model: params.model,
    key: params.key,
    tags: configured ? Array.from(configured.tags) : [],
    aliases: configured?.aliases ?? [],
    availableKeys: params.context.availableKeys,
    cfg: params.context.cfg,
    authStore: params.context.authStore,
    allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback ?? false,
  });
}

function shouldSuppressListModel(params: {
  model: { provider: string; id: string; baseUrl?: string };
  context: RowBuilderContext;
}): boolean {
  if (params.context.skipRuntimeModelSuppression) {
    return false;
  }
  return shouldSuppressBuiltInModel({
    provider: params.model.provider,
    id: params.model.id,
    baseUrl: params.model.baseUrl,
    config: params.context.cfg,
  });
}

export async function loadListModelRegistry(
  cfg: OpenClawConfig,
  opts?: { sourceConfig?: OpenClawConfig; providerFilter?: string },
) {
  const loaded = await loadModelRegistry(cfg, opts);
  return {
    ...loaded,
    discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id))),
  };
}

export function appendDiscoveredRows(params: {
  rows: ModelRow[];
  models: Model<Api>[];
  context: RowBuilderContext;
}): Set<string> {
  const seenKeys = new Set<string>();
  const sorted = [...params.models].toSorted((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return a.id.localeCompare(b.id);
  });

  for (const model of sorted) {
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
      }),
    );
    seenKeys.add(key);
  }

  return seenKeys;
}

export async function appendCatalogSupplementRows(params: {
  rows: ModelRow[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const catalog = await loadModelCatalog({ config: params.context.cfg });
  for (const entry of catalog) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const key = modelKey(entry.provider, entry.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    const model = resolveModelWithRegistry({
      provider: entry.provider,
      modelId: entry.id,
      modelRegistry: params.modelRegistry,
      cfg: params.context.cfg,
    });
    if (!model || !matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
        allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
      }),
    );
    params.seenKeys.add(key);
  }

  if (params.context.filter.local) {
    return;
  }

  await appendProviderCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys: params.seenKeys,
  });
}

export async function appendProviderCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  for (const model of await loadProviderCatalogModelsForList({
    cfg: params.context.cfg,
    agentDir: params.context.agentDir,
    providerFilter: params.context.filter.provider,
  })) {
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
        allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
      }),
    );
    params.seenKeys.add(key);
  }
}

export function appendConfiguredRows(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
}) {
  for (const entry of params.entries) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.ref.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const model = resolveModelWithRegistry({
      provider: entry.ref.provider,
      modelId: entry.ref.model,
      modelRegistry: params.modelRegistry,
      cfg: params.context.cfg,
    });
    if (params.context.filter.local && model && !isLocalBaseUrl(model.baseUrl ?? "")) {
      continue;
    }
    if (params.context.filter.local && !model) {
      continue;
    }
    if (model && shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    params.rows.push(
      toModelRow({
        model,
        key: entry.key,
        tags: Array.from(entry.tags),
        aliases: entry.aliases,
        availableKeys: params.context.availableKeys,
        cfg: params.context.cfg,
        authStore: params.context.authStore,
        allowProviderAvailabilityFallback: model
          ? !params.context.discoveredKeys.has(modelKey(model.provider, model.id))
          : false,
      }),
    );
  }
}
