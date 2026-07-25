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
type LanceDbTable = Awaited<ReturnType<LanceDbConnection["openTable"]>>;

const LEGACY_ENVELOPE_DELETE_BATCH_SIZE = 500;

// Deletion predicate mirrors the recall filter shipped BEFORE the plain-label
// rename (index.ts sentinel/label/header rules): doctor only deletes rows that
// filter already hid from agent recall, and that capture sanitization would
// never store today. Accepted tradeoff: raw `ltm list/search` output loses
// these sludge rows too, including any salvageable trailer text.
// Mid-line mentions of the old wording (colon not at end of line) survive.
const LEGACY_ENVELOPE_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply target of current user message (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Conversation context (untrusted, chronological, selected for current message):",
  "Current local chat window (untrusted, chronological, before current message):",
  "Nearby reply target window (untrusted, chronological, around replied-to message):",
  "Chat history since last reply (untrusted, for context):",
] as const;
const LEGACY_ENVELOPE_SENTINEL_LINE_RE = new RegExp(
  `^(?:${LEGACY_ENVELOPE_SENTINELS.map((sentinel) =>
    sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})[^\\n]*$`,
  "m",
);
const LEGACY_ENVELOPE_LABEL_LINE_RE =
  /^[^\n]+\((?:untrusted metadata|untrusted, for context|untrusted, nearest first|untrusted, chronological,[^\n)]{1,80})\):[ \t]*$/m;
const LEGACY_ENVELOPE_HEADER_RE = /^Untrusted context \(metadata/m;

function isLegacyEnvelopeContaminatedText(text: unknown): boolean {
  return (
    typeof text === "string" &&
    (LEGACY_ENVELOPE_SENTINEL_LINE_RE.test(text) ||
      LEGACY_ENVELOPE_LABEL_LINE_RE.test(text) ||
      LEGACY_ENVELOPE_HEADER_RE.test(text))
  );
}

async function scanLegacyEnvelopeRowIds(table: LanceDbTable): Promise<string[]> {
  const contaminatedIds: string[] = [];
  // Stream record batches instead of toArray(): scan holds one batch of
  // id/text at a time so large or remote tables do not materialize fully.
  for await (const batch of table.query().select(["id", "text"])) {
    for (const row of batch.toArray() as Array<Record<string, unknown>>) {
      if (!isLegacyEnvelopeContaminatedText(row.text)) {
        continue;
      }
      if (typeof row.id !== "string") {
        throw new Error("LanceDB legacy envelope row is missing a string id");
      }
      contaminatedIds.push(row.id);
    }
  }
  return contaminatedIds;
}

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
  table: LanceDbTable | null;
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
    {
      id: "memory-lancedb-legacy-envelope-rows",
      label: "Memory LanceDB legacy envelope contamination",
      // Row deletion is destructive; gate it behind explicit `doctor --fix` so
      // startup auto-migration never purges memories without operator intent.
      doctorOnly: true,
      async detectLegacyState(params: StateMigrationParams) {
        const opened = await openMemoryTable({ ...params, pluginRoot });
        try {
          if (!opened.table) {
            return null;
          }
          const contaminatedIds = await scanLegacyEnvelopeRowIds(opened.table);
          if (contaminatedIds.length === 0) {
            return null;
          }
          return {
            preview: [
              `- Memory LanceDB: delete ${contaminatedIds.length} memory ${contaminatedIds.length === 1 ? "row" : "rows"} contaminated with legacy envelope metadata at ${opened.dbPath}`,
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
          if (!opened.table) {
            return { changes: [], warnings: [] };
          }
          const contaminatedIds = await scanLegacyEnvelopeRowIds(opened.table);
          if (contaminatedIds.length === 0) {
            return { changes: [], warnings: [] };
          }
          for (
            let offset = 0;
            offset < contaminatedIds.length;
            offset += LEGACY_ENVELOPE_DELETE_BATCH_SIZE
          ) {
            const batch = contaminatedIds.slice(offset, offset + LEGACY_ENVELOPE_DELETE_BATCH_SIZE);
            await opened.table.delete(
              `id IN (${batch.map((id) => quoteLanceSqlString(id)).join(", ")})`,
            );
          }
          if ((await scanLegacyEnvelopeRowIds(opened.table)).length !== 0) {
            throw new Error("LanceDB legacy envelope row migration verification failed");
          }
          return {
            changes: [
              `Deleted ${contaminatedIds.length} Memory LanceDB ${contaminatedIds.length === 1 ? "row" : "rows"} contaminated with legacy envelope metadata`,
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
