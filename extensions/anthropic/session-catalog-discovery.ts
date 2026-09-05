import fs from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type DesktopOverlay,
  desktopPullRequestSummary,
  emptyDesktopOverlay,
  MAX_STRING_LENGTH,
  readDesktopOverlay,
} from "./session-catalog-desktop.js";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";
import {
  CLAUDE_CATALOG_IO_CONCURRENCY,
  CLAUDE_PARTIAL_SCAN_TTL_MS,
  CLAUDE_SESSION_SCAN_HARD_TTL_MS,
  type ClaudeProjectsTreeSnapshot,
  type ClaudeSessionScanContext,
  projectsDir,
  readClaudeCatalogMetadata,
  readJsonFile,
  readProjectsTreeSnapshot,
  safeSessionFileForScan,
  setBoundedCache,
} from "./session-catalog-scan.js";
import { collectTranscriptText } from "./session-catalog-transcript.js";
import type { ClaudeSessionCatalogSession } from "./session-catalog-types.js";

const MAX_CATALOG_DISCOVERY_FILES = 10_000;
const MAX_CATALOG_DISCOVERY_CACHE_ENTRIES = 20_000;
const MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES = 8;
const MAX_CATALOG_METADATA_SCAN_BYTES = 64 * 1024 * 1024;
const CLI_ENTRYPOINTS = new Set(["cli", "sdk-cli"]);

type CatalogDiscoveryCacheEntry = {
  // The module-global cache is keyed by canonical transcript path, so an entry must also record the
  // discovery context it was built in. `root` is the logical (unresolved) projects root: it scopes
  // the entry to its homeDir even when the root itself is a symlink, so a different homeDir scan
  // cannot reuse it and eviction can find it without re-resolving a now-missing root. mtime+size+ino
  // detect any content change or atomic replacement; sessionId guards against a canonical path being
  // reached under a different filename-derived id (e.g. an aliased/renamed symlink).
  root: string;
  mtimeMs: number;
  size: number;
  ino: number;
  sessionId: string;
  // Bytes this file charged against the scan budget when first scanned. Cache hits re-charge it so
  // byte-budget-limited discovery stops at the same frontier whether or not the cache is warm,
  // keeping pagination deterministic across repeated identical calls.
  scannedBytes: number;
  record: CatalogRecord | null;
  metadata: Pick<ClaudeSessionCatalogSession, "name" | "color">;
  sidechain: boolean;
};

type ClaudeSessionScanCacheEntry = {
  treeStamp: string;
  hardExpiresAt: number;
  records: Promise<ClaudeCliScan>;
};

// Transcript discoveries stay valid only for the same root/id/inode/mtime/size and are LRU-bounded;
// a false hit would corrupt pagination, so warm scans re-charge the original deterministic byte cost.
const catalogDiscoveryCache = new Map<string, CatalogDiscoveryCacheEntry>();
// CLI scans are root-scoped and bounded; Desktop overlay expiry never invalidates their records.
const claudeSessionScanCache = new Map<string, ClaudeSessionScanCacheEntry>();

type ClaudeCliScan = Awaited<ReturnType<typeof scanClaudeSessions>>;
const mergedScans = new WeakMap<ClaudeCliScan, WeakMap<DesktopOverlay, Promise<CatalogRecord[]>>>();

function cacheCatalogDiscovery(filePath: string, entry: CatalogDiscoveryCacheEntry): void {
  setBoundedCache(catalogDiscoveryCache, filePath, entry, MAX_CATALOG_DISCOVERY_CACHE_ENTRIES);
}

function applyCatalogDiscovery(
  records: Map<string, CatalogRecord>,
  sessionId: string,
  discovery: Pick<CatalogDiscoveryCacheEntry, "record" | "metadata">,
): void {
  const record = records.get(sessionId) ?? discovery.record;
  if (record) {
    records.set(sessionId, {
      ...record,
      ...discovery.metadata,
      name: discovery.metadata.name ?? record.name ?? discovery.record?.name ?? null,
    });
  }
}

