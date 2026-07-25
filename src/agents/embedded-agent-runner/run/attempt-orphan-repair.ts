import type { UserMessage } from "../../../llm/types.js";
import type {
  SessionEntry as SessionManagerEntry,
  SessionMessageEntry,
} from "../../sessions/index.js";
import {
  resolveMessageMergeStrategy,
  type MessageMergeStrategy,
} from "./message-merge-strategy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type OrphanRepairSessionManager = {
  getLeafEntry: () => SessionManagerEntry | undefined;
  getEntry: (entryId: string) => SessionManagerEntry | undefined;
  appendThinkingLevelChange: (thinkingLevel: string) => string;
  appendModelChange: (provider: string, modelId: string) => string;
  appendCustomEntry: (customType: string, data?: unknown) => string;
  appendSessionInfo: (name: string) => string;
  appendLabelChange: (targetId: string, label?: string) => string;
};

type OrphanRepairCandidate = {
  messageEntry: SessionMessageEntry;
  trailingEntries: SessionManagerEntry[];
};

function canSkipTrailingEntryForOrphanRepair(entry: SessionManagerEntry): boolean {
  return (
    entry.type === "thinking_level_change" ||
    entry.type === "model_change" ||
    entry.type === "custom" ||
    entry.type === "label" ||
    entry.type === "session_info"
  );
}

function findTrailingMessageEntryForOrphanRepair(
  sessionManager: OrphanRepairSessionManager,
): OrphanRepairCandidate | undefined {
  const visited = new Set<string>();
  const trailingEntries: SessionManagerEntry[] = [];
  let entry = sessionManager.getLeafEntry();
  while (entry && entry.type !== "message" && canSkipTrailingEntryForOrphanRepair(entry)) {
    if (visited.has(entry.id)) {
      return undefined;
    }
    visited.add(entry.id);
    trailingEntries.push(entry);
    entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
  }
  return entry?.type === "message"
    ? { messageEntry: entry, trailingEntries: trailingEntries.toReversed() }
    : undefined;
}

function appendTrailingEntryForOrphanRepair(
  sessionManager: OrphanRepairSessionManager,
  entry: SessionManagerEntry,
  replayedEntryIds: Map<string, string>,
): void {
  if (entry.type === "thinking_level_change") {
    replayedEntryIds.set(entry.id, sessionManager.appendThinkingLevelChange(entry.thinkingLevel));
    return;
  }
  if (entry.type === "model_change") {
    replayedEntryIds.set(entry.id, sessionManager.appendModelChange(entry.provider, entry.modelId));
    return;
  }
  if (entry.type === "custom") {
    replayedEntryIds.set(entry.id, sessionManager.appendCustomEntry(entry.customType, entry.data));
    return;
  }
  if (entry.type === "session_info") {
    replayedEntryIds.set(entry.id, sessionManager.appendSessionInfo(entry.name ?? ""));
    return;
  }
  if (entry.type === "label") {
    const replayedTargetId = replayedEntryIds.get(entry.targetId);
    if (!replayedTargetId && !sessionManager.getEntry(entry.targetId)) {
      return;
    }
    const targetId = replayedTargetId ?? entry.targetId;
    replayedEntryIds.set(entry.id, sessionManager.appendLabelChange(targetId, entry.label));
  }
}

export function replayTrailingEntriesForOrphanRepair(
  sessionManager: OrphanRepairSessionManager,
  trailingEntries: SessionManagerEntry[],
): void {
  const replayedEntryIds = new Map<string, string>();
  for (const entry of trailingEntries) {
    appendTrailingEntryForOrphanRepair(sessionManager, entry, replayedEntryIds);
  }
}

type OrphanRepairPlan = Omit<OrphanRepairCandidate, "messageEntry"> & {
  contextEnginePrompt: string;
  messageEntry: SessionMessageEntry & { message: UserMessage };
  strategy: MessageMergeStrategy;
  removeLeaf: boolean;
};

function isUserSessionMessageEntry(
  entry: SessionMessageEntry,
): entry is SessionMessageEntry & { message: UserMessage } {
  return entry.message.role === "user";
}

export function resolveOrphanRepairPlan(params: {
  sessionManager: OrphanRepairSessionManager;
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
}): OrphanRepairPlan | undefined {
  const candidate = findTrailingMessageEntryForOrphanRepair(params.sessionManager);
  if (!candidate || !isUserSessionMessageEntry(candidate.messageEntry)) {
    return undefined;
  }
  const strategy = resolveMessageMergeStrategy();
  const merge = strategy.mergeOrphanedTrailingUserPrompt({
    prompt: params.prompt,
    trigger: params.trigger,
    leafMessage: candidate.messageEntry.message,
  });
  return {
    contextEnginePrompt: merge.prompt,
    messageEntry: candidate.messageEntry,
    trailingEntries: candidate.trailingEntries,
    strategy,
    removeLeaf: merge.removeLeaf,
  };
}
