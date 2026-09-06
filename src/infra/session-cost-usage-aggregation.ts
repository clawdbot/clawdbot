import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEventRowsAfterSeqSync,
  readTranscriptEventAtSeqSync,
} from "../config/sessions/session-accessor.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { resolveModelCostConfigFingerprint } from "../utils/usage-format.js";
import {
  acquireSessionCostUsageRefreshLock,
  deleteSessionCostUsageRollupsExcept,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import {
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptFile,
  type UsageCostTranscriptFile,
} from "./session-cost-usage-collection.js";
import {
  applyCostBreakdown,
  applyCostTotal,
  applyUsageTotals,
  createUsageCostResolver,
  parseUsageCostTranscriptEntry,
  type UsageCostResolver,
} from "./session-cost-usage-pricing.js";
import {
  appendSessionUsageRollupContribution,
  cloneSessionUsageRollupData,
  createSessionUsageRollupData,
  type SessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type { CostUsageTotals, ParsedTranscriptEntry } from "./session-cost-usage.types.js";

// Cache data is rebuildable. Semantic changes get a new version; old rows are
// ignored and rebuilt instead of normalized through a runtime compatibility path.
const USAGE_COST_ROLLUP_VERSION = 3;
const USAGE_COST_FILE_ANCHOR_BYTES = 4096;

type UsageCostJsonlCheckpoint = {
  kind: "jsonl";
  parsedOffset: number;
  observedSize: number;
  observedMtimeMs: number;
  device: number;
  inode: number;
  anchorHash: string;
};

type UsageCostSqliteCheckpoint = {
  kind: "sqlite";
  maxSeq: number;
  eventCount: number;
  size: number;
  mtimeMs: number;
  anchorHash: string;
  visibleLeafId?: string;
};

type UsageCostRollupEntry = {
  version: number;
  pricingFingerprint: string;
  checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint;
  scannedAt: number;
  parsedRecords: number;
  countedRecords: number;
  rollup: SessionUsageRollupData;
};

export type UsageCostStoredRollup = {
  entry: UsageCostRollupEntry;
  valueJson: string;
};

type UsageCostRefreshResult = "refreshed" | "busy";

export function resolveUsageCostCacheDatabasePath(agentId: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId: normalizeAgentId(agentId) });
}

export function resolveUsageCostAgentDir(
  config: OpenClawConfig | undefined,
  agentId: string,
): string {
  return resolveAgentDir(config ?? {}, agentId);
}

export function resolveUsageCostPricingFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
): string {
  return resolveModelCostConfigFingerprint(config, agentDir);
}

function normalizeUsageCostRollup(
  raw: unknown,
  pricingFingerprint: string,
): UsageCostRollupEntry | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Partial<UsageCostRollupEntry>;
  if (
    record.version !== USAGE_COST_ROLLUP_VERSION ||
    record.pricingFingerprint !== pricingFingerprint ||
    !record.checkpoint ||
    !record.rollup ||
    typeof record.scannedAt !== "number" ||
    typeof record.parsedRecords !== "number" ||
    typeof record.countedRecords !== "number"
  ) {
    return undefined;
  }
  return record as UsageCostRollupEntry;
}

export function readUsageCostRollups(
  agentId: string,
  pricingFingerprint: string,
  databasePath?: string,
  params: {
    rows?: ReturnType<typeof readSessionCostUsageRollupRows>;
    filePaths?: readonly string[];
  } = {},
): Map<string, UsageCostStoredRollup> {
  const result = new Map<string, UsageCostStoredRollup>();
  const rows =
    params.rows ?? readSessionCostUsageRollupRows(agentId, databasePath, params.filePaths);
  for (const row of rows) {
    try {
      const entry = normalizeUsageCostRollup(JSON.parse(row.valueJson), pricingFingerprint);
      if (entry) {
        result.set(row.key, { entry, valueJson: row.valueJson });
      }
    } catch {
      // Rebuildable cache row. The refresh path replaces it.
    }
  }
  return result;
}

