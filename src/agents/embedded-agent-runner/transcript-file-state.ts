/**
 * Reads, mutates, and atomically writes embedded session transcript files.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { appendRegularFile } from "../../infra/fs-safe.js";
import { privateFileStore } from "../../infra/private-file-store.js";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
} from "../sessions/index.js";

// Mutable view over a session JSONL transcript. The runner uses this layer to
// tolerate old or partially malformed rows before appending new canonical rows.
type BranchSummaryEntry = Extract<SessionEntry, { type: "branch_summary" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
type ModelChangeEntry = Extract<SessionEntry, { type: "model_change" }>;
type SessionInfoEntry = Extract<SessionEntry, { type: "session_info" }>;
type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
type ThinkingLevelChangeEntry = Extract<SessionEntry, { type: "thinking_level_change" }>;

type TranscriptLeafControlEntry = {
  type: "leaf";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string | null;
  appendParentId?: string | null;
  appendMode?: "side";
};

export type TranscriptPersistedEntry = SessionEntry | TranscriptLeafControlEntry;

const sessionEntryTypes = new Set<string>([
  "branch_summary",
  "compaction",
  "custom",
  "custom_message",
  "label",
  "message",
  "model_change",
  "session_info",
  "thinking_level_change",
] satisfies SessionEntry["type"][]);

const repairableToolCallContentTypes = new Set([
  "functionCall",
  "function_call",
  "toolCall",
  "toolUse",
  "tool_call",
  "tool_use",
]);

const invalidJsonlSlotType = "__openclaw_invalid_jsonl_slot";

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTextContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    isOptionalString(value.textSignature)
  );
}

function isThinkingContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    typeof value.thinking === "string" &&
    isOptionalString(value.thinkingSignature) &&
    (value.redacted === undefined || typeof value.redacted === "boolean")
  );
}

function isImageContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function hasToolCallId(value: Record<string, unknown>): boolean {
  return (
    isString(value.id) ||
    isString(value.call_id) ||
    isString(value.toolCallId) ||
    isString(value.toolUseId) ||
    isString(value.tool_call_id) ||
    isString(value.tool_use_id)
  );
}

function isToolCallPayload(value: unknown): boolean {
  return value === null || isRecord(value) || typeof value === "string";
}

function isToolCallContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    repairableToolCallContentTypes.has(value.type) &&
    hasToolCallId(value) &&
    isString(value.name) &&
    (value.arguments === undefined || isToolCallPayload(value.arguments)) &&
    (value.input === undefined || isToolCallPayload(value.input)) &&
    isOptionalString(value.thoughtSignature)
  );
}

function isPersistedContentBlock(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }
  switch (value.type) {
    case "text":
      return isTextContent(value);
    case "thinking":
      return isThinkingContent(value);
    case "image":
      return isImageContent(value);
    default:
      if (repairableToolCallContentTypes.has(value.type)) {
        return isToolCallContent(value);
      }
      return true;
  }
}

function isUserContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => isPersistedContentBlock(item)))
  );
}

function isAssistantContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => isPersistedContentBlock(item)))
  );
}

function isToolResultContent(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isPersistedContentBlock(item));
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isBashExecutionMessage(value: Record<string, unknown>): boolean {
  return (
    isString(value.command) &&
    typeof value.output === "string" &&
    (value.exitCode === undefined || typeof value.exitCode === "number") &&
    typeof value.cancelled === "boolean" &&
    typeof value.truncated === "boolean" &&
    isOptionalString(value.fullOutputPath) &&
    isOptionalBoolean(value.excludeFromContext)
  );
}

function isAgentMessage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.role) {
    case "assistant":
      return isAssistantContent(value.content);
    case "bashExecution":
      return isBashExecutionMessage(value);
    case "custom":
      return isString(value.customType) && isUserContent(value.content);
    case "toolResult":
      return (
        isString(value.toolCallId) &&
        isString(value.toolName) &&
        typeof value.isError === "boolean" &&
        isToolResultContent(value.content)
      );
    case "user":
      return isUserContent(value.content);
    default:
      return false;
  }
}

function hasSessionEntryBase(entry: FileEntry): boolean {
  const candidate = entry as {
    id?: unknown;
    parentId?: unknown;
    timestamp?: unknown;
  };
  return (
    isString(candidate.id) &&
    (candidate.parentId === undefined ||
      candidate.parentId === null ||
      isString(candidate.parentId)) &&
    (candidate.timestamp === undefined || isString(candidate.timestamp))
  );
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  if (
    entry.type === "session" ||
    !sessionEntryTypes.has(entry.type) ||
    !hasSessionEntryBase(entry)
  ) {
    return false;
  }
  switch (entry.type) {
    case "branch_summary": {
      const candidate = entry as { fromId?: unknown; summary?: unknown };
      return isString(candidate.fromId) && typeof candidate.summary === "string";
    }
    case "compaction": {
      const candidate = entry as {
        firstKeptEntryId?: unknown;
        summary?: unknown;
        tokensBefore?: unknown;
      };
      return (
        isString(candidate.firstKeptEntryId) &&
        typeof candidate.summary === "string" &&
        typeof candidate.tokensBefore === "number"
      );
    }
    case "custom":
      return isString((entry as { customType?: unknown }).customType);
    case "custom_message": {
      const candidate = entry as {
        content?: unknown;
        customType?: unknown;
        display?: unknown;
      };
      return (
        isString(candidate.customType) &&
        isUserContent(candidate.content) &&
        typeof candidate.display === "boolean"
      );
    }
    case "label": {
      const candidate = entry as { label?: unknown; targetId?: unknown };
      return (
        isString(candidate.targetId) &&
        (candidate.label === undefined || typeof candidate.label === "string")
      );
    }
    case "message": {
      return isAgentMessage((entry as { message?: unknown }).message);
    }
    case "model_change": {
      const candidate = entry as { modelId?: unknown; provider?: unknown };
      return isString(candidate.provider) && isString(candidate.modelId);
    }
    case "session_info": {
      const candidate = entry as { name?: unknown };
      return candidate.name === undefined || typeof candidate.name === "string";
    }
    case "thinking_level_change":
      return isString((entry as { thinkingLevel?: unknown }).thinkingLevel);
  }
  return false;
}

function parseLeafControlEntry(entry: unknown):
  | {
      id: string;
      parentId: string | null;
      targetId: string | null;
      appendParentId?: string | null;
      appendMode?: "side";
    }
  | undefined {
  if (!isRecord(entry) || entry.type !== "leaf") {
    return undefined;
  }
  const candidate = entry as {
    id?: unknown;
    parentId?: unknown;
    targetId?: unknown;
    appendParentId?: unknown;
    appendMode?: unknown;
    timestamp?: unknown;
  };
  if (
    !isString(candidate.id) ||
    (candidate.parentId !== undefined &&
      candidate.parentId !== null &&
      !isString(candidate.parentId)) ||
    (candidate.timestamp !== undefined && !isString(candidate.timestamp)) ||
    (candidate.targetId !== null && typeof candidate.targetId !== "string") ||
    (candidate.appendParentId !== undefined &&
      candidate.appendParentId !== null &&
      typeof candidate.appendParentId !== "string") ||
    (candidate.appendMode !== undefined && candidate.appendMode !== "side")
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    parentId: candidate.parentId ?? null,
    targetId: candidate.targetId,
    ...(candidate.appendParentId !== undefined ? { appendParentId: candidate.appendParentId } : {}),
    ...(candidate.appendMode === "side" ? { appendMode: candidate.appendMode } : {}),
  };
}

type ReadableSessionState = {
  entries: SessionEntry[];
  leafId: string | null;
  appendParentId: string | null;
  appendMode?: "side";
  opaqueParentsById: Map<string, string | null>;
  logicalParentsById: Map<string, string | null>;
};

// Keep every readable entry while repairing links through rejected rows. This
// preserves usable branches from partially written or migrated transcripts.
function readableSessionState(fileEntries: FileEntry[]): ReadableSessionState {
  const entries: SessionEntry[] = [];
  const acceptedIds = new Set<string>();
  const acceptedEntryById = new Map<string, SessionEntry>();
  const rejectedIds = new Set<string>();
  const rejectedParentById = new Map<string, string | null>();
  const logicalParentsById = new Map<string, string | null>();
  const invalidLeafIds = new Set<string>();
  const firstReadableDescendantByRejectedId = new Map<string, string>();
  const rejectedAncestorsByAcceptedId = new Map<string, string[]>();
  let effectiveLeafId: string | null = null;
  let effectiveAppendParentId: string | null = null;
  let effectiveAppendMode: "side" | undefined;
  const acceptedPath = (leafId: string | null | undefined): SessionEntry[] => {
    const pathLocal: SessionEntry[] = [];
    let id = leafId ?? null;
    const seen = new Set<string>();
    while (id !== null) {
      if (seen.has(id)) {
        break;
      }
      seen.add(id);
      const entry = acceptedEntryById.get(id);
      if (!entry) {
        break;
      }
      pathLocal.unshift(entry);
      id = entry.parentId;
    }
    return pathLocal;
  };
  const firstReadableDescendantOnBranch = (
    rejectedId: string,
    leafId: string | null | undefined,
  ): string | undefined => {
    for (const entry of acceptedPath(leafId)) {
      if (rejectedAncestorsByAcceptedId.get(entry.id)?.includes(rejectedId)) {
        return entry.id;
      }
    }
    return undefined;
  };
  const rejectedParentChain = (parentId: string | null | undefined): string[] => {
    const chain: string[] = [];
    let resolved = parentId ?? null;
    const seen = new Set<string>();
    while (resolved !== null && rejectedParentById.has(resolved)) {
      if (seen.has(resolved)) {
        break;
      }
      seen.add(resolved);
      chain.push(resolved);
      resolved = rejectedParentById.get(resolved) ?? null;
    }
    return chain;
  };
  const resolveRejectedParent = (parentId: string | null | undefined): string | null => {
    let resolved = parentId ?? null;
    const seen = new Set<string>();
    while (resolved !== null && rejectedParentById.has(resolved)) {
      if (seen.has(resolved)) {
        return null;
      }
      seen.add(resolved);
      resolved = rejectedParentById.get(resolved) ?? null;
    }
    return resolved;
  };
  const repairEntryLinks = (entry: SessionEntry): SessionEntry => {
    const rejectedAncestors = rejectedParentChain(entry.parentId);
    const resolvedRejectedParent =
      rejectedAncestors.length > 0 ? resolveRejectedParent(entry.parentId) : undefined;
    const parentId =
      resolvedRejectedParent !== undefined
        ? resolvedRejectedParent !== null && acceptedIds.has(resolvedRejectedParent)
          ? resolvedRejectedParent
          : null
        : (entry.parentId ?? null);
    let repaired = parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry);
    if (repaired.type === "compaction" && rejectedIds.has(repaired.firstKeptEntryId)) {
      // A rejected first-kept row would make compaction summaries unusable.
      // Prefer the closest readable parent, then a readable descendant on the
      // same branch, before falling back to the repaired parent.
      const resolvedFirstKeptParent = resolveRejectedParent(repaired.firstKeptEntryId);
      const firstKeptEntryId =
        (resolvedFirstKeptParent !== null && acceptedIds.has(resolvedFirstKeptParent)
          ? resolvedFirstKeptParent
          : undefined) ??
        firstReadableDescendantOnBranch(repaired.firstKeptEntryId, parentId) ??
        firstReadableDescendantByRejectedId.get(repaired.firstKeptEntryId) ??
        parentId;
      if (firstKeptEntryId !== null && firstKeptEntryId !== repaired.firstKeptEntryId) {
        repaired = { ...repaired, firstKeptEntryId } as SessionEntry;
      }
    }
    if (repaired.type !== "compaction") {
      for (const rejectedId of rejectedAncestors) {
        if (!firstReadableDescendantByRejectedId.has(rejectedId)) {
          firstReadableDescendantByRejectedId.set(rejectedId, repaired.id);
        }
      }
      if (rejectedAncestors.length > 0) {
        rejectedAncestorsByAcceptedId.set(repaired.id, rejectedAncestors);
      }
    }
    return repaired;
  };
  for (const rawEntry of fileEntries) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    const rawRecord = rawEntry as unknown as Record<string, unknown>;
    const entry = rawEntry as FileEntry;
    const id = rawRecord.id;
    const rawType = rawRecord.type;
    const rawParentId = rawRecord.parentId;
    const leafEntry = parseLeafControlEntry(rawRecord);
    if (leafEntry) {
      rejectedIds.add(leafEntry.id);
      const targetIsKnown =
        leafEntry.targetId === null ||
        acceptedIds.has(leafEntry.targetId) ||
        (rejectedParentById.has(leafEntry.targetId) && !invalidLeafIds.has(leafEntry.targetId));
      const appendParentIsKnown =
        leafEntry.appendParentId === undefined ||
        leafEntry.appendParentId === null ||
        acceptedIds.has(leafEntry.appendParentId) ||
        (rejectedParentById.has(leafEntry.appendParentId) &&
          !invalidLeafIds.has(leafEntry.appendParentId));
      if (!targetIsKnown || !appendParentIsKnown) {
        // Ignore corrupt navigation state, but keep the marker transparent so
        // descendants can still repair through the serialized raw branch.
        invalidLeafIds.add(leafEntry.id);
        rejectedParentById.set(leafEntry.id, leafEntry.parentId);
        continue;
      }
      rejectedParentById.set(leafEntry.id, leafEntry.targetId);
      const resolvedTargetId = resolveRejectedParent(leafEntry.targetId);
      effectiveLeafId =
        resolvedTargetId !== null && acceptedIds.has(resolvedTargetId) ? resolvedTargetId : null;
      effectiveAppendParentId =
        leafEntry.appendParentId === undefined ? effectiveLeafId : leafEntry.appendParentId;
      effectiveAppendMode = leafEntry.appendMode;
      continue;
    }
    if (rawType === "leaf") {
      if (isString(id)) {
        rejectedIds.add(id);
        invalidLeafIds.add(id);
        rejectedParentById.set(id, isString(rawParentId) ? rawParentId : null);
      }
      continue;
    }
    if (!isSessionEntry(entry)) {
      if (isString(id)) {
        rejectedIds.add(id);
        rejectedParentById.set(id, isString(rawParentId) ? rawParentId : null);
        const isParentLinkedOpaque =
          typeof rawType === "string" &&
          rawType !== "session" &&
          !id.startsWith("__openclaw_invalid_jsonl_slot_") &&
          !sessionEntryTypes.has(rawType) &&
          Object.hasOwn(rawRecord, "parentId") &&
          (rawParentId === null || isString(rawParentId));
        if (isParentLinkedOpaque) {
          effectiveAppendParentId = id;
        }
      }
      continue;
    }
    if (entry.type === "label" && !acceptedIds.has(entry.targetId)) {
      rejectedIds.add(entry.id);
      rejectedParentById.set(entry.id, entry.parentId);
      continue;
    }
    if (acceptedIds.has(entry.id)) {
      continue;
    }
    const hasSerializedParent = Object.hasOwn(rawRecord, "parentId");
    if (
      !hasSerializedParent ||
      (!isSessionTranscriptSideAppendEntry(rawRecord) &&
        entry.parentId === effectiveAppendParentId &&
        effectiveLeafId !== effectiveAppendParentId)
    ) {
      logicalParentsById.set(entry.id, effectiveLeafId);
    }
    const repaired = repairEntryLinks(entry);
    entries.push(repaired);
    acceptedIds.add(repaired.id);
    acceptedEntryById.set(repaired.id, repaired);
    effectiveAppendParentId = repaired.id;
    if (isSessionTranscriptSideAppendEntry(rawRecord)) {
      effectiveAppendMode = "side";
    } else {
      effectiveLeafId = repaired.id;
      effectiveAppendMode = undefined;
    }
  }
  return {
    entries,
    leafId: effectiveLeafId,
    appendParentId: effectiveAppendParentId,
    ...(effectiveAppendMode ? { appendMode: effectiveAppendMode } : {}),
    opaqueParentsById: rejectedParentById,
    logicalParentsById,
  };
}

function sessionHeaderVersion(header: SessionHeader | null): number {
  return typeof header?.version === "number" ? header.version : 1;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function serializeTranscriptFileEntries(entries: readonly unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function fileEntryOrMigrationSlot(value: unknown, index: number): FileEntry {
  if (isRecord(value)) {
    return value as unknown as FileEntry;
  }
  return {
    type: invalidJsonlSlotType,
    id: `__openclaw_invalid_jsonl_slot_${index}`,
    parentId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
  } as unknown as FileEntry;
}

function createReadableTranscriptFileState(params: {
  fileEntries: FileEntry[];
  header: SessionHeader | null;
  migrated?: boolean;
}): TranscriptFileState {
  const readable = readableSessionState(params.fileEntries);
  return new TranscriptFileState({
    header: params.header,
    entries: readable.entries,
    leafId: readable.leafId,
    appendParentId: params.migrated ? readable.leafId : readable.appendParentId,
    ...(!params.migrated && readable.appendMode ? { appendMode: readable.appendMode } : {}),
    opaqueParentsById: readable.opaqueParentsById,
    logicalParentsById: readable.logicalParentsById,
    migrated: params.migrated,
  });
}

/** Builds readable branch state from persisted transcript records. */
export function createTranscriptFileStateFromPersistedEntries(
  entries: readonly unknown[],
): TranscriptFileState {
  const fileEntries = entries.map(fileEntryOrMigrationSlot);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  return createReadableTranscriptFileState({ fileEntries, header });
}

