/**
 * Rotates compacted sessions into successor transcript files when configured.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactionEntry, SessionEntry, SessionHeader } from "../sessions/index.js";
import { collectDuplicateUserMessageEntryIdsForCompaction } from "./compaction-duplicate-user-messages.js";
import { stripThinkingSignaturesFromMessage } from "./thinking.js";
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
  // Default to rotating after compaction so a long-lived session cannot grow past the
  // context window into an unrecoverable every-turn-compaction spiral (#112476). Only an
  // explicit `truncateAfterCompaction: false` opts out of the successor-transcript rotation.
  return config?.agents?.defaults?.compaction?.truncateAfterCompaction !== false;
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
  const timestamp = resolveTimestampMsToIsoString(params.now?.().getTime());
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
  const preCompactionKeptBranchIds = new Set<string>();
  let foundFirstKept = false;
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = branch[index];
    if (!entry) {
      continue;
    }
    if (compaction.firstKeptEntryId && entry.id === compaction.firstKeptEntryId) {
      foundFirstKept = true;
    }
    if (foundFirstKept) {
      preCompactionKeptBranchIds.add(entry.id);
    } else {
      summarizedBranchIds.add(entry.id);
    }
  }

  // Preserve the last assistant message before firstKeptEntryId so the successor
  // transcript keeps a compactionSummary → assistant → user structure instead of
  // dropping the assistant reply (issue #76729).
  // Skip for hardened manual compaction boundaries where firstKeptEntryId already
  // points to the compaction entry itself (all pre-compaction content is
  // intentionally excluded).
  const isHardenedBoundary = compaction.firstKeptEntryId === compaction.id;
  let preservedAssistantId: string | undefined;
  let preservedAssistantIndex = -1;
  let firstKeptIndex = -1;
  if (!isHardenedBoundary) {
    for (let index = latestCompactionIndex - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (
        entry &&
        summarizedBranchIds.has(entry.id) &&
        entry.type === "message" &&
        entry.message.role === "assistant"
      ) {
        preservedAssistantId = entry.id;
        preservedAssistantIndex = index;
        break;
      }
    }
  }
  if (compaction.firstKeptEntryId) {
    firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  }
  const branchIndexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const preservedPreCompactionIds = new Set<string>();
  if (preservedAssistantId) {
    preservedPreCompactionIds.add(preservedAssistantId);
    const assistant = branch[preservedAssistantIndex];
    if (assistant?.type === "message" && assistant.message.role === "assistant") {
      const toolCallIds = new Set(
        assistant.message.content
          .filter((block) => block.type === "toolCall")
          .map((block) => block.id),
      );
      for (
        let index = preservedAssistantIndex + 1;
        index >= 0 && index < firstKeptIndex;
        index += 1
      ) {
        const entry = branch[index];
        if (entry?.type === "message" && entry.message.role === "toolResult") {
          if (toolCallIds.has(entry.message.toolCallId)) {
            preservedPreCompactionIds.add(entry.id);
          }
        }
      }
    }
  }

  const latestStateEntryIds = collectLatestStateEntryIds(branch.slice(0, latestCompactionIndex));
  const staleStateEntryIds = new Set<string>();
  for (const entry of branch.slice(0, latestCompactionIndex)) {
    if (isDedupedStateEntry(entry) && !latestStateEntryIds.has(entry.id)) {
      staleStateEntryIds.add(entry.id);
    }
  }

  const removedIds = new Set<string>();
  const keptPreCompactionEntries = branch
    .slice(0, latestCompactionIndex)
    .filter((entry) => !summarizedBranchIds.has(entry.id));
  const postCompactionEntries = branch.slice(latestCompactionIndex + 1);
  const duplicateUserMessageIds = new Set<string>([
    ...collectDuplicateUserMessageEntryIdsForCompaction(keptPreCompactionEntries),
    ...collectDuplicateUserMessageEntryIdsForCompaction(postCompactionEntries),
  ]);
  for (const entry of allEntries) {
    const branchIndex = branchIndexById.get(entry.id) ?? -1;
    const summarizedContextMarker =
      branchIndex > preservedAssistantIndex &&
      branchIndex < firstKeptIndex &&
      (entry.type === "custom_message" || entry.type === "branch_summary");
    if (
      (summarizedBranchIds.has(entry.id) &&
        entry.type === "message" &&
        !preservedPreCompactionIds.has(entry.id)) ||
      (summarizedBranchIds.has(entry.id) && summarizedContextMarker) ||
      staleStateEntryIds.has(entry.id) ||
      duplicateUserMessageIds.has(entry.id)
    ) {
      removedIds.add(entry.id);
    }
  }
  // The preserved assistant reply is pre-compaction content that needs thinking
  // signature stripping, same as other pre-compaction kept entries.
  for (const entryId of preservedPreCompactionIds) {
    preCompactionKeptBranchIds.add(entryId);
  }
  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
    }
  }

  const entryById = new Map<string, SessionEntry>();
  const originalIndexById = new Map<string, number>();
  for (const [index, entry] of allEntries.entries()) {
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

    const reparented =
      parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry);
    // Strip thinking signatures only from pre-compaction kept entries. Pre-compaction
    // signatures are bound to the original context prefix; the successor file has a different
    // prefix so those signatures would cause Anthropic "Invalid signature in thinking block".
    // Post-compaction entries were generated in the new context and have valid signatures.
    // Move the compaction boundary back to the preserved turn so its complete
    // assistant/tool-result sequence is included in the successor context.
    let transformed: SessionEntry = reparented;
    if (reparented.type === "message" && preCompactionKeptBranchIds.has(reparented.id)) {
      transformed = {
        ...reparented,
        message: stripThinkingSignaturesFromMessage(reparented.message),
      };
    }
    if (
      reparented.type === "compaction" &&
      reparented.id === compaction.id &&
      preservedAssistantId &&
      reparented.firstKeptEntryId !== reparented.id
    ) {
      transformed = { ...reparented, firstKeptEntryId: preservedAssistantId };
    }
    keptEntries.push(transformed);
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