export function isUsageCostRollupFresh(params: {
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.observedSize === params.file.size &&
      checkpoint.observedMtimeMs === params.file.mtimeMs &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return (
    checkpoint.size === params.file.size &&
    checkpoint.mtimeMs === params.file.mtimeMs &&
    checkpoint.eventCount === params.file.eventCount &&
    checkpoint.maxSeq === params.file.maxSeq
  );
}

export function canUseUsageCostRollupForPartial(params: {
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.parsedOffset <= params.file.size &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return checkpoint.maxSeq <= (params.file.maxSeq ?? 0);
}

export function getUsageCostStaleRollupFiles(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
}): UsageCostTranscriptFile[] {
  return params.files.filter(
    (file) => !isUsageCostRollupFresh({ stored: params.rollups.get(file.filePath), file }),
  );
}

export function countUsableUsageCostRollups(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
}): number {
  return params.files.reduce(
    (count, file) =>
      count +
      (canUseUsageCostRollupForPartial({ stored: params.rollups.get(file.filePath), file })
        ? 1
        : 0),
    0,
  );
}

export function latestUsageCostRollupScan(
  rollups: Map<string, UsageCostStoredRollup>,
): number | undefined {
  let latest = 0;
  for (const { entry } of rollups.values()) {
    latest = Math.max(latest, entry.scannedAt);
  }
  return latest || undefined;
}

function hashUsageCostCheckpoint(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function readJsonlAnchorHash(filePath: string, offset: number): Promise<string | undefined> {
  const start = Math.max(0, offset - USAGE_COST_FILE_ANCHOR_BYTES);
  const length = offset - start;
  if (length === 0) {
    return hashUsageCostCheckpoint("");
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? hashUsageCostCheckpoint(buffer) : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJsonlRecord(line: Buffer): Record<string, unknown> | undefined {
  const text = line.toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function scanJsonlRange(params: {
  filePath: string;
  startOffset: number;
  endOffset: number;
  onRecord: (record: Record<string, unknown>) => void;
}): Promise<number> {
  if (params.endOffset <= params.startOffset) {
    return params.startOffset;
  }
  const stream = fs.createReadStream(params.filePath, {
    start: params.startOffset,
    end: params.endOffset - 1,
  });
  let carry = Buffer.alloc(0);
  let carryStart = params.startOffset;
  let processedOffset = params.startOffset;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const data = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
      let lineStart = 0;
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, lineStart)) {
        const record = parseJsonlRecord(data.subarray(lineStart, newline));
        if (record) {
          params.onRecord(record);
        }
        processedOffset = carryStart + newline + 1;
        lineStart = newline + 1;
      }
      carry = data.subarray(lineStart);
      carryStart = processedOffset;
    }
    if (carry.length > 0) {
      const record = parseJsonlRecord(carry);
      if (record) {
        params.onRecord(record);
        processedOffset = params.endOffset;
      }
    }
    return processedOffset;
  } finally {
    stream.destroy();
  }
}

function appendParsedEntryToRollup(
  rollup: SessionUsageRollupData,
  entry: ParsedTranscriptEntry,
): { countedRecord: boolean; parsedRecord: boolean } {
  let usageTotals: CostUsageTotals | undefined;
  if (entry.usage) {
    usageTotals = emptyTotals();
    applyUsageTotals(usageTotals, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(usageTotals, entry.costBreakdown);
    } else {
      applyCostTotal(usageTotals, entry.costTotal, entry.provider, entry.model);
    }
  }
  const timestamp = entry.timestamp?.getTime();
  appendSessionUsageRollupContribution(rollup, {
    timestamp,
    role: entry.role,
    durationMs: entry.durationMs,
    provider: entry.provider,
    model: entry.model,
    stopReason: entry.stopReason,
    toolNames: entry.toolNames,
    toolResultCounts: entry.toolResultCounts,
    usageTotals,
  });
  return { parsedRecord: Boolean(entry.usage), countedRecord: Boolean(entry.usage && timestamp) };
}

