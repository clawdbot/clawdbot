import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry as PiSessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { derivePromptTokens } from "../../agents/usage.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry as StoreSessionEntry,
} from "../../config/sessions/types.js";
import { readLatestRecentSessionUsageFromTranscriptAsync } from "../../gateway/session-utils.fs.js";
import { readRegularFile } from "../../infra/fs-safe.js";

type ForkSourceTranscript = {
  cwd: string;
  sessionDir: string;
  leafId: string | null;
  branchEntries: PiSessionEntry[];
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
};

const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function maxPositiveTokenCount(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    const normalized = resolvePositiveTokenCount(value);
    if (typeof normalized === "number" && (max === undefined || normalized > max)) {
      max = normalized;
    }
  }
  return max;
}

async function estimateParentTranscriptTokensFromBytes(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  try {
    const filePath = resolveSessionFilePath(
      params.parentEntry.sessionId,
      params.parentEntry,
      resolveSessionFilePathOptions({ storePath: params.storePath }),
    );
    const stat = await fs.stat(filePath);
    return resolvePositiveTokenCount(Math.ceil(stat.size / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN));
  } catch {
    return undefined;
  }
}

export async function resolveParentForkTokenCountRuntime(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const freshPersistedTokens = resolveFreshSessionTotalTokens(params.parentEntry);
  if (typeof freshPersistedTokens === "number") {
    return freshPersistedTokens;
  }

  const cachedTokens = resolvePositiveTokenCount(params.parentEntry.totalTokens);
  const byteEstimateTokens = await estimateParentTranscriptTokensFromBytes(params);
  try {
    const usage = await readLatestRecentSessionUsageFromTranscriptAsync(
      params.parentEntry.sessionId,
      params.storePath,
      params.parentEntry.sessionFile,
      undefined,
      1024 * 1024,
    );
    const promptTokens = resolvePositiveTokenCount(
      derivePromptTokens({
        input: usage?.inputTokens,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      }),
    );
    const outputTokens = resolvePositiveTokenCount(usage?.outputTokens);
    if (typeof promptTokens === "number") {
      return maxPositiveTokenCount(
        promptTokens + (outputTokens ?? 0),
        cachedTokens,
        byteEstimateTokens,
      );
    }
  } catch {
    // Fall back to cached totals when recent transcript usage cannot be read.
  }

  return maxPositiveTokenCount(cachedTokens, byteEstimateTokens);
}

function isSessionEntry(entry: FileEntry): entry is PiSessionEntry {
  return (
    entry.type !== "session" &&
    typeof (entry as { id?: unknown }).id === "string" &&
    (typeof (entry as { timestamp?: unknown }).timestamp === "string" ||
      typeof (entry as { timestamp?: unknown }).timestamp === "number")
  );
}

function buildEntryIndex(entries: PiSessionEntry[]): Map<string, PiSessionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function readBranch(params: {
  byId: Map<string, PiSessionEntry>;
  leafId: string | null;
}): PiSessionEntry[] {
  const branchEntries: PiSessionEntry[] = [];
  let current = params.leafId ? params.byId.get(params.leafId) : undefined;
  while (current) {
    branchEntries.unshift(current);
    current = current.parentId ? params.byId.get(current.parentId) : undefined;
  }
  return branchEntries;
}

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = crypto.randomUUID();
  existingIds.add(id);
  return id;
}

function collectBranchLabels(params: {
  allEntries: PiSessionEntry[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
  for (const entry of params.allEntries) {
    if (
      entry.type === "label" &&
      entry.label &&
      params.pathEntryIds.has(entry.targetId) &&
      typeof entry.timestamp === "string"
    ) {
      labelsToWrite.push({
        targetId: entry.targetId,
        label: entry.label,
        timestamp: entry.timestamp,
      });
    }
  }
  return labelsToWrite;
}

async function readForkSourceTranscript(
  parentSessionFile: string,
): Promise<ForkSourceTranscript | null> {
  const raw = (await readRegularFile({ filePath: parentSessionFile })).buffer.toString("utf-8");
  const fileEntries = parseSessionEntries(raw);
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  const byId = buildEntryIndex(entries);
  const leafId = entries.at(-1)?.id ?? null;
  const branchEntries = readBranch({ byId, leafId });
  const pathEntryIds = new Set(
    branchEntries.filter((entry) => entry.type !== "label").map((entry) => entry.id),
  );
  return {
    cwd: header?.cwd ?? process.cwd(),
    sessionDir: path.dirname(parentSessionFile),
    leafId,
    branchEntries,
    labelsToWrite: collectBranchLabels({ allEntries: entries, pathEntryIds }),
  };
}

function buildBranchLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): PiSessionEntry[] {
  let parentId = params.lastEntryId;
  const labelEntries: PiSessionEntry[] = [];
  for (const { targetId, label, timestamp } of params.labelsToWrite) {
    const labelEntry = {
      type: "label",
      id: generateEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    } satisfies PiSessionEntry;
    params.pathEntryIds.add(labelEntry.id);
    labelEntries.push(labelEntry);
    parentId = labelEntry.id;
  }
  return labelEntries;
}

async function writeForkHeaderOnly(params: {
  parentSessionFile: string;
  sessionDir: string;
  cwd: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(params.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: "wx",
  });
  return { sessionId, sessionFile };
}

async function writeBranchedSession(params: {
  parentSessionFile: string;
  source: ForkSourceTranscript;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(params.source.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const pathWithoutLabels = params.source.branchEntries.filter((entry) => entry.type !== "label");
  const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
  const labelEntries = buildBranchLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: pathWithoutLabels.at(-1)?.id ?? null,
  });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.source.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  const entries = [header, ...pathWithoutLabels, ...labelEntries];
  const hasAssistant = entries.some(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (hasAssistant) {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  return { sessionId, sessionFile };
}

export async function forkSessionFromParentRuntime(params: {
  parentEntry: StoreSessionEntry;
  agentId: string;
  sessionsDir: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
    { agentId: params.agentId, sessionsDir: params.sessionsDir },
  );
  if (!parentSessionFile) {
    return null;
  }
  try {
    const source = await readForkSourceTranscript(parentSessionFile);
    if (!source) {
      return null;
    }
    return source.leafId
      ? await writeBranchedSession({ parentSessionFile, source })
      : await writeForkHeaderOnly({
          parentSessionFile,
          sessionDir: source.sessionDir,
          cwd: source.cwd,
        });
  } catch {
    return null;
  }
}
