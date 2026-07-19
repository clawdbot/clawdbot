// Memory host event helpers append and read persisted memory host events.
import path from "node:path";
import {
  listStoredMemoryHostEvents,
  normalizeMemoryHostEventRecordForStorage,
  registerMemoryHostEvent,
} from "./event-store.js";
import type { MemoryHostEvent, MemoryHostEventRecord } from "./event-types.js";

export type {
  MemoryDreamOutcome,
  MemoryHostDreamCompletedEvent,
  MemoryHostEvent,
  MemoryHostEventRecord,
  MemoryHostPromotionAppliedEvent,
  MemoryHostRecallRecordedEvent,
  MemoryHostRecallSkippedEvent,
} from "./event-types.js";

export { normalizeMemoryHostEventRecordForStorage };

/** Legacy workspace JSONL path retained only for doctor migration discovery. */
export const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");

/** Resolve the retired JSONL source path without reading it at runtime. */
export function resolveMemoryHostEventLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}

/** Append one memory host event to shared SQLite plugin state. */
export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEventRecord,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  registerMemoryHostEvent({
    workspaceDir,
    event,
    ...(options.env ? { env: options.env } : {}),
  });
}

async function readMemoryHostEventRecordsRaw(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEventRecord[]> {
  const events = listStoredMemoryHostEvents(params).map((entry) => entry.value.event);
  return applyMemoryHostEventLimit(events, params.limit);
}

function applyMemoryHostEventLimit<T>(events: T[], limit: number | undefined): T[] {
  if (!Number.isFinite(limit)) {
    return events;
  }
  const normalizedLimit = Math.max(0, Math.floor(limit as number));
  return normalizedLimit === 0 ? [] : events.slice(-normalizedLimit);
}

/** Read recent memory host events, excluding opt-in diagnostic variants. */
export async function readMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEvent[]> {
  const events = await readMemoryHostEventRecordsRaw({
    workspaceDir: params.workspaceDir,
    ...(params.env ? { env: params.env } : {}),
  });
  const legacyEvents = events.filter(
    (event): event is MemoryHostEvent => event.type !== "memory.recall.skipped",
  );
  return applyMemoryHostEventLimit(legacyEvents, params.limit);
}

/** Read recent memory host event records, including opt-in diagnostic variants. */
export async function readMemoryHostEventRecords(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEventRecord[]> {
  return await readMemoryHostEventRecordsRaw(params);
}
