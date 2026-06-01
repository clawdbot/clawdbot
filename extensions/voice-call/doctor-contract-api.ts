import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PluginDoctorStateMigration,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  buildVoiceCallLegacyJsonlEventKey,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENT_META_MAX_ENTRIES,
  CALL_RECORD_EVENTS_NAMESPACE,
  MAX_CALL_RECORD_EVENTS,
  MAX_CHUNKS_PER_CALL_RECORD_EVENT,
  prepareVoiceCallRecordForStorage,
  parseVoiceCallRecordLine,
  RAW_CALL_RECORD_CHUNK_BYTES,
  resolveVoiceCallLegacyCallLogPath,
} from "./src/manager/store.js";
import type { CallRecord } from "./src/types.js";

type CallRecordEventMeta = {
  chunkCount: number;
  byteLength: number;
  persistedAt?: number;
  sequence?: number;
};

type CallRecordEventChunk = {
  index: number;
  dataBase64: string;
};

type PreparedLegacyCallRecord = {
  eventKey: string;
  lineNumber: number;
  chunks: CallRecordEventChunk[];
  meta: CallRecordEventMeta;
};

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

function resolveUserPath(input: string, env: NodeJS.ProcessEnv): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, resolveHome(env)));
  }
  return path.resolve(trimmed);
}

function getVoiceCallConfigStore(config: PluginDoctorStateMigrationParams["config"]): string {
  for (const pluginId of ["voice-call", "@openclaw/voice-call"]) {
    const rawConfig = config.plugins?.entries?.[pluginId]?.config;
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }
    const store = (rawConfig as { store?: unknown }).store;
    if (typeof store === "string" && store.trim()) {
      return store.trim();
    }
  }
  return "";
}

type PluginDoctorStateMigrationParams = Parameters<
  PluginDoctorStateMigration["detectLegacyState"]
>[0];

function resolveVoiceCallStorePath(params: {
  config: PluginDoctorStateMigrationParams["config"];
  env: NodeJS.ProcessEnv;
}): string {
  const configuredStore = getVoiceCallConfigStore(params.config);
  if (configuredStore) {
    return resolveUserPath(configuredStore, params.env);
  }
  return path.join(resolveHome(params.env), ".openclaw", "voice-calls");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function buildChunkKey(eventKey: string, index: number): string {
  return `${eventKey}:chunk:${String(index).padStart(4, "0")}`;
}

function prepareChunks(call: CallRecord): {
  chunks: CallRecordEventChunk[];
  meta: CallRecordEventMeta;
} {
  const serialized = JSON.stringify(prepareVoiceCallRecordForStorage(call));
  const buffer = Buffer.from(serialized, "utf8");
  const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / RAW_CALL_RECORD_CHUNK_BYTES));
  if (chunkCount > MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    throw new Error(
      `voice-call record exceeds SQLite chunk limit (${chunkCount}/${MAX_CHUNKS_PER_CALL_RECORD_EVENT})`,
    );
  }
  const chunks: CallRecordEventChunk[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = buffer.subarray(
      index * RAW_CALL_RECORD_CHUNK_BYTES,
      (index + 1) * RAW_CALL_RECORD_CHUNK_BYTES,
    );
    chunks.push({ index, dataBase64: chunk.toString("base64") });
  }
  return {
    chunks,
    meta: {
      chunkCount,
      byteLength: buffer.byteLength,
    },
  };
}

async function readLegacyCallRecords(filePath: string): Promise<{
  entries: PreparedLegacyCallRecord[];
  warnings: string[];
}> {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return { entries: [], warnings: [] };
  }
  const entries: PreparedLegacyCallRecord[] = [];
  const warnings: string[] = [];
  let index = 0;
  for (const line of content.split("\n")) {
    const parsed = parseVoiceCallRecordLine(line, index);
    if (!parsed) {
      if (line.trim()) {
        warnings.push(`Skipped malformed Voice Call call-log line ${index + 1}`);
      }
      index += 1;
      continue;
    }
    try {
      const prepared = prepareChunks(parsed.call);
      entries.push({
        eventKey: buildVoiceCallLegacyJsonlEventKey(line, index),
        lineNumber: index + 1,
        chunks: prepared.chunks,
        meta: {
          ...prepared.meta,
          persistedAt: parsed.persistedAt,
          sequence: parsed.sequence,
        },
      });
    } catch (err) {
      warnings.push(`Skipped Voice Call call-log line ${index + 1}: ${String(err)}`);
    }
    index += 1;
  }
  return { entries, warnings };
}

