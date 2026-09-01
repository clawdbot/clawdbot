import fs from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import {
  asPositiveSafeInteger as pullRequestNumber,
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readClaudeDesktopCustomGroups } from "./claude-desktop-groups.js";
import {
  CLAUDE_CATALOG_IO_CONCURRENCY,
  childDirectories,
  currentHomeDir,
  desktopSessionStoreAvailable,
  desktopSessionsDir,
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

export const MAX_STRING_LENGTH = 4096;
const MAX_SESSION_PULL_REQUESTS = 20;
const MAX_CATALOG_DISCOVERY_FILES = 10_000;
const MAX_CATALOG_DISCOVERY_CACHE_ENTRIES = 20_000;
const MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES = 8;
const CLAUDE_SESSION_SCAN_HARD_TTL_MS = 5 * 60_000;
const CLAUDE_PARTIAL_SCAN_TTL_MS = 15_000;
const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;
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
  desktopStoreAvailable: boolean;
  desktopExpiresAt: number;
  records: Promise<CatalogRecord[]>;
};

// Transcript discoveries stay valid only for the same root/id/inode/mtime/size and are LRU-bounded;
// a false hit would corrupt pagination, so warm scans re-charge the original deterministic byte cost.
const catalogDiscoveryCache = new Map<string, CatalogDiscoveryCacheEntry>();
// Whole scans are root-scoped and bounded; tree/Desktop/hard expiries below own invalidation, avoiding
// an unbounded home map while preserving the exact resolved records promise for concurrent callers.
const claudeSessionScanCache = new Map<string, ClaudeSessionScanCacheEntry>();

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

type DesktopSessionMetadata = {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  originCwd?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  model?: unknown;
  isArchived?: unknown;
  title?: unknown;
  customGroup?: unknown;
  prNumber?: unknown;
  prState?: unknown;
  prs?: unknown;
};

type DesktopPullRequestMetadata = {
  prNumber?: unknown;
  state?: unknown;
  dismissed?: unknown;
};

export type CatalogRecord = ClaudeSessionCatalogSession & {
  filePath: string;
};

function pullRequestState(value: unknown): SessionCatalogPullRequestSummary["state"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "open":
    case "draft":
    case "merged":
    case "closed":
      return value.trim().toLowerCase() as SessionCatalogPullRequestSummary["state"];
    default:
      return undefined;
  }
}

// Desktop retains historical PRs in order and marks hidden ones as dismissed;
// the top-level pair identifies the current PR whose state labels the row.
function desktopPullRequestSummary(
  metadata: DesktopSessionMetadata,
): SessionCatalogPullRequestSummary | undefined {
  const visibleByNumber = new Map<number, SessionCatalogPullRequestSummary["state"] | undefined>();
  const dismissed = new Set<number>();
  if (Array.isArray(metadata.prs)) {
    for (const value of metadata.prs) {
      if (!isRecord(value)) {
        continue;
      }
      const entry = value as DesktopPullRequestMetadata;
      const number = pullRequestNumber(entry.prNumber);
      if (!number) {
        continue;
      }
      if (entry.dismissed === true) {
        dismissed.add(number);
        visibleByNumber.delete(number);
        continue;
      }
      if (!dismissed.has(number) && !visibleByNumber.has(number)) {
        visibleByNumber.set(number, pullRequestState(entry.state));
      }
    }
  }
  const currentNumber = pullRequestNumber(metadata.prNumber);
  let currentState = currentNumber ? visibleByNumber.get(currentNumber) : undefined;
  if (currentNumber && !dismissed.has(currentNumber)) {
    currentState = pullRequestState(metadata.prState) ?? currentState;
    // Reinsert the current PR at the tail so truncation always retains it.
    visibleByNumber.delete(currentNumber);
    visibleByNumber.set(currentNumber, currentState);
  }
  const visible = [...visibleByNumber].map(([number, state]) => ({ number, state }));
  if (visible.length === 0) {
    return undefined;
  }
  const state = currentState ?? visible.at(-1)?.state;
  if (!state) {
    return undefined;
  }
  return {
    numbers: visible.slice(-MAX_SESSION_PULL_REQUESTS).map((entry) => entry.number),
    state,
  };
}

