import fs from "node:fs";
import readline from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { CliSessionReseedReceipt } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import {
  appendCoalescedClaudeCliToolMessage,
  createClaudeReseedImportState,
  decodeClaudeCliProjectEntry,
  parseClaudeCliHistoryEntry,
  redactClaudeCliHistoryMessage,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";

const YIELD_BYTES = 256 * 1024;
type Message = Record<string, unknown>;
type HistoryParams = {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
};
let snapshotCache: { key: string; pending: Promise<readonly Message[]> } | undefined;

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
    bytesSinceYield += Buffer.byteLength(line, "utf8") + 1;
    if (bytesSinceYield >= YIELD_BYTES) {
      bytesSinceYield = 0;
      await yieldToEventLoop();
    }
    if (!line.trim()) {
      continue;
    }
    try {
      const message = parseClaudeCliHistoryEntry(
        decodeClaudeCliProjectEntry(line),
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
