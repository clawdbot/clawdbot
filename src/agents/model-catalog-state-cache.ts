import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
const AGENT_MODEL_CATALOG_CACHE_VERSION = 1;
const AGENT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

type AgentModelCatalogDatabase = Pick<OpenClawStateKyselyDatabase, "agent_model_catalogs">;

type CachedAgentModelCatalogPayload = {
  version: typeof AGENT_MODEL_CATALOG_CACHE_VERSION;
  entries: readonly unknown[];
  routeVariants?: readonly unknown[];
};

type CachedAgentModelCatalogSnapshot = {
  entries: unknown[];
  routeVariants: unknown[];
};

type AgentModelCatalogCacheKeyInput = {
  agentDir: string;
  cacheScope?: unknown;
  config: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

type ReadCachedAgentModelCatalogParams = {
  agentDir: string;
  catalogKey: string;
  nowMs?: number;
};

type WriteCachedAgentModelCatalogParams = {
  agentDir: string;
  catalogKey: string;
  entries: readonly unknown[];
  routeVariants?: readonly unknown[];
  nowMs?: number;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function metadataSnapshotCacheShape(snapshot: PluginMetadataSnapshot | undefined): unknown {
  if (!snapshot) {
    return undefined;
  }
  return {
    configFingerprint: snapshot.configFingerprint,
    policyHash: snapshot.policyHash,
    indexPolicyHash: snapshot.index?.policyHash,
    indexPlugins: snapshot.index?.plugins?.map((plugin) => ({
      enabled: plugin.enabled,
      id: plugin.pluginId,
      origin: plugin.origin,
    })),
    modelCatalogPlugins: snapshot.plugins.map((plugin) => ({
      id: plugin.id,
      modelCatalog: plugin.modelCatalog,
      origin: plugin.origin,
      version: plugin.version,
    })),
  };
}

export function buildAgentModelCatalogCacheKey(input: AgentModelCatalogCacheKeyInput): string {
  const payload = stableJson({
    version: AGENT_MODEL_CATALOG_CACHE_VERSION,
    agentDir: input.agentDir,
    cacheScope: input.cacheScope,
    workspaceDir: input.workspaceDir,
    config: input.config,
    metadataSnapshot: metadataSnapshotCacheShape(input.metadataSnapshot),
  });
  return `agent-model-catalog:v${AGENT_MODEL_CATALOG_CACHE_VERSION}:${createHash("sha256")
    .update(payload)
    .digest("hex")}`;
}

function parseCachedAgentModelCatalog(rawJson: string): CachedAgentModelCatalogPayload | undefined {
  const parsed = JSON.parse(rawJson) as CachedAgentModelCatalogPayload;
  if (parsed?.version !== AGENT_MODEL_CATALOG_CACHE_VERSION || !Array.isArray(parsed.entries)) {
    return undefined;
  }
  return parsed;
}

function readCachedAgentModelCatalogPayload(
  params: ReadCachedAgentModelCatalogParams,
): CachedAgentModelCatalogPayload | undefined {
  try {
    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<AgentModelCatalogDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("agent_model_catalogs")
        .select(["raw_json", "updated_at"])
        .where("catalog_key", "=", params.catalogKey)
        .where("agent_dir", "=", params.agentDir),
    );
    if (!row || (params.nowMs ?? Date.now()) - row.updated_at > AGENT_MODEL_CATALOG_CACHE_TTL_MS) {
      return undefined;
    }
    return parseCachedAgentModelCatalog(row.raw_json);
  } catch {
    return undefined;
  }
}

export function readCachedAgentModelCatalog(
  params: ReadCachedAgentModelCatalogParams,
): unknown[] | undefined {
  return readCachedAgentModelCatalogPayload(params)?.entries as unknown[] | undefined;
}

/** Reads only provenance-complete snapshots; legacy entry-only rows refresh. */
export function readCachedAgentModelCatalogSnapshot(
  params: ReadCachedAgentModelCatalogParams,
): CachedAgentModelCatalogSnapshot | undefined {
  const payload = readCachedAgentModelCatalogPayload(params);
  return payload && Array.isArray(payload.routeVariants)
    ? { entries: [...payload.entries], routeVariants: [...payload.routeVariants] }
    : undefined;
}

export function writeCachedAgentModelCatalog(params: WriteCachedAgentModelCatalogParams): void {
  if (params.entries.length === 0) {
    return;
  }
  try {
    const updatedAt = params.nowMs ?? Date.now();
    const rawJson = JSON.stringify({
      version: AGENT_MODEL_CATALOG_CACHE_VERSION,
      entries: params.entries,
      ...(params.routeVariants ? { routeVariants: params.routeVariants } : {}),
    } satisfies CachedAgentModelCatalogPayload);
    runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<AgentModelCatalogDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_model_catalogs")
          .where("updated_at", "<", updatedAt - AGENT_MODEL_CATALOG_CACHE_TTL_MS),
      );
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_model_catalogs")
          .values({
            catalog_key: params.catalogKey,
            agent_dir: params.agentDir,
            raw_json: rawJson,
            updated_at: updatedAt,
          })
          .onConflict((conflict) =>
            conflict.column("catalog_key").doUpdateSet({
              agent_dir: params.agentDir,
              raw_json: rawJson,
              updated_at: updatedAt,
            }),
          ),
      );
    });
  } catch {
    // Fall back to runtime discovery if local state storage is unavailable.
  }
}
