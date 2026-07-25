import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionCatalogSession } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { piSessionStore } from "./pi-session-paths.js";

const MAX_DISCOVERY_FILES = 10_000;
const SUMMARY_SCAN_BATCH_SIZE = 100;
const MAX_SUMMARY_CACHE_ENTRIES = 256;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY_LINE_BYTES = 1024 * 1024;
const APPEND_PROOF_EDGE_BYTES = 64 * 1024;
const IO_CONCURRENCY = 8;
const SESSION_ID_PATTERN = /^(?!-)[A-Za-z0-9._:-]{1,256}$/u;

type PiSessionSummary = SessionCatalogSession & { file: string };

type PiFileCandidate = {
  file: string;
  storeRoot: string;
  identity: string;
  mtimeMs: number;
  size: number;
};

type PiSummaryScanState = {
  header?: Record<string, unknown>;
  name?: string;
  firstMessage?: string;
  pending: Buffer;
  discarding: boolean;
  invalid: boolean;
};

type CachedSummary = PiFileCandidate & {
  summary?: PiSessionSummary;
  scanState: PiSummaryScanState;
  appendProof: { head: Buffer; tail: Buffer };
};

// Pi owns session-file mutation. The bounded cache resumes append-only metadata
// scans, avoiding a full reread every time an active transcript grows.
const summaryCache = new Map<string, CachedSummary>();
const threadFileCache = new Map<string, string>();

function threadCacheKey(storeRoot: string, threadId: string): string {
  return `${storeRoot}\0${threadId}`;
}

function forgetCachedSummary(file: string): void {
  const cached = summaryCache.get(file);
  const threadId = cached?.summary?.threadId;
  if (cached && threadId) {
    const key = threadCacheKey(cached.storeRoot, threadId);
    if (threadFileCache.get(key) === file) {
      threadFileCache.delete(key);
    }
  }
  summaryCache.delete(file);
}

