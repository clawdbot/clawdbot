// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, ModelCatalogCacheEntry>();

export async function loadModels(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelCatalogEntry[]> {
  const cached = modelCatalogCache.get(client);
  const now = Date.now();
  if (!opts?.refresh && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (!opts?.refresh && cached?.inFlight) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(client, cached?.models)
    .then((result) => {
      const latest = modelCatalogCache.get(client);
      if (!latest || latest.inFlight === inFlight) {
        modelCatalogCache.set(client, {
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          models: result.models,
        });
      }
      return result.models;
    })
    .finally(() => {
      const latest = modelCatalogCache.get(client);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  modelCatalogCache.set(client, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
  });
  return inFlight;
}

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
    });
    return { models: result?.models ?? [], fresh: true };
  } catch {
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}
