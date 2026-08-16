import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { derivePromptTokens, normalizeUsage } from "../../agents/usage.js";
import type {
  SessionParentForkDecision,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { resolveFreshSessionTotalTokens } from "./session-entry-runtime.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import type { SessionEntry } from "./types.js";

export type ParentForkSourceTranscript = {
  appendMode?: "side";
  appendParentId: string | null;
  branchEntries: TranscriptEvent[];
  cwd?: string;
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  leafId: string | null;
  preserveLeafControl: boolean;
};

type SqliteTranscriptParentTokenEstimate = {
  kind: "exact-context" | "legacy-or-bytes";
  tokens: number;
};

const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

export function planParentForkDecision(
  parentEntry: SessionEntry,
  transcriptEstimate?: SqliteTranscriptParentTokenEstimate,
  options: { preferTranscriptEstimate?: boolean } = {},
): SessionParentForkDecision {
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens = options.preferTranscriptEstimate
    ? transcriptEstimate?.tokens
    : (resolveFreshSessionTotalTokens(parentEntry) ?? transcriptEstimate?.tokens);
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
}

export function estimateTranscriptPromptTokens(
  events: readonly TranscriptEvent[],
): SqliteTranscriptParentTokenEstimate | undefined {
  let byteEstimate = 0;
  let latestUsageEstimate: number | undefined;
  let latestUsageEstimateIsExactContext = false;
  let trailingBytes = 0;
  for (const event of selectParentForkTokenEstimateEvents(events)) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    byteEstimate += serializedBytes;
    if (!isRecord(event)) {
      if (latestUsageEstimate !== undefined) {
        trailingBytes += serializedBytes;
      }
      continue;
    }
    const message = isRecord(event.message) ? event.message : undefined;
    const usageRaw = isRecord(message?.usage)
      ? message.usage
      : isRecord(event.usage)
        ? event.usage
        : undefined;
    if (!usageRaw) {
      if (latestUsageEstimate !== undefined) {
        trailingBytes += serializedBytes;
      }
      continue;
    }
    const contextUsage = readTranscriptContextUsage(usageRaw);
    if (message?.api === "cli" && contextUsage === undefined) {
      latestUsageEstimate = undefined;
      latestUsageEstimateIsExactContext = false;
      trailingBytes = 0;
      continue;
    }
    if (contextUsage?.state === "unavailable") {
      latestUsageEstimate = undefined;
      latestUsageEstimateIsExactContext = false;
      trailingBytes = 0;
      continue;
    }
    if (contextUsage?.state === "available") {
      latestUsageEstimate = normalizePositiveTokenCount(contextUsage.totalTokens);
      latestUsageEstimateIsExactContext = true;
      trailingBytes = 0;
      continue;
    }
    const usage = normalizeUsage(usageRaw);
    const promptTokens = normalizePositiveTokenCount(
      derivePromptTokens({
        input: usage?.input,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      }),
    );
    const outputTokens = normalizePositiveTokenCount(usage?.output) ?? 0;
    const totalTokens =
      promptTokens === undefined
        ? undefined
        : normalizePositiveTokenCount(promptTokens + outputTokens);
    if (typeof totalTokens === "number") {
      latestUsageEstimate = totalTokens;
      latestUsageEstimateIsExactContext = false;
      trailingBytes = 0;
    }
  }
  if (latestUsageEstimate !== undefined) {
    const tokens = normalizePositiveTokenCount(latestUsageEstimate + Math.ceil(trailingBytes / 4));
    return tokens === undefined
      ? undefined
      : {
          kind: latestUsageEstimateIsExactContext ? "exact-context" : "legacy-or-bytes",
          tokens,
        };
  }
  const tokens = normalizePositiveTokenCount(Math.ceil(byteEstimate / 4));
  return tokens === undefined ? undefined : { kind: "legacy-or-bytes", tokens };
}

function selectParentForkTokenEstimateEvents(
  events: readonly TranscriptEvent[],
): TranscriptEvent[] {
  const entries = events.filter((entry) => !(isRecord(entry) && entry.type === "session"));
  const tree = scanSessionTranscriptTree(entries);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  return mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  }).nodes.flatMap((node) => node.entry);
}

function normalizePositiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readTranscriptContextUsage(
  usageRaw: Record<string, unknown>,
): { state: "available"; totalTokens: number } | { state: "unavailable" } | undefined {
  const contextUsage = usageRaw.contextUsage;
  if (!isRecord(contextUsage)) {
    return undefined;
  }
  if (contextUsage.state === "unavailable") {
    return { state: "unavailable" };
  }
  if (contextUsage.state !== "available") {
    return undefined;
  }
  const totalTokens = normalizePositiveTokenCount(contextUsage.totalTokens);
  return totalTokens === undefined ? undefined : { state: "available", totalTokens };
}

