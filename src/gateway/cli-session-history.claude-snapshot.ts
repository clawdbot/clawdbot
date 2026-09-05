import fs from "node:fs";
import readline from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliSessionReseedReceipt } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import {
  appendCoalescedClaudeCliToolMessage,
  createClaudeReseedImportState,
  decodeClaudeCliProjectEntry,
  type ClaudeCliProjectEntry,
  parseClaudeCliHistoryEntry,
  redactClaudeCliHistoryMessage,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";

const YIELD_BYTES = 256 * 1024;
const OFFTHREAD_JSONL_LINE_CHARS = 1024 * 1024;
const OVERSIZED_HISTORY_PLACEHOLDER =
  "[Claude CLI history record omitted from context because it exceeded 1 MiB.]";
const OVERSIZED_ENTRY_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const boundedString = (value, max) =>
    typeof value === "string" && value.length <= max ? value : undefined;
  try {
    const entry = JSON.parse(workerData);
    const type = entry?.type;
    const message = entry?.message;
    if ((type !== "user" && type !== "assistant") || !message || message.role !== type) {
      parentPort.postMessage(null);
    } else {
      const rawUsage = message.usage;
      const usage = rawUsage && typeof rawUsage === "object"
        ? Object.fromEntries(
            ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
              .flatMap((key) => Number.isFinite(rawUsage[key]) ? [[key, rawUsage[key]]] : []),
          )
        : undefined;
      parentPort.postMessage({
        type,
        timestamp: boundedString(entry.timestamp, 128),
        uuid: boundedString(entry.uuid, 1_024),
        isSidechain: entry.isSidechain === true,
        isMeta: entry.isMeta === true,
        isCompactSummary: entry.isCompactSummary === true,
        isVisibleInTranscriptOnly: entry.isVisibleInTranscriptOnly === true,
        message: {
          role: type,
          content: ${JSON.stringify(OVERSIZED_HISTORY_PLACEHOLDER)},
          model: boundedString(message.model, 256),
          stop_reason: boundedString(message.stop_reason, 128),
          usage,
        },
      });
    }
  } catch {
    parentPort.postMessage(null);
  }
`;
type Message = Record<string, unknown>;
type HistoryParams = {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
};
let snapshotCache: { key: string; pending: Promise<readonly Message[]> } | undefined;

function normalizeOversizedEntry(value: unknown): ClaudeCliProjectEntry | null {
  if (!isRecord(value) || (value.type !== "user" && value.type !== "assistant")) {
    return null;
  }
  const message = value.message;
  if (!isRecord(message) || message.role !== value.type) {
    return null;
  }
  const usage = isRecord(message.usage) ? message.usage : undefined;
  return {
    type: value.type,
    ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
    ...(typeof value.uuid === "string" ? { uuid: value.uuid } : {}),
    ...(value.isSidechain === true ? { isSidechain: true } : {}),
    ...(value.isMeta === true ? { isMeta: true } : {}),
    ...(value.isCompactSummary === true ? { isCompactSummary: true } : {}),
    ...(value.isVisibleInTranscriptOnly === true ? { isVisibleInTranscriptOnly: true } : {}),
    message: {
      role: value.type,
      content: OVERSIZED_HISTORY_PLACEHOLDER,
      ...(typeof message.model === "string" ? { model: message.model } : {}),
      ...(typeof message.stop_reason === "string" ? { stop_reason: message.stop_reason } : {}),
      ...(usage
        ? {
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
            },
          }
        : {}),
    },
  };
}

async function decodeOversizedClaudeEntry(line: string): Promise<ClaudeCliProjectEntry | null> {
  let worker: Worker;
  try {
    worker = new Worker(OVERSIZED_ENTRY_WORKER_SOURCE, { eval: true, workerData: line });
  } catch {
    return null;
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(normalizeOversizedEntry(value));
    };
    worker.once("message", finish);
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

function fingerprint(stats: fs.Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

async function resolveSource(
  params: HistoryParams,
): Promise<readonly [filePath: string, cacheKey: string] | undefined> {
  const candidate = resolveClaudeCliSessionFilePath(params);
  if (!candidate) {
    return undefined;
  }
  try {
    const filePath = await fs.promises.realpath(candidate);
    const stats = await fs.promises.stat(filePath);
    const sourceFingerprint = fingerprint(stats);
    const cacheKey = JSON.stringify([
      filePath,
      sourceFingerprint,
      params.cliSessionId,
      params.localSessionId?.trim() || null,
      normalizeCliSessionReseedReceipt(params.reseedReceipt),
    ]);
    return [filePath, cacheKey];
  } catch {
    return undefined;
  }
}

async function parseSnapshot(filePath: string, params: HistoryParams): Promise<readonly Message[]> {
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const reseedState = createClaudeReseedImportState(params);
  let bytesSinceYield = 0;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const oversized = line.length > OFFTHREAD_JSONL_LINE_CHARS;
    if (oversized) {
      bytesSinceYield = 0;
    } else {
      bytesSinceYield += Buffer.byteLength(line, "utf8") + 1;
      if (bytesSinceYield >= YIELD_BYTES) {
        bytesSinceYield = 0;
        await yieldToEventLoop();
      }
      if (!line.trim()) {
        continue;
      }
    }
    try {
      // Keep large valid user/assistant records visible through a bounded projection;
      // unsupported external records are still ignored, but JSON.parse runs off-loop.
      const entry = oversized
        ? await decodeOversizedClaudeEntry(line)
        : decodeClaudeCliProjectEntry(line);
      if (!entry) {
        continue;
      }
      const message = parseClaudeCliHistoryEntry(
        entry,
        params.cliSessionId,
        lineNumber,
        toolNames,
        { reseedMode: "recover", reseedState },
      );
      if (message) {
        appendCoalescedClaudeCliToolMessage(messages, message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
  const redacted: Message[] = [];
  for (const [index, message] of messages.entries()) {
    if (index % 32 === 0) {
      await yieldToEventLoop();
    }
    redacted.push(redactClaudeCliHistoryMessage(message));
  }
  return Object.freeze(redacted);
}

export async function readClaudeCliSessionMessagesAsync(params: HistoryParams): Promise<Message[]> {
  const source = await resolveSource(params);
  if (!source) {
    return [];
  }
  const [filePath, cacheKey] = source;
  if (snapshotCache?.key !== cacheKey) {
    snapshotCache = { key: cacheKey, pending: parseSnapshot(filePath, params) };
  }
  const pending = snapshotCache.pending;
  let snapshot: readonly Message[];
  try {
    snapshot = await pending;
  } catch {
    if (snapshotCache?.pending === pending) {
      snapshotCache = undefined;
    }
    return [];
  }
  const messages: Message[] = [];
  for (const [index, message] of snapshot.entries()) {
    if (index % 32 === 0) {
      await yieldToEventLoop();
    }
    // The process cache owns redacted objects; callers receive isolated mutable copies.
    messages.push(structuredClone(message));
  }
  return messages;
}