/** In-memory transcript state with branch, label, and append helpers. */
export class TranscriptFileState {
  readonly header: SessionHeader | null;
  readonly entries: SessionEntry[];
  readonly migrated: boolean;
  private readonly byId = new Map<string, SessionEntry>();
  private readonly labelsById = new Map<string, string>();
  private readonly labelTimestampsById = new Map<string, string>();
  private readonly opaqueParentsById = new Map<string, string | null>();
  private readonly logicalParentsById = new Map<string, string | null>();
  private leafId: string | null = null;
  private appendParentId: string | null = null;
  private appendMode: "side" | undefined;

  constructor(params: {
    header: SessionHeader | null;
    entries: SessionEntry[];
    leafId?: string | null;
    appendParentId?: string | null;
    appendMode?: "side";
    opaqueParentsById?: ReadonlyMap<string, string | null>;
    logicalParentsById?: ReadonlyMap<string, string | null>;
    migrated?: boolean;
  }) {
    this.header = params.header;
    this.entries = [...params.entries];
    this.migrated = params.migrated === true;
    for (const [id, parentId] of params.opaqueParentsById ?? []) {
      this.opaqueParentsById.set(id, parentId);
    }
    for (const [id, parentId] of params.logicalParentsById ?? []) {
      this.logicalParentsById.set(id, parentId);
    }
    this.rebuildIndex(params.leafId, params.appendParentId);
    this.appendMode = params.appendMode;
  }