function scanRecordsIntoRollup(params: {
  records: Iterable<Record<string, unknown>>;
  rollup: SessionUsageRollupData;
  resolveCost: UsageCostResolver;
}): { countedRecords: number; parsedRecords: number } {
  let countedRecords = 0;
  let parsedRecords = 0;
  for (const record of params.records) {
    const entry = parseUsageCostTranscriptEntry(record, params.resolveCost);
    if (!entry) {
      continue;
    }
    const counted = appendParsedEntryToRollup(params.rollup, entry);
    countedRecords += counted.countedRecord ? 1 : 0;
    parsedRecords += counted.parsedRecord ? 1 : 0;
  }
  return { countedRecords, parsedRecords };
}

function createUsageRollupScan(params: {
  pricingFingerprint: string;
  appendOnly: boolean;
  previous?: UsageCostStoredRollup;
  resolveCost: UsageCostResolver;
}) {
  const previous = params.appendOnly ? params.previous?.entry : undefined;
  const rollup = previous
    ? cloneSessionUsageRollupData(previous.rollup)
    : createSessionUsageRollupData();
  let countedRecords = 0;
  let parsedRecords = 0;
  return {
    addRecords(records: Iterable<Record<string, unknown>>): void {
      const counts = scanRecordsIntoRollup({ records, rollup, resolveCost: params.resolveCost });
      countedRecords += counts.countedRecords;
      parsedRecords += counts.parsedRecords;
    },
    finish(checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint): UsageCostRollupEntry {
      return {
        version: USAGE_COST_ROLLUP_VERSION,
        pricingFingerprint: params.pricingFingerprint,
        checkpoint,
        scannedAt: Date.now(),
        parsedRecords: (previous?.parsedRecords ?? 0) + parsedRecords,
        countedRecords: (previous?.countedRecords ?? 0) + countedRecords,
        rollup,
      };
    },
  };
}