type SessionIndexEntry = {
  sessionId?: unknown;
  fullPath?: unknown;
  fileMtime?: unknown;
  firstPrompt?: unknown;
  summary?: unknown;
  messageCount?: unknown;
  created?: unknown;
  modified?: unknown;
  gitBranch?: unknown;
  projectPath?: unknown;
  isSidechain?: unknown;
};

export type CatalogRecord = ClaudeSessionCatalogSession & {
  filePath: string;
};

function isCliEntrypoint(value: unknown): value is string {
  return typeof value === "string" && CLI_ENTRYPOINTS.has(value);
}

// Claude's persisted string timestamps are date expressions, including numeric-looking years.
// Numeric fields are already millisecond values, so preserve that distinct mixed-input contract.
function parseClaudeCatalogTimestampMs(value: unknown): number | undefined {
  return parseDateFirstTimestampMs(value);
}

async function readIndexRecords(context: ClaudeSessionScanContext) {
  const records = new Map<string, CatalogRecord>();
  const sidechainIds = new Set<string>();
  if (!context.resolvedRoot) {
    return { records, sidechainIds };
  }
  const { results: indexes } = await runTasksWithConcurrency({
    tasks: context.projectDirectories.map(({ directory, childNames, files }) => async () => ({
      directory,
      raw: childNames.includes("sessions-index.json")
        ? await readJsonFile(path.join(directory, "sessions-index.json"), {
            signature: files.get("sessions-index.json"),
            onIoFailure: () => {
              context.complete = false;
            },
          })
        : undefined,
    })),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  for (const { directory, raw } of indexes) {
    if (!isRecord(raw) || !Array.isArray(raw.entries)) {
      continue;
    }
    for (const candidate of raw.entries) {
      if (!isRecord(candidate)) {
        continue;
      }
      const entry = candidate as SessionIndexEntry;
      const sessionId = readBoundedString(entry.sessionId, 256);
      if (!sessionId) {
        continue;
      }
      if (entry.isSidechain === true) {
        sidechainIds.add(sessionId);
        records.delete(sessionId);
        continue;
      }
      const indexedPath = readBoundedString(entry.fullPath, MAX_STRING_LENGTH);
      const safeFile = await safeSessionFileForScan(
        context,
        indexedPath ?? path.join(directory, `${sessionId}.jsonl`),
        sessionId,
      );
      if (!safeFile) {
        continue;
      }
      const createdAt = parseClaudeCatalogTimestampMs(entry.created);
      const updatedAt =
        parseClaudeCatalogTimestampMs(entry.modified) ??
        parseClaudeCatalogTimestampMs(entry.fileMtime);
      const summary = readBoundedString(entry.summary, 500);
      const firstPrompt = readBoundedString(entry.firstPrompt, 500);
      records.set(sessionId, {
        threadId: sessionId,
        name: summary ?? firstPrompt ?? null,
        cwd: readBoundedString(entry.projectPath, MAX_STRING_LENGTH),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
        source: "claude-cli",
        modelProvider: "anthropic",
        ...(readBoundedString(entry.gitBranch, 500)
          ? { gitBranch: readBoundedString(entry.gitBranch, 500) }
          : {}),
        archived: false,
        filePath: safeFile.filePath,
      });
    }
  }
  return { records, sidechainIds };
}

async function locateSessionFile(
  context: ClaudeSessionScanContext,
  sessionId: string,
): Promise<string | undefined> {
  const fileName = `${sessionId}.jsonl`;
  for (const { directory, childNames } of context.projectDirectories) {
    if (!childNames.includes(fileName)) {
      continue;
    }
    const candidate = path.join(directory, fileName);
    const safeFile = await safeSessionFileForScan(context, candidate, sessionId);
    if (safeFile) {
      return safeFile.filePath;
    }
  }
  return undefined;
}

async function discoverCliRecords(
  context: ClaudeSessionScanContext,
  records: Map<string, CatalogRecord>,
  sidechainIds: Set<string>,
): Promise<void> {
  const { root } = context;
  if (!context.resolvedRoot) {
    // The root (or a parent) is gone. Entries are tagged with the logical root, so evict by that
    // rather than a lexical containment test the canonical cache keys would never satisfy.
    for (const [cachedPath, entry] of catalogDiscoveryCache) {
      if (entry.root === root) {
        catalogDiscoveryCache.delete(cachedPath);
      }
    }
    return;
  }
  let discoveredFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  const seenFilePaths = new Set<string>();
  const pendingIndexedFiles = new Set([...records.values()].map((record) => record.filePath));
  const candidates: Array<{ directory: string; name: string; sessionId: string }> = [];
  collect: for (const { directory, childNames } of context.projectDirectories) {
    for (const name of childNames) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      if (discoveredFiles >= MAX_CATALOG_DISCOVERY_FILES) {
        truncated = true;
        break collect;
      }
      discoveredFiles += 1;
      const sessionId = name.slice(0, -".jsonl".length);
      if (sessionId) {
        candidates.push({ directory, name, sessionId });
      }
    }
  }
  for (const { directory, name, sessionId } of candidates) {
    // Snapshot signatures are prepared concurrently; semantic decisions retain serial directory
    // order so duplicate precedence and the byte frontier match cold discovery.
    if (sidechainIds.has(sessionId)) {
      continue;
    }
    const fileStat = await safeSessionFileForScan(context, path.join(directory, name), sessionId);
    if (!fileStat) {
      continue;
    }
    const { filePath } = fileStat;
    // Enrich each indexed file once; unindexed duplicates only stop after an accepted record.
    if (records.has(sessionId) && !pendingIndexedFiles.delete(filePath)) {
      continue;
    }
    seenFilePaths.add(filePath);
    const cached = catalogDiscoveryCache.get(filePath);
    // Claude transcripts only append while active, then stay static, so mtime+size+ino identify
    // the parsed content (ino also rejects an atomic replacement that reused the same mtime/size),
    // and sessionId ensures the record is served only under the filename-derived id it was built
    // for. These files are owner-owned and append-only; a mid-scan read-permission revocation is
    // not a state the Claude CLI produces, so a hit intentionally skips the open() re-check.
    if (
      cached &&
      cached.root === root &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size &&
      cached.ino === fileStat.ino &&
      cached.sessionId === sessionId &&
      // Only replay the cached record if a cold scan would also reach its metadata under the
      // current remaining byte budget. Once earlier files grow, replaying a record whose original
      // scan cost now crosses the frontier would surface a record a cold scan stops before; fall
      // through to a bounded rescan instead so warm and cold discovery (and pagination) match.
      scannedBytes + cached.scannedBytes <= MAX_CATALOG_METADATA_SCAN_BYTES
    ) {
      if (cached.sidechain) {
        sidechainIds.add(sessionId);
      }
      applyCatalogDiscovery(records, sessionId, cached);
      // Cache hits read no transcript bytes, but they still charge the file's original scan cost
      // so the byte-budget cutoff matches a cold scan; otherwise repeated calls would free budget
      // and progressively discover more files.
      scannedBytes += cached.scannedBytes;
      if (scannedBytes >= MAX_CATALOG_METADATA_SCAN_BYTES) {
        truncated = true;
        break;
      }
      continue;
    }
    const handle = await fs.open(filePath, "r").catch(() => {
      context.complete = false;
      return undefined;
    });
    if (!handle) {
      continue;
    }
    let cacheable = false;
    let fileScannedBytes = 0;
    let record: CatalogRecord | null = null;
    let metadata: CatalogDiscoveryCacheEntry["metadata"] = {};
    try {
      const stat = await handle.stat();
      let aiTitle: string | undefined;
      let customTitle: string | undefined;
      let color: string | undefined;
      const inspectLine = (line: Buffer, metadataOnly: boolean): boolean => {
        let raw: unknown;
        try {
          raw = JSON.parse(line.toString("utf8")) as unknown;
        } catch {
          return false;
        }
        if (!isRecord(raw) || raw.sessionId !== sessionId) {
          return false;
        }
        if (raw.type === "ai-title") {
          aiTitle = readBoundedString(raw.aiTitle, 500);
          return false;
        }
        if (raw.type === "custom-title") {
          customTitle = readBoundedString(raw.customTitle, 500);
          return false;
        }
        if (raw.type === "agent-color") {
          // Preserve the last value, including clears; core owns palette normalization.
          color = readBoundedString(raw.agentColor, MAX_STRING_LENGTH);
          return false;
        }
        if (metadataOnly) {
          return false;
        }
        if (typeof raw.entrypoint === "string" && !isCliEntrypoint(raw.entrypoint)) {
          return true;
        }
        if (isCliEntrypoint(raw.entrypoint) && raw.isSidechain === true) {
          sidechainIds.add(sessionId);
          return true;
        }
        if (
          !isCliEntrypoint(raw.entrypoint) ||
          raw.type !== "user" ||
          raw.isMeta === true ||
          !isRecord(raw.message) ||
          raw.message.role !== "user"
        ) {
          return false;
        }
        const fragments: string[] = [];
        collectTranscriptText(raw.message.content, fragments);
        const firstPrompt = readBoundedString(fragments[0], 500);
        const createdAt = parseClaudeCatalogTimestampMs(raw.timestamp);
        record = {
          threadId: sessionId,
          name: firstPrompt ?? null,
          cwd: readBoundedString(raw.cwd, MAX_STRING_LENGTH),
          status: "stored",
          ...(createdAt !== undefined ? { createdAt } : {}),
          updatedAt: stat.mtimeMs,
          recencyAt: stat.mtimeMs,
          source: "claude-cli",
          modelProvider: "anthropic",
          ...(readBoundedString(raw.version, 256)
            ? { cliVersion: readBoundedString(raw.version, 256) }
            : {}),
          ...(readBoundedString(raw.gitBranch, 500)
            ? { gitBranch: readBoundedString(raw.gitBranch, 500) }
            : {}),
          archived: false,
          filePath,
        };
        return true;
      };
      const scan = await readClaudeCatalogMetadata(
        handle,
        stat.size,
        MAX_CATALOG_METADATA_SCAN_BYTES - scannedBytes,
        inspectLine,
      );
      fileScannedBytes = scan.scannedBytes;
      scannedBytes += fileScannedBytes;
      metadata = { name: customTitle ?? aiTitle, color };
      applyCatalogDiscovery(records, sessionId, { record, metadata });
      // A read whose chunk was capped by the remaining global budget stops on a smaller boundary
      // than a cold scan would, so its charged bytes undercount the unconstrained scan cost.
      // Don't cache such an entry: replaying its low cost later (with more budget free) would let
      // the warm scan cross the frontier and surface sessions a cold scan omits.
      const budgetConstrained = scannedBytes >= MAX_CATALOG_METADATA_SCAN_BYTES;
      cacheable = !budgetConstrained && scan.complete;
    } finally {
      await handle.close();
    }
    // Negative and sidechain-only results are cached too; unchanged files should not be reparsed.
    if (cacheable) {
      cacheCatalogDiscovery(filePath, {
        root,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        ino: fileStat.ino,
        sessionId,
        scannedBytes: fileScannedBytes,
        record,
        metadata,
        sidechain: sidechainIds.has(sessionId),
      });
    }
    if (scannedBytes >= MAX_CATALOG_METADATA_SCAN_BYTES) {
      truncated = true;
      break;
    }
  }
  if (!truncated) {
    // A complete scan is authoritative for this root: drop any of its entries not seen this pass.
    for (const [cachedPath, entry] of catalogDiscoveryCache) {
      if (entry.root === root && !seenFilePaths.has(cachedPath)) {
        catalogDiscoveryCache.delete(cachedPath);
      }
    }
  }
}

async function scanClaudeSessions(snapshot: ClaudeProjectsTreeSnapshot) {
  const context: ClaudeSessionScanContext = {
    ...snapshot,
    complete: true,
    safeFiles: new Map(),
    directoriesByPath: new Map(snapshot.projectDirectories.map((dir) => [dir.directory, dir])),
  };
  const indexed = await readIndexRecords(context);
  await discoverCliRecords(context, indexed.records, indexed.sidechainIds);
  return { ...indexed, context };
}

async function mergeClaudeSessions(
  cli: ClaudeCliScan,
  desktop: DesktopOverlay,
): Promise<CatalogRecord[]> {
  const { context, sidechainIds } = cli;
  const records = new Map(cli.records);
  for (const sessionId of desktop.archived) {
    records.delete(sessionId);
  }
  for (const [sessionId, metadata] of desktop.active) {
    if (sidechainIds.has(sessionId)) {
      continue;
    }
    const existing = records.get(sessionId);
    const filePath = existing?.filePath ?? (await locateSessionFile(context, sessionId));
    if (!filePath) {
      continue;
    }
    const createdAt = parseClaudeCatalogTimestampMs(metadata.createdAt) ?? existing?.createdAt;
    const updatedAt = parseClaudeCatalogTimestampMs(metadata.lastActivityAt) ?? existing?.updatedAt;
    const customGroup = readBoundedString(metadata.customGroup, 500);
    const pullRequest = desktopPullRequestSummary(metadata);
    records.set(sessionId, {
      ...(existing ?? {
        threadId: sessionId,
        status: "stored" as const,
        modelProvider: "anthropic" as const,
        archived: false as const,
      }),
      name: readBoundedString(metadata.title, 500) ?? existing?.name ?? null,
      cwd:
        readBoundedString(metadata.cwd, MAX_STRING_LENGTH) ??
        readBoundedString(metadata.originCwd, MAX_STRING_LENGTH) ??
        existing?.cwd,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
      ...(customGroup ? { customGroup } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      source: "claude-desktop",
      color: undefined,
      filePath,
    });
  }
  return [...records.values()].toSorted((left, right) => {
    const recency =
      (right.recencyAt ?? right.updatedAt ?? 0) - (left.recencyAt ?? left.updatedAt ?? 0);
    return recency || left.threadId.localeCompare(right.threadId);
  });
}

async function readCliScan(
  treeSnapshot: ClaudeProjectsTreeSnapshot,
  forceRefresh?: boolean,
): Promise<ClaudeCliScan> {
  const cacheKey = `${treeSnapshot.root}\0cli`;
  const now = Date.now();
  const cached = claudeSessionScanCache.get(cacheKey);
  if (!forceRefresh && cached?.treeStamp === treeSnapshot.treeStamp && cached.hardExpiresAt > now) {
    setBoundedCache(
      claudeSessionScanCache,
      cacheKey,
      cached,
      MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES,
    );
    return cached.records;
  }
  const entry = {
    treeStamp: treeSnapshot.treeStamp,
    hardExpiresAt: now + CLAUDE_SESSION_SCAN_HARD_TTL_MS,
    records: scanClaudeSessions(treeSnapshot),
  };
  setBoundedCache(claudeSessionScanCache, cacheKey, entry, MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES);
  try {
    const result = await entry.records;
    if (!result.context.complete) {
      // Retry transient per-file I/O without waiting for the five-minute tree backstop.
      entry.hardExpiresAt = Date.now() + CLAUDE_PARTIAL_SCAN_TTL_MS;
    }
    return result;
  } catch (error) {
    if (claudeSessionScanCache.get(cacheKey) === entry) {
      claudeSessionScanCache.delete(cacheKey);
    }
    throw error;
  }
}

export async function listClaudeSessions(
  homeDir = resolveClaudeCatalogHomeDir(),
  options: { forceRefresh?: boolean; configDir?: string; includeDesktop?: boolean } = {},
): Promise<CatalogRecord[]> {
  const [cli, desktop] = await Promise.all([
    readProjectsTreeSnapshot(projectsDir(homeDir, options.configDir), options).then((snapshot) =>
      readCliScan(snapshot, options.forceRefresh),
    ),
    options.includeDesktop !== false
      ? readDesktopOverlay(homeDir, options.forceRefresh)
      : emptyDesktopOverlay,
  ]);
  let overlays = mergedScans.get(cli);
  if (!overlays) {
    overlays = new WeakMap();
    mergedScans.set(cli, overlays);
  }
  let merged = overlays.get(desktop);
  if (!merged) {
    merged = mergeClaudeSessions(cli, desktop);
    overlays.set(desktop, merged);
  }
  return merged;
}