  private resolveCanonicalParentId(parentId: string | null): string | null {
    const seen = new Set<string>();
    let currentId = parentId;
    while (currentId !== null && this.opaqueParentsById.has(currentId)) {
      if (seen.has(currentId)) {
        return null;
      }
      seen.add(currentId);
      currentId = this.opaqueParentsById.get(currentId) ?? null;
    }
    return currentId;
  }

  private rebuildIndex(leafId?: string | null, appendParentId?: string | null): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      this.appendParentId = entry.id;
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
          this.labelTimestampsById.set(entry.targetId, entry.timestamp);
        } else {
          this.labelsById.delete(entry.targetId);
          this.labelTimestampsById.delete(entry.targetId);
        }
      }
    }
    if (leafId !== undefined) {
      this.leafId = leafId;
    }
    if (appendParentId !== undefined) {
      this.appendParentId = appendParentId;
    } else if (leafId !== undefined) {
      this.appendParentId = leafId;
    }
  }

  getCwd(): string {
    return this.header?.cwd ?? process.cwd();
  }

  getHeader(): SessionHeader | null {
    return this.header;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getAppendParentId(): string | null {
    return this.appendParentId;
  }

  getAppendMode(): "side" | undefined {
    return this.appendMode;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getBranch(fromId?: string): SessionEntry[] {
    const branch: SessionEntry[] = [];
    const seen = new Set<string>();
    let currentId = fromId ?? this.leafId;
    while (currentId && !seen.has(currentId)) {
      const current = this.byId.get(currentId);
      if (!current) {
        break;
      }
      seen.add(current.id);
      const resolvedParentId = this.logicalParentsById.has(current.id)
        ? (this.logicalParentsById.get(current.id) ?? null)
        : this.resolveCanonicalParentId(current.parentId);
      const parentId =
        resolvedParentId === current.id || (resolvedParentId && seen.has(resolvedParentId))
          ? null
          : resolvedParentId;
      branch.push(
        parentId === current.parentId ? current : ({ ...current, parentId } as SessionEntry),
      );
      currentId = parentId;
    }
    branch.reverse();
    return branch;
  }

  buildSessionContext(): SessionContext {
    const entries = this.getBranch();
    const leafId = entries.at(-1)?.id ?? null;
    return buildSessionContext(entries, leafId, new Map(entries.map((entry) => [entry.id, entry])));
  }

  /** Move the active leaf to an existing entry without appending a row. */
  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    this.appendParentId = branchFromId;
    this.appendMode = undefined;
  }

  /** Clear the active leaf so the next append starts a root branch. */
  resetLeaf(): void {
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
  }

  appendMessage(message: SessionMessageEntry["message"]): SessionMessageEntry {
    return this.appendEntry({
      type: "message",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      message,
    });
  }

  appendThinkingLevelChange(thinkingLevel: string): ThinkingLevelChangeEntry {
    return this.appendEntry({
      type: "thinking_level_change",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    });
  }

  appendModelChange(provider: string, modelId: string): ModelChangeEntry {
    return this.appendEntry({
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    });
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): CompactionEntry {
    return this.appendEntry({
      type: "compaction",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    });
  }

  appendCustomEntry(customType: string, data?: unknown): CustomEntry {
    return this.appendEntry({
      type: "custom",
      customType,
      data,
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    });
  }

  appendSessionInfo(name: string): SessionInfoEntry {
    return this.appendEntry({
      type: "session_info",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      name: name.trim(),
    });
  }

  appendCustomMessageEntry(
    customType: string,
    content: CustomMessageEntry["content"],
    display: boolean,
    details?: unknown,
  ): CustomMessageEntry {
    return this.appendEntry({
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    });
  }

  appendLabelChange(targetId: string, label: string | undefined): LabelEntry {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    return this.appendEntry({
      type: "label",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    });
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): BranchSummaryEntry {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    this.appendParentId = branchFromId;
    return this.appendEntry({
      type: "branch_summary",
      id: generateEntryId(this.byId),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      details,
      fromHook,
    });
  }

  appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): TranscriptLeafControlEntry {
    if (params.targetId !== null && !this.byId.has(params.targetId)) {
      throw new Error(`Entry ${params.targetId} not found`);
    }
    if (
      params.appendParentId !== null &&
      !this.byId.has(params.appendParentId) &&
      !this.opaqueParentsById.has(params.appendParentId)
    ) {
      throw new Error(`Entry ${params.appendParentId} not found`);
    }
    const entry: TranscriptLeafControlEntry = {
      type: "leaf",
      id: generateEntryId({
        has: (id) => this.byId.has(id) || this.opaqueParentsById.has(id),
      }),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId: params.targetId,
      ...(params.appendParentId !== params.targetId
        ? { appendParentId: params.appendParentId }
        : {}),
      ...(params.appendMode ? { appendMode: params.appendMode } : {}),
    };
    this.opaqueParentsById.set(entry.id, params.targetId);
    this.leafId = params.targetId;
    this.appendParentId = params.appendParentId;
    this.appendMode = params.appendMode;
    return entry;
  }

  private appendEntry<T extends SessionEntry>(entry: T): T {
    if (
      !isSessionTranscriptSideAppendEntry(entry) &&
      entry.parentId === this.appendParentId &&
      this.leafId !== this.appendParentId
    ) {
      this.logicalParentsById.set(entry.id, this.leafId);
    }
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.appendParentId = entry.id;
    if (isSessionTranscriptSideAppendEntry(entry)) {
      this.appendMode = "side";
    } else {
      this.leafId = entry.id;
      this.appendMode = undefined;
    }
    if (entry.type === "label") {
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
    return entry;
  }
}