export function resolveParentForkSourceTranscript(
  fileEntries: readonly TranscriptEvent[],
  forkFrom?: "last-completed",
): ParentForkSourceTranscript | null {
  if (fileEntries.length === 0) {
    return null;
  }
  const header = fileEntries.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "session",
  );
  const entries = fileEntries.filter((entry) => !(isRecord(entry) && entry.type === "session"));
  const tree = scanSessionTranscriptTree(entries);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  const mergedPath = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  });
  const visibleBranchEntries = mergedPath.nodes.flatMap((node) => {
    if (!isRecord(node.entry)) {
      return [];
    }
    const parentId = node.selectedParentId;
    return [node.entry.parentId === parentId ? node.entry : { ...node.entry, parentId }];
  });
  const branchEntries =
    forkFrom === "last-completed"
      ? visibleBranchEntries.slice(0, findLastCompletedAssistantIndex(visibleBranchEntries) + 1)
      : visibleBranchEntries;
  const pathEntryIds = new Set(
    branchEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastLeafUpdateNode = tree.nodes.findLast((node) => node.leafId !== undefined);
  const lastBranchEntry = branchEntries.at(-1);
  const lastBranchEntryId =
    isRecord(lastBranchEntry) && typeof lastBranchEntry.id === "string" ? lastBranchEntry.id : null;
  return {
    appendParentId: forkFrom === "last-completed" ? lastBranchEntryId : mergedPath.appendParentId,
    ...(forkFrom !== "last-completed" && lastLeafUpdateNode?.appendMode
      ? { appendMode: lastLeafUpdateNode.appendMode }
      : {}),
    branchEntries,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    labelsToWrite: collectBranchLabels({ allEntries: entries, pathEntryIds }),
    leafId: forkFrom === "last-completed" ? lastBranchEntryId : tree.leafId,
    preserveLeafControl:
      forkFrom !== "last-completed" && isSessionTranscriptLeafControl(lastLeafUpdateNode?.entry),
  };
}

function findLastCompletedAssistantIndex(entries: readonly TranscriptEvent[]): number {
  return entries.findLastIndex((entry) => {
    const message = isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
    // Tool-use assistant messages are mid-turn checkpoints. Any other persisted
    // assistant message is a stable boundary, including legacy rows without a reason.
    return message?.role === "assistant" && message.stopReason !== "toolUse";
  });
}

function collectBranchLabels(params: {
  allEntries: readonly TranscriptEvent[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  return params.allEntries.flatMap((entry) =>
    isRecord(entry) &&
    entry.type === "label" &&
    typeof entry.label === "string" &&
    typeof entry.targetId === "string" &&
    typeof entry.id === "string" &&
    !params.pathEntryIds.has(entry.id) &&
    params.pathEntryIds.has(entry.targetId) &&
    typeof entry.timestamp === "string"
      ? [{ targetId: entry.targetId, label: entry.label, timestamp: entry.timestamp }]
      : [],
  );
}

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

function buildLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): TranscriptEvent[] {
  let parentId = params.lastEntryId;
  return params.labelsToWrite.map(({ targetId, label, timestamp }) => {
    const entry = {
      type: "label",
      id: generateEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    };
    parentId = entry.id;
    return entry;
  });
}

function hasAssistantEntry(entries: readonly TranscriptEvent[]): boolean {
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant",
  );
}

export function buildForkedChildTranscriptEvents(params: {
  parentSessionFile: string;
  source: ParentForkSourceTranscript;
  targetSessionId: string;
}): TranscriptEvent[] {
  const header = {
    ...createSessionTranscriptHeader({ cwd: params.source.cwd, sessionId: params.targetSessionId }),
    parentSession: params.parentSessionFile,
  };
  if (!params.source.preserveLeafControl && !hasAssistantEntry(params.source.branchEntries)) {
    return [header];
  }

  const pathEntryIds = new Set(
    params.source.branchEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastPathEntry = params.source.branchEntries.at(-1);
  const lastPathEntryId =
    isRecord(lastPathEntry) && typeof lastPathEntry.id === "string" ? lastPathEntry.id : null;
  const labelEntries = buildLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: lastPathEntryId,
  });
  const leafEntry = params.source.preserveLeafControl
    ? {
        type: "leaf",
        id: generateEntryId(pathEntryIds),
        parentId: (labelEntries.at(-1) as { id?: string } | undefined)?.id ?? lastPathEntryId,
        timestamp: new Date().toISOString(),
        targetId: params.source.leafId,
        appendParentId: params.source.appendParentId,
        ...(params.source.appendMode ? { appendMode: params.source.appendMode } : {}),
      }
    : null;
  return [
    header,
    ...params.source.branchEntries,
    ...labelEntries,
    ...(leafEntry ? [leafEntry] : []),
  ];
}
