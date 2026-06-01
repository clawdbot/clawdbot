import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";

export const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";
export const CALL_RECORD_EVENT_CHUNKS_NAMESPACE = "call-record-event-chunks";
export const MAX_CALL_RECORD_EVENTS = 1000;
export const CALL_RECORD_EVENT_META_MAX_ENTRIES = MAX_CALL_RECORD_EVENTS + 100;
export const MAX_CHUNKS_PER_CALL_RECORD_EVENT = 48;
export const CALL_RECORD_CHUNK_MAX_ENTRIES =
  MAX_CALL_RECORD_EVENTS * MAX_CHUNKS_PER_CALL_RECORD_EVENT + MAX_CHUNKS_PER_CALL_RECORD_EVENT;
export const RAW_CALL_RECORD_CHUNK_BYTES = 47 * 1024;
let callRecordEventSequence = 0;

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

export type PersistedCallRecord = {
  call: CallRecord;
  persistedAt: number;
  sequence: number;
  orderKey: string;
};

type CallRecordStateStores = {
  events: PluginStateSyncKeyedStore<CallRecordEventMeta>;
  chunks: PluginStateSyncKeyedStore<CallRecordEventChunk>;
};

export function resolveVoiceCallLegacyCallLogPath(storePath: string): string {
  return path.join(storePath, "calls.jsonl");
}

function resolvePluginStateEnv(storePath: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: storePath };
}

function createCallRecordStateStores(storePath: string): CallRecordStateStores | null {
  const runtime = getOptionalVoiceCallStateRuntime();
  if (!runtime) {
    return null;
  }
  const env = resolvePluginStateEnv(storePath);
  return {
    events: runtime.state.openSyncKeyedStore<CallRecordEventMeta>({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    }),
    chunks: runtime.state.openSyncKeyedStore<CallRecordEventChunk>({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    }),
  };
}

function tryCreateCallRecordStateStores(storePath: string): CallRecordStateStores | null {
  try {
    return createCallRecordStateStores(storePath);
  } catch (err) {
    console.error("[voice-call] Failed to open SQLite call record store:", err);
    return null;
  }
}

function buildChunkKey(eventKey: string, index: number): string {
  return `${eventKey}:chunk:${String(index).padStart(4, "0")}`;
}

export function buildVoiceCallLegacyJsonlEventKey(line: string, index: number): string {
  return `jsonl:${String(index).padStart(8, "0")}:${createHash("sha256").update(line).digest("hex")}`;
}

function nextCallRecordOrder(): { persistedAt: number; sequence: number } {
  const sequence = callRecordEventSequence;
  callRecordEventSequence = (callRecordEventSequence + 1) % 1_000_000;
  return { persistedAt: Date.now(), sequence };
}

function buildNewEventKey(order: { persistedAt: number; sequence: number }): string {
  return `event:${order.persistedAt.toString(36)}:${String(order.sequence).padStart(6, "0")}:${randomUUID()}`;
}

function parseEventKeySequence(key: string): number {
  const match = /^event:[^:]+:(\d+):/.exec(key);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function parseVoiceCallRecordLine(line: string, sequence = 0): PersistedCallRecord | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2) {
      const envelope = parsed as {
        call?: unknown;
        persistedAt?: unknown;
        sequence?: unknown;
      };
      const call = CallRecordSchema.parse(envelope.call);
      return {
        call,
        persistedAt:
          typeof envelope.persistedAt === "number" && Number.isFinite(envelope.persistedAt)
            ? envelope.persistedAt
            : 0,
        sequence:
          typeof envelope.sequence === "number" && Number.isFinite(envelope.sequence)
            ? envelope.sequence
            : sequence,
        orderKey: "",
      };
    }
    return {
      call: CallRecordSchema.parse(parsed),
      persistedAt: 0,
      sequence,
      orderKey: "",
    };
  } catch {
    return null;
  }
}

function countCallRecordChunks(call: CallRecord): number {
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(JSON.stringify(call), "utf8") / RAW_CALL_RECORD_CHUNK_BYTES),
  );
}

export function prepareVoiceCallRecordForStorage(call: CallRecord): CallRecord {
  if (countCallRecordChunks(call) <= MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    return call;
  }
  const transcriptEntries = call.transcript.length;
  const metadata = {
    ...call.metadata,
    voiceCallPersistence: {
      transcriptTruncated: true,
      originalTranscriptEntries: transcriptEntries,
    },
  };
  const candidateInputs = [
    { transcript: call.transcript.slice(-20), metadata },
    { transcript: [], metadata },
    {
      transcript: [],
      metadata: {
        voiceCallPersistence: {
          transcriptTruncated: true,
          originalTranscriptEntries: transcriptEntries,
          metadataTruncated: true,
        },
      },
    },
  ];
  for (const candidateInput of candidateInputs) {
    const candidate = CallRecordSchema.parse({
      ...call,
      ...candidateInput,
    });
    if (countCallRecordChunks(candidate) <= MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
      return candidate;
    }
  }
  return call;
}

function registerCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  call: CallRecord,
  order?: { persistedAt: number; sequence: number },
): void {
  const serialized = JSON.stringify(prepareVoiceCallRecordForStorage(call));
  const buffer = Buffer.from(serialized, "utf8");
  const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / RAW_CALL_RECORD_CHUNK_BYTES));
  if (chunkCount > MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    throw new Error(
      `voice-call record exceeds SQLite chunk limit (${chunkCount}/${MAX_CHUNKS_PER_CALL_RECORD_EVENT})`,
    );
  }
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = buffer.subarray(
      index * RAW_CALL_RECORD_CHUNK_BYTES,
      (index + 1) * RAW_CALL_RECORD_CHUNK_BYTES,
    );
    stores.chunks.register(buildChunkKey(eventKey, index), {
      index,
      dataBase64: chunk.toString("base64"),
    });
  }
  stores.events.register(eventKey, {
    chunkCount,
    byteLength: buffer.byteLength,
    persistedAt: order?.persistedAt,
    sequence: order?.sequence,
  });
  pruneCallRecordEvents(stores);
}

function deleteCallRecordEventRows(stores: CallRecordStateStores, eventKey: string): void {
  const meta = stores.events.lookup(eventKey);
  stores.events.delete(eventKey);
  if (!meta) {
    return;
  }
  for (let index = 0; index < meta.chunkCount; index += 1) {
    stores.chunks.delete(buildChunkKey(eventKey, index));
  }
}

function pruneCallRecordEvents(stores: CallRecordStateStores): void {
  const rows = stores.events.entries();
  if (rows.length <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  const sorted = rows.toSorted((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  for (const row of sorted.slice(0, rows.length - MAX_CALL_RECORD_EVENTS)) {
    deleteCallRecordEventRows(stores, row.key);
  }
}

function readCallRecordEvent(stores: CallRecordStateStores, eventKey: string): CallRecord | null {
  const meta = stores.events.lookup(eventKey);
  if (!meta) {
    return null;
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = stores.chunks.lookup(buildChunkKey(eventKey, index));
    if (!chunk || chunk.index !== index) {
      return null;
    }
    chunks.push(Buffer.from(chunk.dataBase64, "base64"));
  }
  const serialized = Buffer.concat(chunks, meta.byteLength).toString("utf8");
  return parseVoiceCallRecordLine(serialized)?.call ?? null;
}

function readCallRecordEvents(stores: CallRecordStateStores): CallRecord[] {
  const sqliteCalls: PersistedCallRecord[] = stores.events
    .entries()
    .toSorted((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key))
    .map((entry) => {
      const call = readCallRecordEvent(stores, entry.key);
      return call
        ? {
            call,
            persistedAt: entry.value.persistedAt ?? entry.createdAt,
            sequence: entry.value.sequence ?? parseEventKeySequence(entry.key),
            orderKey: entry.key,
          }
        : null;
    })
    .filter((entry): entry is PersistedCallRecord => entry !== null);
  return sqliteCalls
    .toSorted(
      (a, b) =>
        a.persistedAt - b.persistedAt ||
        a.sequence - b.sequence ||
        a.orderKey.localeCompare(b.orderKey),
    )
    .map((entry) => entry.call);
}

export function persistCallRecord(storePath: string, call: CallRecord): void {
  try {
    const stores = createCallRecordStateStores(storePath);
    if (!stores) {
      throw new Error("Voice Call state runtime not initialized");
    }
    const order = nextCallRecordOrder();
    registerCallRecordEvent(stores, buildNewEventKey(order), call, order);
  } catch (err) {
    console.error("[voice-call] Failed to persist call record:", err);
    throw err;
  }
}

export async function flushPendingCallRecordWritesForTest(): Promise<void> {
  await Promise.resolve();
}

export function loadActiveCallsFromStore(storePath: string): {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  rejectedProviderCallIds: Set<string>;
} {
  const stores = tryCreateCallRecordStateStores(storePath);
  let calls: CallRecord[] = [];
  try {
    calls = stores ? readCallRecordEvents(stores) : [];
  } catch (err) {
    console.error("[voice-call] Failed to read SQLite call records:", err);
  }
  if (calls.length === 0) {
    return {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
      rejectedProviderCallIds: new Set(),
    };
  }
  const callMap = new Map<CallId, CallRecord>();
  for (const call of calls) {
    callMap.set(call.callId, call);
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const providerCallIdMap = new Map<string, CallId>();
  const processedEventIds = new Set<string>();
  const rejectedProviderCallIds = new Set<string>();

  for (const [callId, call] of callMap) {
    for (const eventId of call.processedEventIds) {
      processedEventIds.add(eventId);
    }
    if (TerminalStates.has(call.state)) {
      continue;
    }
    activeCalls.set(callId, call);
    if (call.providerCallId) {
      providerCallIdMap.set(call.providerCallId, callId);
    }
  }

  return { activeCalls, providerCallIdMap, processedEventIds, rejectedProviderCallIds };
}

export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
): Promise<CallRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const stores = tryCreateCallRecordStateStores(storePath);
  if (stores) {
    try {
      return readCallRecordEvents(stores).slice(-limit);
    } catch (err) {
      console.error("[voice-call] Failed to read SQLite call history:", err);
    }
  }
  return [];
}