function cacheSummary(file: string, value: CachedSummary): void {
  forgetCachedSummary(file);
  summaryCache.set(file, value);
  while (summaryCache.size > MAX_SUMMARY_CACHE_ENTRIES) {
    const oldest = summaryCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    forgetCachedSummary(oldest);
  }
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

async function discoverPiSessionFiles(
  env: NodeJS.ProcessEnv,
): Promise<{ root: string; files: string[] }> {
  const store = piSessionStore(env);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(store.root, { withFileTypes: true });
  } catch {
    return { root: store.root, files: [] };
  }
  if (store.flat) {
    return {
      root: store.root,
      files: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .slice(0, MAX_DISCOVERY_FILES)
        .map((entry) => path.join(store.root, entry.name)),
    };
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || files.length >= MAX_DISCOVERY_FILES) {
      continue;
    }
    const directory = path.join(store.root, entry.name);
    let children: Array<import("node:fs").Dirent>;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(path.join(directory, child.name));
        if (files.length >= MAX_DISCOVERY_FILES) {
          break;
        }
      }
    }
  }
  return { root: store.root, files };
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function piFileCandidates(env: NodeJS.ProcessEnv): Promise<PiFileCandidate[]> {
  const { root, files } = await discoverPiSessionFiles(env);
  const candidates = await mapConcurrent(files, IO_CONCURRENCY, async (file) => {
    try {
      const stats = await fs.stat(file);
      return stats.isFile()
        ? {
            file,
            storeRoot: root,
            identity: `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          }
        : undefined;
    } catch {
      return undefined;
    }
  });
  return candidates
    .filter((candidate): candidate is PiFileCandidate => candidate !== undefined)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

function parsePiJsonLines(content: string): Record<string, unknown>[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) {
      return [];
    }
    try {
      const value = JSON.parse(line) as unknown;
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function processSummaryLine(state: PiSummaryScanState, line: Buffer): void {
  const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  const entry = parsePiJsonLines(content.toString("utf8"))[0];
  if (!entry) {
    return;
  }
  if (!state.header) {
    if (entry.type !== "session") {
      state.invalid = true;
      return;
    }
    state.header = entry;
    return;
  }
  if (entry.type === "session_info") {
    // Latest metadata wins, including an explicit empty-name clear.
    state.name = optionalString(entry.name, 1_000);
  } else if (
    !state.firstMessage &&
    entry.type === "message" &&
    isRecord(entry.message) &&
    entry.message.role === "user"
  ) {
    state.firstMessage = optionalString(textFromContent(entry.message.content), 1_000);
  }
}

function appendSummaryBytes(state: PiSummaryScanState, bytes: Buffer): void {
  if (state.discarding || bytes.length === 0) {
    return;
  }
  if (state.pending.length + bytes.length > MAX_SUMMARY_LINE_BYTES) {
    state.pending = Buffer.alloc(0);
    state.discarding = true;
    return;
  }
  state.pending =
    state.pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([state.pending, bytes]);
}

async function scanSummaryAppend(
  candidate: PiFileCandidate,
  start: number,
  state: PiSummaryScanState,
): Promise<void> {
  if (start >= candidate.size || state.invalid) {
    return;
  }
  const stream = createReadStream(candidate.file, { start, end: candidate.size - 1 });
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      appendSummaryBytes(state, chunk.subarray(offset, end));
      if (newline < 0) {
        break;
      }
      if (!state.discarding) {
        processSummaryLine(state, state.pending);
      }
      state.pending = Buffer.alloc(0);
      state.discarding = false;
      if (state.invalid) {
        return;
      }
      offset = newline + 1;
    }
  }
}

async function readAppendProof(
  file: string,
  size: number,
): Promise<{ head: Buffer; tail: Buffer }> {
  const length = Math.min(size, APPEND_PROOF_EDGE_BYTES);
  if (length === 0) {
    return { head: Buffer.alloc(0), tail: Buffer.alloc(0) };
  }
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(length);
    const tail = Buffer.alloc(length);
    const [headRead, tailRead] = await Promise.all([
      handle.read(head, 0, length, 0),
      handle.read(tail, 0, length, size - length),
    ]);
    return {
      head: head.subarray(0, headRead.bytesRead),
      tail: tail.subarray(0, tailRead.bytesRead),
    };
  } finally {
    await handle.close();
  }
}

async function cachedPrefixIsUnchanged(candidate: PiFileCandidate, cached: CachedSummary) {
  if (cached.identity !== candidate.identity || cached.size >= candidate.size) {
    return false;
  }
  // Pi persists established sessions with appendFileSync. Its in-place rewrite
  // paths (notably version migration) rewrite the header, so the head proof
  // rejects them; the tail proof rejects truncation before later growth.
  const current = await readAppendProof(candidate.file, cached.size);
  return (
    current.head.equals(cached.appendProof.head) && current.tail.equals(cached.appendProof.tail)
  );
}

async function readPiSessionSummary(
  candidate: PiFileCandidate,
): Promise<PiSessionSummary | undefined> {
  const cached = summaryCache.get(candidate.file);
  if (cached?.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
    summaryCache.delete(candidate.file);
    summaryCache.set(candidate.file, cached);
    return cached.summary;
  }
  let summary: PiSessionSummary | undefined;
  let scanState: PiSummaryScanState;
  let appendProof: CachedSummary["appendProof"];
  try {
    // Pi normally appends JSONL. Resume only when bounded edge proofs show the
    // previously indexed prefix survived; rewrites rebuild from byte zero.
    const resumable =
      cached && (await cachedPrefixIsUnchanged(candidate, cached)) ? cached : undefined;
    scanState = resumable
      ? {
          ...resumable.scanState,
          pending: Buffer.from(resumable.scanState.pending),
        }
      : {
          pending: Buffer.alloc(0),
          discarding: false,
          invalid: false,
        };
    await scanSummaryAppend(candidate, resumable?.size ?? 0, scanState);
    appendProof = await readAppendProof(candidate.file, candidate.size);
    // A complete final record is valid without a newline. Project it from a
    // clone so later appends can still finish the cached pending line once.
    const projectedState = { ...scanState, pending: Buffer.from(scanState.pending) };
    if (!projectedState.discarding && projectedState.pending.length > 0) {
      processSummaryLine(projectedState, projectedState.pending);
    }
    const { header, name, firstMessage } = projectedState;
    const threadId = header?.type === "session" ? optionalString(header.id, 256) : undefined;
    if (header && threadId && SESSION_ID_PATTERN.test(threadId)) {
      const cwd = optionalString(header.cwd, 4_096);
      const createdAt = timestampMs(header.timestamp);
      summary = {
        file: candidate.file,
        threadId,
        ...(name || firstMessage ? { name: name ?? firstMessage } : {}),
        ...(cwd ? { cwd } : {}),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        updatedAt: candidate.mtimeMs,
        recencyAt: candidate.mtimeMs,
        source: "pi-cli",
        modelProvider: "pi",
        archived: false,
        canContinue: false,
        canArchive: false,
      };
    }
  } catch {
    // Permissions and concurrent file replacement are retryable. Preserve the
    // last good index instead of poisoning future append scans.
    return cached?.summary;
  }
  if (cached?.summary?.threadId && cached.summary.threadId !== summary?.threadId) {
    threadFileCache.delete(threadCacheKey(cached.storeRoot, cached.summary.threadId));
  }
  cacheSummary(candidate.file, { ...candidate, summary, scanState, appendProof });
  if (summary) {
    threadFileCache.set(threadCacheKey(candidate.storeRoot, summary.threadId), candidate.file);
  }
  return summary;
}

function summaryMatches(summary: PiSessionSummary, needle?: string): boolean {
  if (!needle) {
    return true;
  }
  return [summary.threadId, summary.name, summary.cwd].some((field) =>
    field?.toLocaleLowerCase().includes(needle),
  );
}

export async function listPiSummaryPage(
  env: NodeJS.ProcessEnv,
  params: { offset: number; limit: number; searchTerm?: string },
): Promise<{ summaries: PiSessionSummary[]; hasMore: boolean }> {
  const candidates = await piFileCandidates(env);
  const activeFiles = new Set(candidates.map((candidate) => candidate.file));
  for (const file of summaryCache.keys()) {
    if (!activeFiles.has(file)) {
      forgetCachedSummary(file);
    }
  }
  const target = params.offset + params.limit + 1;
  const matches: PiSessionSummary[] = [];
  const needle = params.searchTerm?.toLocaleLowerCase();
  for (
    let index = 0;
    index < candidates.length && matches.length < target;
    index += SUMMARY_SCAN_BATCH_SIZE
  ) {
    const batch = candidates.slice(index, index + SUMMARY_SCAN_BATCH_SIZE);
    const summaries = await mapConcurrent(batch, IO_CONCURRENCY, readPiSessionSummary);
    for (const summary of summaries) {
      if (summary && summaryMatches(summary, needle)) {
        matches.push(summary);
        if (matches.length >= target) {
          break;
        }
      }
    }
  }
  return {
    summaries: matches.slice(params.offset, params.offset + params.limit),
    hasMore: matches.length > params.offset + params.limit,
  };
}

async function findPiSummary(
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<PiSessionSummary | undefined> {
  const candidates = await piFileCandidates(env);
  for (let index = 0; index < candidates.length; index += SUMMARY_SCAN_BATCH_SIZE) {
    const summaries = await mapConcurrent(
      candidates.slice(index, index + SUMMARY_SCAN_BATCH_SIZE),
      IO_CONCURRENCY,
      readPiSessionSummary,
    );
    const match = summaries.find((summary) => summary?.threadId === threadId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export async function readPiSessionById(
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>[]> {
  const cacheKey = threadCacheKey(piSessionStore(env).root, threadId);
  let file = threadFileCache.get(cacheKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!file) {
      file = (await findPiSummary(threadId, env))?.file;
    }
    if (!file) {
      throw new Error("Pi session was not found");
    }
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) {
        throw new Error("Pi session is not a file");
      }
      if (stats.size > MAX_SESSION_BYTES) {
        throw new RangeError("Pi session exceeds the 32 MiB read safety limit");
      }
      const entries = parsePiJsonLines(await fs.readFile(file, "utf8"));
      if (entries[0]?.type === "session" && entries[0].id === threadId) {
        return entries;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        throw error;
      }
      if (attempt > 0) {
        throw new Error("Pi session is unavailable", { cause: error });
      }
    }
    // The cached path can disappear when Pi replaces or prunes a session file.
    threadFileCache.delete(cacheKey);
    file = undefined;
  }
  throw new Error("Pi session changed during read");
}