async function archiveLegacySource(params: {
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Voice Call call-log source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Voice Call call-log legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving Voice Call call-log legacy source: ${String(err)}`);
  }
}

async function selectEntriesForImport(params: {
  entries: PreparedLegacyCallRecord[];
  eventStore: PluginStateKeyedStore<CallRecordEventMeta>;
  chunkStore: PluginStateKeyedStore<CallRecordEventChunk>;
  warnings: string[];
}): Promise<{ existingEventKeys: Set<string>; entries: PreparedLegacyCallRecord[] }> {
  const existingEventKeys = new Set((await params.eventStore.entries()).map((entry) => entry.key));
  const missingEntries = params.entries.filter((entry) => !existingEventKeys.has(entry.eventKey));
  const existingChunks = await params.chunkStore.entries();
  let eventRoom = Math.max(0, MAX_CALL_RECORD_EVENTS - existingEventKeys.size);
  let chunkRoom = Math.max(0, CALL_RECORD_CHUNK_MAX_ENTRIES - existingChunks.length);
  const selected: PreparedLegacyCallRecord[] = [];
  let pruned = 0;
  for (const entry of missingEntries.toReversed()) {
    if (eventRoom <= 0 || entry.chunks.length > chunkRoom) {
      pruned++;
      continue;
    }
    selected.push(entry);
    eventRoom--;
    chunkRoom -= entry.chunks.length;
  }
  if (pruned > 0) {
    params.warnings.push(
      `Pruned ${pruned} older Voice Call call-log ${pruned === 1 ? "record" : "records"} during migration because plugin state keeps the newest ${MAX_CALL_RECORD_EVENTS} records`,
    );
  }
  return { existingEventKeys, entries: selected.toReversed() };
}

async function importLegacyCallRecords(params: {
  entries: PreparedLegacyCallRecord[];
  eventStore: PluginStateKeyedStore<CallRecordEventMeta>;
  chunkStore: PluginStateKeyedStore<CallRecordEventChunk>;
  warnings: string[];
}): Promise<number> {
  const selected = await selectEntriesForImport(params);
  let imported = 0;
  for (const entry of selected.entries) {
    if (selected.existingEventKeys.has(entry.eventKey)) {
      continue;
    }
    try {
      for (const chunk of entry.chunks) {
        await params.chunkStore.register(buildChunkKey(entry.eventKey, chunk.index), chunk);
      }
      await params.eventStore.register(entry.eventKey, entry.meta);
      selected.existingEventKeys.add(entry.eventKey);
      imported++;
    } catch (err) {
      params.warnings.push(
        `Failed migrating Voice Call call-log line ${entry.lineNumber}: ${String(err)}`,
      );
    }
  }
  return imported;
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "voice-call-calls-jsonl-to-plugin-state",
    label: "Voice Call call log",
    async detectLegacyState(params) {
      const storePath = resolveVoiceCallStorePath(params);
      const filePath = resolveVoiceCallLegacyCallLogPath(storePath);
      const { entries } = await readLegacyCallRecords(filePath);
      if (entries.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Voice Call call log: ${entries.length} ${entries.length === 1 ? "record" : "records"} -> plugin state (${CALL_RECORD_EVENTS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const storePath = resolveVoiceCallStorePath(params);
      const filePath = resolveVoiceCallLegacyCallLogPath(storePath);
      const { entries, warnings: readWarnings } = await readLegacyCallRecords(filePath);
      warnings.push(...readWarnings);
      if (entries.length === 0) {
        return { changes, warnings };
      }
      const env = { ...params.env, OPENCLAW_STATE_DIR: storePath };
      const eventStore = params.context.openPluginStateKeyedStore<CallRecordEventMeta>({
        namespace: CALL_RECORD_EVENTS_NAMESPACE,
        maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
        env,
      });
      const chunkStore = params.context.openPluginStateKeyedStore<CallRecordEventChunk>({
        namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
        maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
        env,
      });
      const imported = await importLegacyCallRecords({
        entries,
        eventStore,
        chunkStore,
        warnings,
      });
      if (imported > 0) {
        changes.push(
          `Migrated ${imported} Voice Call call-log ${imported === 1 ? "record" : "records"} -> plugin state`,
        );
      }
      if (
        warnings.some(
          (warning) =>
            warning.startsWith("Failed migrating Voice Call") ||
            warning.startsWith("Skipped malformed Voice Call call-log line") ||
            warning.startsWith("Skipped Voice Call call-log line") ||
            warning.startsWith("Skipped Voice Call call-log migration"),
        )
      ) {
        warnings.push("Left Voice Call call-log source in place because migration was incomplete");
        return { changes, warnings };
      }
      await archiveLegacySource({ filePath, changes, warnings });
      return { changes, warnings };
    },
  },
];