async function scanJsonlUsageRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  const previousCheckpoint =
    params.previous?.entry.checkpoint.kind === "jsonl"
      ? params.previous.entry.checkpoint
      : undefined;
  const identityMatches =
    previousCheckpoint &&
    previousCheckpoint.device === params.file.device &&
    previousCheckpoint.inode === params.file.inode &&
    previousCheckpoint.parsedOffset <= params.file.size &&
    params.file.size > previousCheckpoint.observedSize;
  const previousAnchor = identityMatches
    ? await readJsonlAnchorHash(params.file.filePath, previousCheckpoint.parsedOffset)
    : undefined;
  const appendOnly = Boolean(
    identityMatches && previousAnchor === previousCheckpoint?.anchorHash && params.previous,
  );
  const startOffset = appendOnly ? (previousCheckpoint?.parsedOffset ?? 0) : 0;
  const scan = createUsageRollupScan({ ...params, appendOnly });
  const processedOffset = await scanJsonlRange({
    filePath: params.file.filePath,
    startOffset,
    endOffset: params.file.size,
    onRecord: (record) => scan.addRecords([record]),
  });
  const postStats = await fs.promises.stat(params.file.filePath);
  if (
    postStats.dev !== params.file.device ||
    postStats.ino !== params.file.inode ||
    postStats.size < params.file.size
  ) {
    throw new Error(`transcript changed identity while scanning: ${params.file.filePath}`);
  }
  const anchorHash = await readJsonlAnchorHash(params.file.filePath, processedOffset);
  if (!anchorHash) {
    throw new Error(`transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  return scan.finish({
    kind: "jsonl",
    parsedOffset: processedOffset,
    observedSize: params.file.size,
    observedMtimeMs: params.file.mtimeMs,
    device: params.file.device ?? 0,
    inode: params.file.inode ?? 0,
    anchorHash,
  });
}

function selectIncrementalSqliteRecords(
  records: Record<string, unknown>[],
  previousLeafId: string | undefined,
): { records: Record<string, unknown>[]; visibleLeafId?: string } | undefined {
  let visibleLeafId = previousLeafId;
  const visible: Record<string, unknown>[] = [];
  for (const record of records) {
    if (isSessionTranscriptLeafControl(record) || record.appendMode === "side") {
      return undefined;
    }
    if (!isCanonicalSessionTranscriptEntry(record)) {
      continue;
    }
    const id = typeof record.id === "string" && record.id ? record.id : undefined;
    if (!id) {
      return undefined;
    }
    if (Object.hasOwn(record, "parentId")) {
      const parentId = record.parentId === null ? undefined : record.parentId;
      if (parentId !== visibleLeafId) {
        return undefined;
      }
    }
    visible.push(record);
    visibleLeafId = id;
  }
  return { records: visible, ...(visibleLeafId ? { visibleLeafId } : {}) };
}

function sqliteCheckpointAnchorHash(event: unknown): string {
  return hashUsageCostCheckpoint(JSON.stringify(event));
}

async function scanSqliteUsageRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  const marker = parseSqliteSessionFileMarker(params.file.filePath);
  if (!marker) {
    throw new Error(`invalid SQLite transcript marker: ${params.file.filePath}`);
  }
  const maxSeq = params.file.maxSeq ?? 0;
  const eventCount = params.file.eventCount ?? 0;
  const scope = {
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  };
  const snapshotLastRow = maxSeq > 0 ? readTranscriptEventAtSeqSync(scope, maxSeq) : undefined;
  if (maxSeq > 0 && !snapshotLastRow) {
    throw new Error(`SQLite transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  const snapshotAnchorHash = snapshotLastRow
    ? sqliteCheckpointAnchorHash(snapshotLastRow.event)
    : hashUsageCostCheckpoint("");
  const previousCheckpoint =
    params.previous?.entry.checkpoint.kind === "sqlite"
      ? params.previous.entry.checkpoint
      : undefined;
  const previousAnchor = previousCheckpoint?.maxSeq
    ? readTranscriptEventAtSeqSync(scope, previousCheckpoint.maxSeq)
    : undefined;
  const anchorMatches =
    previousCheckpoint?.maxSeq === 0 ||
    (previousAnchor &&
      sqliteCheckpointAnchorHash(previousAnchor.event) === previousCheckpoint?.anchorHash);
  const appendCandidate = Boolean(
    params.previous &&
    previousCheckpoint &&
    previousCheckpoint.maxSeq < maxSeq &&
    previousCheckpoint.eventCount < eventCount &&
    anchorMatches,
  );
  const afterSeq = appendCandidate ? (previousCheckpoint?.maxSeq ?? 0) : 0;
  const rows = loadTranscriptEventRowsAfterSeqSync(scope, afterSeq, maxSeq);
  const rawRecords = rows.flatMap((row) =>
    row.event && typeof row.event === "object" && !Array.isArray(row.event)
      ? [row.event as Record<string, unknown>]
      : [],
  );
  const incremental = appendCandidate
    ? selectIncrementalSqliteRecords(rawRecords, previousCheckpoint?.visibleLeafId)
    : undefined;
  const appendOnly = Boolean(incremental && params.previous);
  const allRows = appendOnly ? rows : loadTranscriptEventRowsAfterSeqSync(scope, 0, maxSeq);
  const allRecords = appendOnly
    ? (incremental?.records ?? [])
    : selectVisibleTranscriptEvents(allRows.map((row) => row.event)).flatMap((event) =>
        event && typeof event === "object" && !Array.isArray(event)
          ? [event as Record<string, unknown>]
          : [],
      );
  const scan = createUsageRollupScan({ ...params, appendOnly });
  scan.addRecords(allRecords);
  const postFile = await resolveUsageCostTranscriptFile(params.file.filePath);
  if (!postFile || (postFile.maxSeq ?? 0) < maxSeq || (postFile.eventCount ?? 0) < eventCount) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const currentLastRow = maxSeq > 0 ? readTranscriptEventAtSeqSync(scope, maxSeq) : undefined;
  if (
    (maxSeq > 0 && !currentLastRow) ||
    (currentLastRow && sqliteCheckpointAnchorHash(currentLastRow.event) !== snapshotAnchorHash)
  ) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const visibleLeafId = appendOnly
    ? incremental?.visibleLeafId
    : (scanSessionTranscriptTree(allRows.map((row) => row.event)).leafId ?? undefined);
  return scan.finish({
    kind: "sqlite",
    maxSeq,
    eventCount,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    anchorHash: snapshotAnchorHash,
    ...(visibleLeafId ? { visibleLeafId } : {}),
  });
}

async function scanUsageFileForRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  return params.file.kind === "sqlite"
    ? await scanSqliteUsageRollup(params)
    : await scanJsonlUsageRollup(params);
}

