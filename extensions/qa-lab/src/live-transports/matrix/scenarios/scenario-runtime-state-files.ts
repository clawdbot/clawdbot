// QA Lab Matrix plugin module implements scenario runtime state files behavior.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const MATRIX_SYNC_STORE_FILENAME = "bot-storage.json";
const MATRIX_PLUGIN_ID = "matrix";
const MATRIX_SYNC_CACHE_NAMESPACE = "sync-cache";
// Mirrors the matrix plugin's core claimable-dedupe state namespace:
// `matrix.inbound-dedupe.<hash>` (extensions/matrix monitor/inbound-dedupe.ts).
const MATRIX_INBOUND_DEDUPE_NAMESPACE_LIKE = "matrix.inbound-dedupe.%";
const MATRIX_STATE_POLL_INTERVAL_MS = 100;
const MATRIX_SYNC_CACHE_MAX_ENTRIES = 20_000;
const MATRIX_SYNC_CACHE_MAX_CHUNKS = Math.floor((MATRIX_SYNC_CACHE_MAX_ENTRIES - 1) / 2);
// PluginState serializes this string inside a row object; 24KB leaves room for JSON escaping.
const MATRIX_SYNC_CACHE_CHUNK_BYTES = 24_000;

type MatrixSyncStoreCursor = {
  cursor: string;
  pathname: string;
  source: "json" | "sqlite";
  stateKey?: string;
};

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
  if (typeof parsed.nextBatch === "string") {
    return {
      ...parsed,
      nextBatch: cursor,
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

function parsePluginStateJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readMatrixSyncCacheCursorFromRows(
  rows: Array<{ entryKey?: unknown; valueJson?: unknown }>,
): MatrixSyncStoreCursor[] {
  const rowsByKey = new Map<string, unknown>();
  for (const row of rows) {
    if (typeof row.entryKey === "string") {
      rowsByKey.set(row.entryKey, parsePluginStateJson(row.valueJson));
    }
  }
  const cursors: MatrixSyncStoreCursor[] = [];
  for (const [entryKey, rawMeta] of rowsByKey) {
    if (!entryKey.endsWith(":meta") || !isRecord(rawMeta) || rawMeta.kind !== "meta") {
      continue;
    }
    const stateKey = entryKey.slice(0, -":meta".length);
    const generation = typeof rawMeta.generation === "string" ? rawMeta.generation : "";
    const chunkCount =
      typeof rawMeta.chunkCount === "number" &&
      Number.isSafeInteger(rawMeta.chunkCount) &&
      rawMeta.chunkCount <= MATRIX_SYNC_CACHE_MAX_CHUNKS
        ? rawMeta.chunkCount
        : 0;
    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = rowsByKey.get(`${stateKey}:sync:${generation}:${index}`);
      if (!isRecord(chunk) || typeof chunk.data !== "string") {
        chunks.length = 0;
        break;
      }
      chunks.push(chunk.data);
    }
    if (chunks.length === 0) {
      continue;
    }
    try {
      const cursor = readPersistedMatrixSyncCursor({
        savedSync: JSON.parse(chunks.join("")) as unknown,
      });
      if (cursor) {
        cursors.push({ cursor, pathname: "", source: "sqlite", stateKey });
      }
    } catch {
      continue;
    }
  }
  return cursors;
}

async function readMatrixSyncCacheCursorsFromSqlite(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  stateDir: string;
  userId?: string;
}): Promise<MatrixSyncStoreCursor[]> {
  const databasePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.stateDir,
    maxDepth: 10,
  });
  const cursors: Array<MatrixSyncStoreCursor & { score: number }> = [];
  try {
    const sqlite = await import("node:sqlite");
    for (const databasePath of databasePaths) {
      try {
        const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
          const rows = db
            .prepare(
              `SELECT entry_key AS entryKey, value_json AS valueJson
                 FROM plugin_state_entries
                WHERE plugin_id = ?
                  AND namespace = ?
                  AND (expires_at IS NULL OR expires_at > ?)`,
            )
            .all(MATRIX_PLUGIN_ID, MATRIX_SYNC_CACHE_NAMESPACE, Date.now()) as Array<{
            entryKey?: unknown;
            valueJson?: unknown;
          }>;
          for (const cursor of readMatrixSyncCacheCursorFromRows(rows)) {
            const storageRootDir = path.dirname(path.dirname(databasePath));
            cursors.push({
              ...cursor,
              pathname: databasePath,
              score: await scoreMatrixStateFile({
                context: params.context,
                pathname: path.join(storageRootDir, MATRIX_SYNC_STORE_FILENAME),
                ...(params.accountId ? { accountId: params.accountId } : {}),
                ...(params.userId ? { userId: params.userId } : {}),
              }),
            });
          }
        } finally {
          db.close();
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return cursors
    .toSorted((a, b) => b.score - a.score || a.pathname.localeCompare(b.pathname))
    .map(({ score: _score, ...cursor }) => cursor);
}

function chunkMatrixSyncCacheJson(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > MATRIX_SYNC_CACHE_CHUNK_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function rewriteMatrixSyncCacheRows(params: {
  cursor: string;
  pathname: string;
  stateKey: string;
}) {
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(params.pathname);
  try {
    const rows = db
      .prepare(
        `SELECT entry_key AS entryKey, value_json AS valueJson
           FROM plugin_state_entries
          WHERE plugin_id = ?
            AND namespace = ?
            AND entry_key LIKE ?`,
      )
      .all(MATRIX_PLUGIN_ID, MATRIX_SYNC_CACHE_NAMESPACE, `${params.stateKey}:%`) as Array<{
      entryKey?: unknown;
      valueJson?: unknown;
    }>;
    const meta = parsePluginStateJson(
      rows.find((row) => row.entryKey === `${params.stateKey}:meta`)?.valueJson,
    );
    if (!isRecord(meta)) {
      throw new Error("Matrix sync cache metadata row was missing");
    }
    const cursorEntry = readMatrixSyncCacheCursorFromRows(rows)[0];
    if (!cursorEntry) {
      throw new Error("Matrix sync cache did not contain a persisted sync cursor");
    }
    const generation = typeof meta.generation === "string" ? meta.generation : "";
    const chunkCount =
      typeof meta.chunkCount === "number" &&
      Number.isSafeInteger(meta.chunkCount) &&
      meta.chunkCount <= MATRIX_SYNC_CACHE_MAX_CHUNKS
        ? meta.chunkCount
        : 0;
    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = parsePluginStateJson(
        rows.find((row) => row.entryKey === `${params.stateKey}:sync:${generation}:${index}`)
          ?.valueJson,
      );
      if (!isRecord(chunk) || typeof chunk.data !== "string") {
        throw new Error("Matrix sync cache chunk row was missing");
      }
      chunks.push(chunk.data);
    }
    const syncJson = JSON.stringify(
      writePersistedMatrixSyncCursor(JSON.parse(chunks.join("")), params.cursor),
    );
    const nextGeneration = randomUUID().replaceAll("-", "");
    const nextChunks = chunkMatrixSyncCacheJson(syncJson);
    const now = Date.now();
    const upsert = db.prepare(
      `INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(plugin_id, namespace, entry_key)
       DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at, expires_at = NULL`,
    );
    for (const [index, data] of nextChunks.entries()) {
      upsert.run(
        MATRIX_PLUGIN_ID,
        MATRIX_SYNC_CACHE_NAMESPACE,
        `${params.stateKey}:sync:${nextGeneration}:${index}`,
        JSON.stringify({ kind: "sync-chunk", index, data }),
        now,
      );
    }
    upsert.run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:meta`,
      JSON.stringify({
        ...meta,
        generation: nextGeneration,
        chunkCount: nextChunks.length,
        syncDigest: digestText(syncJson),
      }),
      now,
    );
    db.prepare(
      `DELETE FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND entry_key LIKE ?
          AND entry_key NOT LIKE ?`,
    ).run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:sync:%`,
      `${params.stateKey}:sync:${nextGeneration}:%`,
    );
  } finally {
    db.close();
  }
}

export async function rewriteMatrixSyncStoreCursor(params: {
  cursor: string;
  pathname: string;
  source?: "json" | "sqlite";
  stateKey?: string;
}) {
  if (params.source === "sqlite" || params.stateKey) {
    if (!params.stateKey) {
      throw new Error("Matrix sync cache rewrite requires a state key");
    }
    await rewriteMatrixSyncCacheRows({
      cursor: params.cursor,
      pathname: params.pathname,
      stateKey: params.stateKey,
    });
    return;
  }
  const parsed = await readJsonFile(params.pathname);
  await writeJsonFile(params.pathname, writePersistedMatrixSyncCursor(parsed, params.cursor));
}

export async function deleteMatrixSyncStoreCursor(params: MatrixSyncStoreCursor) {
  if (params.source !== "sqlite" || !params.stateKey) {
    await fs.rm(params.pathname, { force: true });
    return;
  }
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(params.pathname);
  try {
    db.prepare(
      `DELETE FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND (entry_key = ? OR entry_key LIKE ?)`,
    ).run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:meta`,
      `${params.stateKey}:sync:%`,
    );
  } finally {
    db.close();
  }
}

async function scoreMatrixStateFile(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  pathname: string;
  userId?: string;
}) {
  let score = params.pathname.includes(`${path.sep}matrix${path.sep}`) ? 4 : 0;
  const expectedUserId = params.userId ?? params.context.sutUserId;
  const expectedAccountId = params.accountId ?? params.context.sutAccountId;
  try {
    const metadata = await readJsonFile(
      path.join(path.dirname(params.pathname), "storage-meta.json"),
    );
    if (isRecord(metadata) && metadata.userId === expectedUserId) {
      score += 16;
    }
    if (isRecord(metadata) && metadata.accountId === expectedAccountId) {
      score += 8;
    }
  } catch {
    // Missing metadata is allowed; the Matrix client may not have flushed it yet.
  }
  return score;
}

async function resolveBestMatrixStateFile(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  filename: string;
  stateDir: string;
  userId?: string;
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
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
      }),
    })),
  );
  scored.sort((a, b) => b.score - a.score || a.pathname.localeCompare(b.pathname));
  return scored[0]?.pathname ?? null;
}

export async function waitForMatrixSyncStoreWithCursor(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  stateDir: string;
  timeoutMs: number;
  userId?: string;
}) {
  const startedAt = Date.now();
  let lastPath: string | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const sqliteCursors = await readMatrixSyncCacheCursorsFromSqlite({
      context: params.context,
      stateDir: params.stateDir,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    });
    if (sqliteCursors.length > 0) {
      const cursor = sqliteCursors[0];
      if (cursor) {
        return cursor;
      }
    }
    const pathname = await resolveBestMatrixStateFile({
      context: params.context,
      filename: MATRIX_SYNC_STORE_FILENAME,
      stateDir: params.stateDir,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    });
    lastPath = pathname;
    if (pathname) {
      const cursor = await readMatrixSyncStoreCursor(pathname);
      if (cursor) {
        return { cursor, pathname, source: "json" as const };
      }
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix sync store cursor under ${params.stateDir}; last path ${lastPath ?? "<none>"}`,
  );
}

async function hasPersistedMatrixPluginStateDedupeEntry(params: {
  eventId: string;
  roomId: string;
  stateDir: string;
}): Promise<string | null> {
  // Mirrors extensions/matrix monitor/inbound-dedupe.ts: the persisted entry
  // value records the NUL-joined (account, room, event) dedupe key; suffix
  // matching keeps the probe independent of the runtime account id.
  const expectedKeySuffix = `\0${params.roomId.trim()}\0${params.eventId.trim()}`;
  const databasePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.stateDir,
    maxDepth: 10,
  });
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  for (const databasePath of databasePaths) {
    try {
      const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT value_json AS valueJson
               FROM plugin_state_entries
              WHERE plugin_id = ?
                AND namespace LIKE ?
                AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .all(MATRIX_PLUGIN_ID, MATRIX_INBOUND_DEDUPE_NAMESPACE_LIKE, Date.now()) as Array<{
          valueJson?: unknown;
        }>;
        const matched = rows.some((row) => {
          const entry = parsePluginStateJson(row.valueJson);
          return (
            isRecord(entry) &&
            typeof entry.key === "string" &&
            entry.key.endsWith(expectedKeySuffix)
          );
        });
        if (matched) {
          return databasePath;
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function waitForMatrixInboundDedupeEntry(params: {
  eventId: string;
  roomId: string;
  stateDir: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const sqlitePath = await hasPersistedMatrixPluginStateDedupeEntry({
      eventId: params.eventId,
      roomId: params.roomId,
      stateDir: params.stateDir,
    });
    if (sqlitePath) {
      return sqlitePath;
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix inbound dedupe commit for ${params.roomId}|${params.eventId}`,
  );
}
