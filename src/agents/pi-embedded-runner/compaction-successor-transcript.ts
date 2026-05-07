import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type CompactionEntry,
  type SessionEntry,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { collectDuplicateUserMessageEntryIdsForCompaction } from "./compaction-duplicate-user-messages.js";
import {
  readTranscriptFileState,
  TranscriptFileState,
  writeTranscriptFileAtomic,
} from "./transcript-file-state.js";

type ReadonlySessionManagerForRotation = Pick<
  TranscriptFileState,
  "buildSessionContext" | "getBranch" | "getCwd" | "getEntries" | "getHeader"
>;

export type CompactionTranscriptRotation = {
  rotated: boolean;
  reason?: string;
  sessionId?: string;
  sessionFile?: string;
  compactionEntryId?: string;
  leafId?: string;
  entriesWritten?: number;
};

export function shouldRotateCompactionTranscript(config?: OpenClawConfig): boolean {
  return config?.agents?.defaults?.compaction?.truncateAfterCompaction === true;
}

export async function rotateTranscriptAfterCompaction(params: {
  sessionManager: ReadonlySessionManagerForRotation;
  sessionFile: string;
  now?: () => Date;
}): Promise<CompactionTranscriptRotation> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { rotated: false, reason: "missing session file" };
  }

  const branch = params.sessionManager.getBranch();
  const latestCompactionIndex = findLatestCompactionIndex(branch);
  if (latestCompactionIndex < 0) {
    return { rotated: false, reason: "no compaction entry" };
  }

  const compaction = branch[latestCompactionIndex] as CompactionEntry;
  const timestamp = (params.now?.() ?? new Date()).toISOString();
  const sessionId = randomUUID();
  const successorFile = resolveSuccessorSessionFile({
    sessionFile,
    sessionId,
    timestamp,
  });
  const successorEntries = buildSuccessorEntries({
    allEntries: params.sessionManager.getEntries(),
    branch,
    latestCompactionIndex,
  });
  if (successorEntries.length === 0) {
    return { rotated: false, reason: "empty successor transcript" };
  }

  const header = buildSuccessorHeader({
    previousHeader: params.sessionManager.getHeader(),
    sessionId,
    timestamp,
    cwd: params.sessionManager.getCwd(),
    parentSession: sessionFile,
  });
  await writeTranscriptFileAtomic(successorFile, [header, ...successorEntries]);
  new TranscriptFileState({ header, entries: successorEntries }).buildSessionContext();

  return {
    rotated: true,
    sessionId,
    sessionFile: successorFile,
    compactionEntryId: compaction.id,
    leafId: successorEntries[successorEntries.length - 1]?.id,
    entriesWritten: successorEntries.length,
  };
}

export async function rotateTranscriptFileAfterCompaction(params: {
  sessionFile: string;
  now?: () => Date;
}): Promise<CompactionTranscriptRotation> {
  const state = await readTranscriptFileState(params.sessionFile);
  return rotateTranscriptAfterCompaction({
    sessionManager: state,
    sessionFile: params.sessionFile,
    ...(params.now ? { now: params.now } : {}),
  });
}

function findLatestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