export function parsePullRequestSummary(
  value: unknown,
): SessionCatalogPullRequestSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.numbers)) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  const numbers = value.numbers.map(pullRequestNumber);
  const state = pullRequestState(value.state);
  if (
    numbers.length === 0 ||
    numbers.length > MAX_SESSION_PULL_REQUESTS ||
    numbers.some((number) => number === undefined) ||
    new Set(numbers).size !== numbers.length ||
    !state
  ) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  return { numbers: numbers as number[], state };
}

function isCliEntrypoint(value: unknown): value is string {
  return typeof value === "string" && CLI_ENTRYPOINTS.has(value);
}

// Claude's persisted string timestamps are date expressions, including numeric-looking years.
// Numeric fields are already millisecond values, so preserve that distinct mixed-input contract.
function parseClaudeCatalogTimestampMs(value: unknown): number | undefined {
  return parseDateFirstTimestampMs(value);
}

async function readDesktopMetadata(homeDir: string): Promise<{
  active: Map<string, DesktopSessionMetadata>;
  archived: Set<string>;
}> {
  const active = new Map<string, DesktopSessionMetadata>();
  const archived = new Set<string>();
  const customGroups = await readClaudeDesktopCustomGroups(homeDir);
  for (const accountDir of await childDirectories(desktopSessionsDir(homeDir))) {
    for (const workspaceDir of await childDirectories(accountDir)) {
      let entries: string[];
      try {
        entries = await fs.readdir(workspaceDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) {
          continue;
        }
        const raw = await readJsonFile(path.join(workspaceDir, name));
        if (!isRecord(raw)) {
          continue;
        }
        const metadata = raw as DesktopSessionMetadata;
        const cliSessionId = readBoundedString(metadata.cliSessionId, 256);
        if (!cliSessionId) {
          continue;
        }
        if (metadata.isArchived === true) {
          archived.add(cliSessionId);
          active.delete(cliSessionId);
          continue;
        }
        if (!archived.has(cliSessionId)) {
          const localSessionId = readBoundedString(metadata.sessionId, 256);
          const customGroup = localSessionId ? customGroups.get(localSessionId) : undefined;
          active.set(cliSessionId, customGroup ? { ...metadata, customGroup } : metadata);
        }
      }
    }
  }
  return { active, archived };
}