export async function refreshCostUsageCacheForAgent(params: {
  config?: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  databasePath?: string;
  maxFiles?: number;
  sessionsDir?: string;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  const databasePath = params.databasePath ?? resolveUsageCostCacheDatabasePath(params.agentId);
  const lock = acquireSessionCostUsageRefreshLock(params.agentId, databasePath);
  if (!lock.acquired) {
    return "busy";
  }
  try {
    const agentDir = params.agentDir ?? resolveUsageCostAgentDir(params.config, params.agentId);
    const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
    const rows = readSessionCostUsageRollupRows(params.agentId, databasePath);
    const rawValues = new Map(rows.map((row) => [row.key, row.valueJson]));
    const rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath, {
      rows,
    });
    const discoveredFiles = await listUsageCountedTranscriptStats(
      params.agentId,
      params.sessionsDir ? { sessionsDir: params.sessionsDir } : undefined,
    );
    const requestedFiles: UsageCostTranscriptFile[] = [];
    for (const requested of params.sessionFiles ?? []) {
      const resolved = await resolveUsageCostTranscriptFile(requested);
      if (resolved) {
        requestedFiles.push(resolved);
      }
    }
    const filesByPath = new Map(discoveredFiles.map((file) => [file.filePath, file]));
    for (const file of requestedFiles) {
      filesByPath.set(file.filePath, file);
    }
    const files = [...filesByPath.values()];
    deleteSessionCostUsageRollupsExcept({
      agentId: params.agentId,
      databasePath,
      liveKeys: new Set(files.map((file) => file.filePath)),
      rows,
    });

    const requestedPaths = new Set<string>();
    for (const file of requestedFiles) {
      requestedPaths.add(file.filePath);
    }
    const refreshFiles =
      requestedPaths.size > 0
        ? files.filter((file) => requestedPaths.has(file.filePath))
        : params.startMs === undefined
          ? files
          : files.filter((file) => file.mtimeMs >= params.startMs!);
    const maxFiles =
      params.maxFiles !== undefined && Number.isFinite(params.maxFiles) && params.maxFiles > 0
        ? Math.floor(params.maxFiles)
        : undefined;
    const staleFiles = getUsageCostStaleRollupFiles({ rollups, files: refreshFiles })
      .toSorted((a, b) => a.size - b.size || a.filePath.localeCompare(b.filePath))
      .slice(0, maxFiles);
    const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

    for (const file of staleFiles) {
      const previous = rollups.get(file.filePath);
      const entry = await scanUsageFileForRollup({
        file,
        previous,
        pricingFingerprint,
        resolveCost,
      });
      const valueJson = JSON.stringify(entry);
      const written = writeSessionCostUsageRollup({
        agentId: params.agentId,
        databasePath,
        rollupId: file.filePath,
        previousValueJson: rawValues.get(file.filePath) ?? null,
        valueJson,
        updatedAt: entry.scannedAt,
      });
      if (!written) {
        throw new Error(`usage rollup changed while refreshing: ${file.filePath}`);
      }
      rollups.set(file.filePath, { entry, valueJson });
      rawValues.set(file.filePath, valueJson);
    }
    return "refreshed";
  } finally {
    lock.release();
  }
}