function buildSuccessorEntries(params: {
  allEntries: SessionEntry[];
  branch: SessionEntry[];
  latestCompactionIndex: number;
}): SessionEntry[] {
  const { allEntries, branch, latestCompactionIndex } = params;
  const compaction = branch[latestCompactionIndex] as CompactionEntry;

  const summarizedBranchIds = new Set<string>();
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = branch[index];
    if (!entry) {
      continue;
    }
    if (compaction.firstKeptEntryId && entry.id === compaction.firstKeptEntryId) {
      break;
    }
    summarizedBranchIds.add(entry.id);
  }

  const latestStateEntryIds = collectLatestStateEntryIds(branch.slice(0, latestCompactionIndex));
  const staleStateEntryIds = new Set<string>();
  for (const entry of branch.slice(0, latestCompactionIndex)) {
    if (isDedupedStateEntry(entry) && !latestStateEntryIds.has(entry.id)) {
      staleStateEntryIds.add(entry.id);
    }
  }

  const removedIds = new Set<string>();
  const duplicateUserMessageIds = collectDuplicateUserMessageEntryIdsForCompaction(branch);
  for (const entry of allEntries) {
    if (
      (summarizedBranchIds.has(entry.id) && entry.type === "message") ||
      staleStateEntryIds.has(entry.id) ||
      duplicateUserMessageIds.has(entry.id)
    ) {
      removedIds.add(entry.id);
    }
  }
  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
    }
  }

  const entryById = new Map<string, SessionEntry>();
  const originalIndexById = new Map<string, number>();
  for (let index = 0; index < allEntries.length; index += 1) {
    const entry = allEntries[index];
    entryById.set(entry.id, entry);
    originalIndexById.set(entry.id, index);
  }
  const activeBranchIds = new Set<string>();
  for (const entry of branch) {
    activeBranchIds.add(entry.id);
  }
  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    let parentId = entry.parentId;
    while (parentId !== null && removedIds.has(parentId)) {
      parentId = entryById.get(parentId)?.parentId ?? null;
    }

    keptEntries.push(
      parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry),
    );
  }

  return orderSuccessorEntries({
    entries: keptEntries,
    activeBranchIds,
    originalIndexById,
  });
}

function collectLatestStateEntryIds(entries: SessionEntry[]): Set<string> {
  const latestByType = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (isDedupedStateEntry(entry)) {
      latestByType.set(entry.type, entry);
    }
  }
  const ids = new Set<string>();
  for (const entry of latestByType.values()) {
    ids.add(entry.id);
  }
  return ids;
}

function isDedupedStateEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    entry.type === "session_info"
  );
}

function orderSuccessorEntries(params: {
  entries: SessionEntry[];
  activeBranchIds: Set<string>;
  originalIndexById: Map<string, number>;
}): SessionEntry[] {
  const { entries, activeBranchIds, originalIndexById } = params;
  const entryIds = new Set<string>();
  for (const entry of entries) {
    entryIds.add(entry.id);
  }
  const childrenByParentId = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const parentId =
      entry.parentId !== null && entryIds.has(entry.parentId) ? entry.parentId : null;
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry));
    childrenByParentId.set(parentId, children);
  }

  const sortForActiveLeaf = (left: SessionEntry, right: SessionEntry) => {
    const leftActive = activeBranchIds.has(left.id);
    const rightActive = activeBranchIds.has(right.id);
    if (leftActive !== rightActive) {
      return leftActive ? 1 : -1;
    }
    return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);
  };

  const ordered: SessionEntry[] = [];
  const emittedIds = new Set<string>();
  const emitSubtree = (entry: SessionEntry) => {
    if (emittedIds.has(entry.id)) {
      return;
    }
    emittedIds.add(entry.id);
    ordered.push(entry);
    for (const child of (childrenByParentId.get(entry.id) ?? []).toSorted(sortForActiveLeaf)) {
      emitSubtree(child);
    }
  };

  for (const root of (childrenByParentId.get(null) ?? []).toSorted(sortForActiveLeaf)) {
    emitSubtree(root);
  }

  // Defensive fallback for malformed transcripts with cycles or broken parents.
  for (const entry of entries.toSorted(sortForActiveLeaf)) {
    emitSubtree(entry);
  }

  return ordered;
}

function buildSuccessorHeader(params: {
  previousHeader: SessionHeader | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  parentSession: string;
}): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: params.timestamp,
    cwd: params.previousHeader?.cwd || params.cwd,
    parentSession: params.parentSession,
  };
}

function resolveSuccessorSessionFile(params: {
  sessionFile: string;
  sessionId: string;
  timestamp: string;
}): string {
  const fileTimestamp = params.timestamp.replace(/[:.]/g, "-");
  return path.join(path.dirname(params.sessionFile), `${fileTimestamp}_${params.sessionId}.jsonl`);
}
