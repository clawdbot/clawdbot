import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CronPayload, CronSchedule } from "./types.js";

const DEFAULT_CRON_STREAM_BATCH_MS = 250;
const MIN_CRON_STREAM_BATCH_MS = 50;
const MAX_CRON_STREAM_BATCH_MS = 5_000;
const DEFAULT_CRON_STREAM_MAX_BATCH_BYTES = 16_384;
const MIN_CRON_STREAM_MAX_BATCH_BYTES = 1_024;
const MAX_CRON_STREAM_MAX_BATCH_BYTES = 65_536;
const CRON_STREAM_TRUNCATED_MARKER = "[truncated]";

export type CronStreamSchedule = Extract<CronSchedule, { kind: "stream" }>;

/** Opaque identity for one logical stream source across child-process restarts. */
export function createCronStreamSourceIdentity(): string {
  return randomUUID();
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("stream schedule batching values must be integers");
  }
  return Math.max(min, Math.min(max, value));
}

/** Resolve stream batching defaults without rewriting omitted public fields. */
export function resolveCronStreamBatching(schedule: CronStreamSchedule): {
  batchMs: number;
  maxBatchBytes: number;
} {
  return {
    batchMs: clampInteger(
      schedule.batchMs,
      DEFAULT_CRON_STREAM_BATCH_MS,
      MIN_CRON_STREAM_BATCH_MS,
      MAX_CRON_STREAM_BATCH_MS,
    ),
    maxBatchBytes: clampInteger(
      schedule.maxBatchBytes,
      DEFAULT_CRON_STREAM_MAX_BATCH_BYTES,
      MIN_CRON_STREAM_MAX_BATCH_BYTES,
      MAX_CRON_STREAM_MAX_BATCH_BYTES,
    ),
  };
}

/** Stable key for the source definition, with omitted defaults resolved. */
export function cronStreamScheduleKey(schedule: CronStreamSchedule): string {
  const batching = resolveCronStreamBatching(schedule);
  return JSON.stringify({
    command: schedule.command,
    cwd: schedule.cwd,
    mode: schedule.mode ?? "line",
    match: schedule.match,
    batchMs: batching.batchMs,
    maxBatchBytes: batching.maxBatchBytes,
  });
}

/** Clamp explicitly supplied stream batching fields during create/update normalization. */
export function normalizeCronStreamBatching(schedule: Record<string, unknown>): void {
  if (schedule.batchMs !== undefined) {
    if (typeof schedule.batchMs !== "number" || !Number.isSafeInteger(schedule.batchMs)) {
      throw new Error("stream schedule batchMs must be an integer");
    }
    schedule.batchMs = clampInteger(
      schedule.batchMs,
      DEFAULT_CRON_STREAM_BATCH_MS,
      MIN_CRON_STREAM_BATCH_MS,
      MAX_CRON_STREAM_BATCH_MS,
    );
  }
  if (schedule.maxBatchBytes !== undefined) {
    if (
      typeof schedule.maxBatchBytes !== "number" ||
      !Number.isSafeInteger(schedule.maxBatchBytes)
    ) {
      throw new Error("stream schedule maxBatchBytes must be an integer");
    }
    schedule.maxBatchBytes = clampInteger(
      schedule.maxBatchBytes,
      DEFAULT_CRON_STREAM_MAX_BATCH_BYTES,
      MIN_CRON_STREAM_MAX_BATCH_BYTES,
      MAX_CRON_STREAM_MAX_BATCH_BYTES,
    );
  }
}

function renderTruncatedCronStreamBatch(text: string, maxBytes: number): string {
  const markerBytes = Buffer.byteLength(CRON_STREAM_TRUNCATED_MARKER, "utf8");
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = truncateUtf16Safe(text, mid);
    if (Buffer.byteLength(candidate, "utf8") <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${truncateUtf16Safe(text, low)}${CRON_STREAM_TRUNCATED_MARKER}`;
}

/** Render known-truncated source text without exposing the marker to match filters. */
export function markCronStreamBatchTruncated(text: string, maxBytes: number): string {
  return renderTruncatedCronStreamBatch(text, maxBytes);
}

/** Keep a UTF-8 batch inside its byte budget and reserve room for the marker. */
export function truncateCronStreamBatch(text: string, maxBytes: number): string {
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? text
    : renderTruncatedCronStreamBatch(text, maxBytes);
}

/** Append event text through the same payload seam used by trigger messages. */
export function appendCronPayloadText(payload: CronPayload, text: string): CronPayload {
  if (payload.kind === "systemEvent") {
    return { ...payload, text: `${payload.text}\n\n${text}` };
  }
  if (payload.kind === "agentTurn") {
    return { ...payload, message: `${payload.message}\n\n${text}` };
  }
  return payload;
}