/** Read a transcript file, migrate old rows, and drop only unrecoverable entries. */
export async function readTranscriptFileState(sessionFile: string): Promise<TranscriptFileState> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const fileEntries = (parseSessionEntries(raw) as unknown[]).map(fileEntryOrMigrationSlot);
  const headerBeforeMigration =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const headerVersionBeforeMigration = sessionHeaderVersion(headerBeforeMigration);
  const migrated = headerVersionBeforeMigration < CURRENT_SESSION_VERSION;
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  return createReadableTranscriptFileState({ fileEntries, header, migrated });
}

/** Rewrite the full transcript through the private-file store. */
export async function writeTranscriptFileAtomic(
  filePath: string,
  entries: Array<SessionHeader | TranscriptPersistedEntry>,
): Promise<void> {
  await privateFileStore(path.dirname(filePath)).writeText(
    path.basename(filePath),
    serializeTranscriptFileEntries(entries),
  );
}

/** Persist a state mutation using append-only writes unless migration forced a rewrite. */
export async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: TranscriptFileState;
  appendedEntries: TranscriptPersistedEntry[];
}): Promise<void> {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    const appendedLeafControls = params.appendedEntries.filter(
      (entry): entry is TranscriptLeafControlEntry => entry.type === "leaf",
    );
    await writeTranscriptFileAtomic(params.sessionFile, [
      ...(params.state.header ? [params.state.header] : []),
      ...params.state.entries,
      ...appendedLeafControls,
    ]);
    return;
  }
  await appendRegularFile({
    filePath: params.sessionFile,
    content: `${params.appendedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    rejectSymlinkParents: true,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