async function readIndexRecords(context: ClaudeSessionScanContext): Promise<{
  records: Map<string, CatalogRecord>;
  sidechainIds: Set<string>;
}> {
  const records = new Map<string, CatalogRecord>();
  const sidechainIds = new Set<string>();
  if (!context.resolvedRoot) {
    return { records, sidechainIds };
  }
  const { results: indexes } = await runTasksWithConcurrency({
    tasks: context.projectDirectories.map(({ directory, childNames }) => async () => ({
      directory,
      raw: childNames.includes("sessions-index.json")
        ? await readJsonFile(path.join(directory, "sessions-index.json"), {
            onIoFailure: () => {
              context.complete = false;
            },
          })
        : undefined,
    })),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  const candidates: Array<{
    directory: string;
    entry: SessionIndexEntry;
    sessionId: string;
  }> = [];
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
      candidates.push({ directory, entry, sessionId });
    }
  }
  const { results: safeFiles } = await runTasksWithConcurrency({
    tasks: candidates.map(({ directory, entry, sessionId }) => async () => {
      if (entry.isSidechain === true) {
        return undefined;
      }
      const indexedPath = readBoundedString(entry.fullPath, MAX_STRING_LENGTH);
      return await safeSessionFileForScan(
        context,
        indexedPath ?? path.join(directory, `${sessionId}.jsonl`),
        sessionId,
      );
    }),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  for (const [index, candidate] of candidates.entries()) {
    const { entry, sessionId } = candidate;
    if (entry.isSidechain === true) {
      sidechainIds.add(sessionId);
      records.delete(sessionId);
      continue;
    }
    const safeFile = safeFiles[index];
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
  const { results: safeFiles } = await runTasksWithConcurrency({
    tasks: candidates.map(
      ({ directory, name, sessionId }) =>
        async () =>
          sidechainIds.has(sessionId)
            ? undefined
            : await safeSessionFileForScan(context, path.join(directory, name), sessionId),
    ),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const { sessionId } = candidate;
    // Resolve metadata concurrently, but make every semantic decision in the original directory
    // order. In particular, duplicates and the global byte frontier must match a serial cold scan.
    if (sidechainIds.has(sessionId)) {
      continue;
    }
    const safeFile = safeFiles[candidateIndex];
    if (!safeFile) {
      continue;
    }
    const { filePath, stat: fileStat } = safeFile;
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

async function scanClaudeSessions(
  homeDir: string,
  snapshot: ClaudeProjectsTreeSnapshot,
  includeDesktop: boolean,
): Promise<{ records: CatalogRecord[]; complete: boolean }> {
  const context: ClaudeSessionScanContext = { ...snapshot, complete: true, safeFiles: new Map() };
  const [indexed, desktop] = await Promise.all([
    readIndexRecords(context),
    includeDesktop
      ? readDesktopMetadata(homeDir)
      : Promise.resolve({ active: new Map(), archived: new Set<string>() }),
  ]);
  const records = indexed.records;
  await discoverCliRecords(context, records, indexed.sidechainIds);
  for (const sessionId of desktop.archived) {
    records.delete(sessionId);
  }
  for (const [sessionId, metadata] of desktop.active) {
    if (indexed.sidechainIds.has(sessionId)) {
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
  return {
    records: [...records.values()].toSorted((left, right) => {
      const recency =
        (right.recencyAt ?? right.updatedAt ?? 0) - (left.recencyAt ?? left.updatedAt ?? 0);
      return recency || left.threadId.localeCompare(right.threadId);
    }),
    complete: context.complete,
  };
}

export async function listClaudeSessions(
  homeDir = currentHomeDir(),
  options: { forceRefresh?: boolean; configDir?: string; includeDesktop?: boolean } = {},
): Promise<CatalogRecord[]> {
  const root = projectsDir(homeDir, options.configDir);
  const includeDesktop = options.includeDesktop !== false;
  const cacheKey = `${root}\0${includeDesktop ? "desktop" : "cli"}`;
  const [treeSnapshot, desktopStoreAvailable] = await Promise.all([
    readProjectsTreeSnapshot(root),
    includeDesktop ? desktopSessionStoreAvailable(homeDir) : Promise.resolve(false),
  ]);
  const now = Date.now();
  const cached = claudeSessionScanCache.get(cacheKey);
  // Child membership + file mtime/size signatures invalidate CLI rows on the next poll; five minutes
  // backstops metadata anomalies. Desktop has a 60s bound when its macOS store exists; Linux skips it.
  // Specific-thread force refresh bypasses both, or a stale page could hide a just-created session.
  if (
    options.forceRefresh !== true &&
    cached &&
    cached.treeStamp === treeSnapshot.treeStamp &&
    cached.hardExpiresAt > now &&
    cached.desktopStoreAvailable === desktopStoreAvailable &&
    (!desktopStoreAvailable || cached.desktopExpiresAt > now)
  ) {
    setBoundedCache(
      claudeSessionScanCache,
      cacheKey,
      cached,
      MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES,
    );
    return await cached.records;
  }
  const scan = scanClaudeSessions(homeDir, treeSnapshot, includeDesktop);
  let scanComplete = true;
  const records = scan.then((result) => {
    scanComplete = result.complete;
    return result.records;
  });
  const entry = {
    treeStamp: treeSnapshot.treeStamp,
    hardExpiresAt: now + CLAUDE_SESSION_SCAN_HARD_TTL_MS,
    desktopStoreAvailable,
    desktopExpiresAt: now + CLAUDE_DESKTOP_SCAN_TTL_MS,
    records,
  };
  setBoundedCache(claudeSessionScanCache, cacheKey, entry, MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES);
  try {
    const result = await records;
    if (!scanComplete && claudeSessionScanCache.get(cacheKey) === entry) {
      // Partial results still serve this caller, but retry within 15s so transient per-file I/O
      // cannot hide recovered sessions behind the five-minute unchanged-tree backstop.
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
