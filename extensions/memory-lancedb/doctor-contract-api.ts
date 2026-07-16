import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  hasAgentScopeColumn,
  memoryAgentPredicate,
  MEMORY_AGENT_ID_COLUMN,
  MEMORY_TABLE_NAME,
  quoteLanceSqlString,
} from "./lancedb-schema.js";

type LanceDbModule = typeof import("@lancedb/lancedb");
type LanceDbConnection = Awaited<ReturnType<LanceDbModule["connect"]>>;

export function resolveMemoryLanceDbPluginRoot(moduleUrl: string): string {
  const artifactDir = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(artifactDir) === "dist" ? path.dirname(artifactDir) : artifactDir;
}

const DEFAULT_PLUGIN_ROOT = resolveMemoryLanceDbPluginRoot(import.meta.url);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

function resolveConfiguredDbPath(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  pluginRoot: string,
): string {
  const pluginConfig = asRecord(config.plugins?.entries?.["memory-lancedb"]?.config);
  const configured = typeof pluginConfig?.dbPath === "string" ? pluginConfig.dbPath.trim() : "";
  if (!configured) {
    return path.join(resolveHome(env), ".openclaw", "memory", "lancedb");
  }
  if (configured.includes("://")) {
    return configured;
  }
  if (configured.startsWith("~")) {
    return path.resolve(configured.replace(/^~(?=$|[\\/])/, resolveHome(env)));
  }
  // Plugin runtime api.resolvePath() anchors relative paths at this same root.
  return path.resolve(pluginRoot, configured);
}

function resolveStorageOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const pluginConfig = asRecord(config.plugins?.entries?.["memory-lancedb"]?.config);
  const rawOptions = asRecord(pluginConfig?.storageOptions);
  if (!rawOptions) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(rawOptions).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`memory-lancedb storageOptions.${key} must be a string`);
      }
      return [
        key,
        value.replace(/\$\{([^}]+)\}/g, (_match, envName: string) => {
          const resolved = env[envName];
          if (!resolved) {
            throw new Error(`Environment variable ${envName} is not set`);
          }
          return resolved;
        }),
      ];
    }),
  );
}

async function openMemoryTable(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginRoot: string;
}): Promise<{
  connection: LanceDbConnection | null;
  table: Awaited<ReturnType<LanceDbConnection["openTable"]>> | null;
  dbPath: string;
}> {
  const dbPath = resolveConfiguredDbPath(params.config, params.env, params.pluginRoot);
  if (!dbPath.includes("://") && !fs.existsSync(dbPath)) {
    return { connection: null, table: null, dbPath };
  }
  const lancedb = await import("@lancedb/lancedb");
  const storageOptions = resolveStorageOptions(params.config, params.env);
  const connection = await lancedb.connect(dbPath, storageOptions ? { storageOptions } : {});
  const table = (await connection.tableNames()).includes(MEMORY_TABLE_NAME)
    ? await connection.openTable(MEMORY_TABLE_NAME)
    : null;
  return { connection, table, dbPath };
}

type StateMigrationParams = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

export function createMemoryLanceDbStateMigrations(
  pluginRoot = DEFAULT_PLUGIN_ROOT,
): PluginDoctorStateMigration[] {
  return [
    {
      id: "memory-lancedb-agent-scope",
      label: "Memory LanceDB per-agent isolation",
      async detectLegacyState(params: StateMigrationParams) {
        const opened = await openMemoryTable({ ...params, pluginRoot });
        try {
          if (!opened.table || hasAgentScopeColumn(await opened.table.schema())) {
            return null;
          }
          const defaultAgentId = resolveDefaultAgentId(params.config);
          const count = await opened.table.countRows();
          return {
            preview: [
              `- Memory LanceDB: assign ${count} legacy ${count === 1 ? "row" : "rows"} at ${opened.dbPath} to default agent ${defaultAgentId}`,
            ],
          };
        } finally {
          opened.table?.close();
          opened.connection?.close();
        }
      },
      async migrateLegacyState(params: StateMigrationParams) {
        const opened = await openMemoryTable({ ...params, pluginRoot });
        try {
          if (!opened.table || hasAgentScopeColumn(await opened.table.schema())) {
            return { changes: [], warnings: [] };
          }
          const defaultAgentId = resolveDefaultAgentId(params.config);
          const rowCount = await opened.table.countRows();
          await opened.table.addColumns([
            {
              name: MEMORY_AGENT_ID_COLUMN,
              valueSql: quoteLanceSqlString(defaultAgentId),
            },
          ]);
          if (
            !hasAgentScopeColumn(await opened.table.schema()) ||
            (await opened.table.countRows(memoryAgentPredicate(defaultAgentId))) !== rowCount
          ) {
            throw new Error("LanceDB agent-scope migration verification failed");
          }
          return {
            changes: [
              `Assigned ${rowCount} legacy Memory LanceDB ${rowCount === 1 ? "row" : "rows"} to default agent ${defaultAgentId}`,
            ],
            warnings: [],
          };
        } finally {
          opened.table?.close();
          opened.connection?.close();
        }
      },
    },
  ];
}

export const stateMigrations = createMemoryLanceDbStateMigrations();
