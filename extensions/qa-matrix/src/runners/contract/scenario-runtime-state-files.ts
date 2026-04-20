import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const MATRIX_SYNC_STORE_FILENAME = "bot-storage.json";
const MATRIX_INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";
const MATRIX_STATE_POLL_INTERVAL_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(pathname: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(pathname, "utf8")) as unknown;
}

async function writeJsonFile(pathname: string, value: unknown) {
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findFilesByName(params: {
  filename: string;
  rootDir: string;
  maxDepth?: number;
}): Promise<string[]> {
  const maxDepth = params.maxDepth ?? 8;
  const matches: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === params.filename) {
        matches.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      }
    }
  }
  await visit(params.rootDir, 0);
  return matches.toSorted();
}

function readPersistedMatrixSyncCursor(parsed: unknown): string | null {
  if (!isRecord(parsed)) {
    return null;
  }
  const savedSync = parsed.savedSync;
  if (isRecord(savedSync) && typeof savedSync.nextBatch === "string") {
    return savedSync.nextBatch;
  }
  if (typeof parsed.next_batch === "string") {
    return parsed.next_batch;
  }
  return null;
}

function writePersistedMatrixSyncCursor(parsed: unknown, cursor: string): unknown {
  if (!isRecord(parsed)) {
    throw new Error("Matrix sync store was not a JSON object");
  }
  const savedSync = parsed.savedSync;
  if (isRecord(savedSync) && typeof savedSync.nextBatch === "string") {
    return {
      ...parsed,
      savedSync: {
        ...savedSync,
        nextBatch: cursor,
      },
    };
  }
  if (typeof parsed.next_batch === "string") {
    return {
      ...parsed,
      next_batch: cursor,
    };
  }
  throw new Error("Matrix sync store did not contain a persisted sync cursor");
}

async function readMatrixSyncStoreCursor(pathname: string): Promise<string | null> {
  return readPersistedMatrixSyncCursor(await readJsonFile(pathname));
}

export async function rewriteMatrixSyncStoreCursor(params: { cursor: string; pathname: string }) {
  const parsed = await readJsonFile(params.pathname);
  await writeJsonFile(params.pathname, writePersistedMatrixSyncCursor(parsed, params.cursor));
}

async function scoreMatrixStateFile(params: {
  context: MatrixQaScenarioContext;
  pathname: string;
}) {
  let score = params.pathname.includes(`${path.sep}matrix${path.sep}`) ? 4 : 0;
  try {
    const metadata = await readJsonFile(
      path.join(path.dirname(params.pathname), "storage-meta.json"),
    );
    if (isRecord(metadata) && metadata.userId === params.context.sutUserId) {
      score += 16;
    }
    if (isRecord(metadata) && metadata.accountId === params.context.sutAccountId) {
      score += 8;
    }
  } catch {
    // Missing metadata is allowed; the Matrix client may not have flushed it yet.
  }
  return score;
}

async function resolveBestMatrixStateFile(params: {
  context: MatrixQaScenarioContext;
  filename: string;
  stateDir: string;
}) {
  const candidates = await findFilesByName({
    filename: params.filename,
    rootDir: params.stateDir,
  });
  if (candidates.length === 0) {
    return null;
  }
  const scored = await Promise.all(
    candidates.map(async (pathname) => ({
      pathname,
      score: await scoreMatrixStateFile({
        context: params.context,
        pathname,
      }),
    })),
  );
  scored.sort((a, b) => b.score - a.score || a.pathname.localeCompare(b.pathname));
  return scored[0]?.pathname ?? null;
}

export async function waitForMatrixSyncStoreWithCursor(params: {
  context: MatrixQaScenarioContext;
  stateDir: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let lastPath: string | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const pathname = await resolveBestMatrixStateFile({
      context: params.context,
      filename: MATRIX_SYNC_STORE_FILENAME,
      stateDir: params.stateDir,
    });
    lastPath = pathname;
    if (pathname) {
      const cursor = await readMatrixSyncStoreCursor(pathname);
      if (cursor) {
        return { cursor, pathname };
      }
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix sync store cursor under ${params.stateDir}; last path ${lastPath ?? "<none>"}`,
  );
}

function hasPersistedMatrixDedupeEntry(params: {
  parsed: unknown;
  roomId: string;
  eventId: string;
}) {
  if (!isRecord(params.parsed) || !Array.isArray(params.parsed.entries)) {
    return false;
  }
  const expectedKey = `${params.roomId}|${params.eventId}`;
  return params.parsed.entries.some((entry) => isRecord(entry) && entry.key === expectedKey);
}

export async function waitForMatrixInboundDedupeEntry(params: {
  context: MatrixQaScenarioContext;
  eventId: string;
  roomId: string;
  stateDir: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const pathname = await resolveBestMatrixStateFile({
      context: params.context,
      filename: MATRIX_INBOUND_DEDUPE_FILENAME,
      stateDir: params.stateDir,
    });
    if (pathname) {
      const parsed = await readJsonFile(pathname);
      if (
        hasPersistedMatrixDedupeEntry({
          parsed,
          roomId: params.roomId,
          eventId: params.eventId,
        })
      ) {
        return pathname;
      }
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix inbound dedupe commit for ${params.roomId}|${params.eventId}`,
  );
}
