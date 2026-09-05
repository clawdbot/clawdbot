import {
  readActiveTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import {
  copyCodeModeSourceAppend,
  getCodeModeSourceAppend,
  copyCodeModeSourceAppendOptions,
} from "../transcript-code-mode-source.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { isIndexedSessionEntry, isSessionContextMetadataEntry } from "./session-manager-codec.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { SessionManagerPersistence } from "./session-manager-persistence.js";
import type {
  AppendPersistenceOptions,
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ModelChangeEntry,
  ResetEntry,
  ResetReason,
  SessionContext,
  SessionEntry,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionHeader,
  SessionLeafControl,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "./session-manager-types.js";

export class SessionManagerEntries extends SessionManagerPersistence {
  protected appendEntry<T extends SessionEntry>(
    entry: T,
    options?: AppendPersistenceOptions,
  ): { entry: T; anchor?: TranscriptEntryAnchor; appended: boolean } {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Match the persisted JSON/toJSON shape exactly.
    const canonicalEntry = JSON.parse(JSON.stringify(entry)) as T;
    if (!isIndexedSessionEntry(canonicalEntry)) {
      throw new Error(`Invalid session transcript entry: ${entry.type}`);
    }
    if (entry.type === "message" && canonicalEntry.type === "message") {
      copyCodeModeSourceAppend(
        entry.message,
        canonicalEntry.message,
        getCodeModeSourceAppend(options),
        (source) => source,
      );
    }
    const activeBranchAppend =
      !this.pendingDeliberateAppend &&
      this.appendMode !== "side" &&
      !isSessionTranscriptSideAppendEntry(canonicalEntry);
    const persistenceResult = this.persist(
      canonicalEntry,
      copyCodeModeSourceAppendOptions(options, {
        ...options,
        ...(activeBranchAppend ? { appendIntent: "active-branch" as const } : {}),
      }),
    );
    if (persistenceResult?.adoptedMessageId) {
      this.reloadPersistedTranscript();
      // Context-excluded users have no payload in byId. The exact SQLite replay
      // anchors their identity; physical ancestry still closes older turns.
      if (this.resolveCurrentTurnEntryId() !== persistenceResult.adoptedMessageId) {
        throw new Error(
          `Session transcript keyed user is outside the current turn: ${persistenceResult.adoptedMessageId}`,
        );
      }
      canonicalEntry.id = persistenceResult.adoptedMessageId;
    } else if (
      persistenceResult?.effectiveParentId !== undefined &&
      persistenceResult.effectiveParentId !== canonicalEntry.parentId
    ) {
      this.reloadPersistedTranscript();
    } else {
      if (
        !isSessionTranscriptSideAppendEntry(canonicalEntry) &&
        canonicalEntry.parentId === this.appendParentId &&
        this.leafId !== this.appendParentId
      ) {
        this.logicalParentsById.set(canonicalEntry.id, this.leafId);
      }
      this.fileEntries.push(canonicalEntry);
      this.byId.set(canonicalEntry.id, canonicalEntry);
      this.appendParentId = canonicalEntry.id;
      if (isSessionTranscriptSideAppendEntry(canonicalEntry)) {
        this.appendMode = "side";
      } else {
        this.leafId = canonicalEntry.id;
        this.appendMode = undefined;
      }
    }
    this.pendingDeliberateAppend = false;
    return {
      entry: canonicalEntry,
      anchor: persistenceResult?.anchor,
      // Detached managers append locally; only the storage owner supplies a durable anchor.
      appended: persistenceResult?.appended ?? true,
    };
  }

  resolveCurrentTurnEntryId(isInterruptedTail?: (entry: SessionEntry) => boolean): string | null {
    let parentId = this.appendParentId;
    let remainingAncestors = this.byId.size;
    // Compaction rewrites context without consuming the current user turn.
    // Walk physical parents: opaque/context-excluded users still close older
    // turns. Replay may recognize its interrupted tail, never skip missing rows.
    while (parentId && remainingAncestors-- > 0) {
      const parent = this.byId.get(parentId);
      if (
        !parent ||
        (!isSessionContextMetadataEntry(parent) &&
          parent.type !== "compaction" &&
          !isInterruptedTail?.(parent))
      ) {
        break;
      }
      parentId = parent.parentId;
    }
    return parentId;
  }

  appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return this.appendMessageWithTranscriptAnchor(message, options).entryId;
  }

  appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): {
    entryId: string;
    message: SessionMessageEntry["message"];
    anchor?: TranscriptEntryAnchor;
    appended: boolean;
  } {
    if (message.role === "assistant") {
      applyAssistantDeliveryDirectives(message);
    }
    if (
      options?.idempotencyLookup !== "caller-checked" &&
      message.role === "user" &&
      "idempotencyKey" in message &&
      typeof message.idempotencyKey === "string" &&
      message.idempotencyKey.length > 0
    ) {
      const currentTurnId = this.resolveCurrentTurnEntryId();
      const current = currentTurnId ? this.byId.get(currentTurnId) : undefined;
      if (
        current?.type === "message" &&
        current.message.role === "user" &&
        "idempotencyKey" in current.message &&
        current.message.idempotencyKey === message.idempotencyKey
      ) {
        const anchor = this.persistenceTarget
          ? readActiveTranscriptEntryAnchor({ ...this.persistenceTarget, entryId: current.id })
          : undefined;
        if (this.persistenceTarget && !anchor) {
          throw new Error(`Session transcript anchor was not returned: ${current.id}`);
        }
        return {
          entryId: current.id,
          message: current.message,
          ...(anchor ? { anchor } : {}),
          appended: false,
        };
      }
    }
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      message,
    };
    const { entry: persisted, anchor, appended } = this.appendEntry(entry, options);
    return {
      entryId: persisted.id,
      message: persisted.message,
      ...(anchor ? { anchor } : {}),
      appended,
    };
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = {
      type: "thinking_level_change",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
  ): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    if (this.persistedBoundaryCount !== undefined) {
      this.persistedBoundaryCount += 1;
    }
    return entry.id;
  }

  appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    const entry: ResetEntry = {
      type: "reset",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    };
    this.appendEntry(entry);
    if (this.persistedBoundaryCount !== undefined) {
      this.persistedBoundaryCount += 1;
    }
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      name: name.replace(/[\r\n]+/g, " ").trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  getSessionName(): string | undefined {
    for (const entry of this.getEntries().toReversed()) {
      if (entry.type === "session_info") {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    const entry: CustomMessageEntry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    if (params.targetId !== null && !this.byId.has(params.targetId)) {
      throw new Error(`Entry ${params.targetId} not found`);
    }
    if (
      params.appendParentId !== null &&
      !this.byId.has(params.appendParentId) &&
      !this.opaqueParentsById.has(params.appendParentId)
    ) {
      throw new Error(`Append parent ${params.appendParentId} not found`);
    }
    const previousLeafId = this.leafId;
    this.leafId = params.targetId;
    const entry = this.createLeafControl(
      this.appendParentId,
      params.appendParentId,
      params.appendMode,
    );
    this.leafId = previousLeafId;
    this.persistRecord(entry);
    this.rememberLeafControl(entry);
    this.leafId = params.targetId;
    this.appendParentId = params.appendParentId;
    this.appendMode = params.appendMode;
    this.pendingDeliberateAppend = false;
    return entry;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.getEntry(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.byId.get(id);
    return entry ? this.normalizeEntryParent(entry) : undefined;
  }

  getChildren(parentId: string): SessionEntry[] {
    const children: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      const normalizedEntry = this.normalizeEntryParent(entry);
      if (normalizedEntry.parentId === parentId) {
        children.push(normalizedEntry);
      }
    }
    return children;
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: "label",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  buildSessionContext(): SessionContext {
    return buildCoreSessionContext(this.getBranch() as CoreSessionTreeEntry[]) as SessionContext;
  }

  getBoundaryCount(): number {
    return (
      this.persistedBoundaryCount ??
      this.getBranch().filter((entry) => entry.type === "compaction" || entry.type === "reset")
        .length
    );
  }

  getHeader(): SessionHeader | null {
    return this.fileEntries.find((entry) => entry.type === "session") ?? null;
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries
      .filter((entry): entry is SessionEntry => entry.type !== "session" && this.byId.has(entry.id))
      .map((entry) => this.normalizeEntryParent(entry));
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      nodeMap.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      const parentId = this.resolveCanonicalParentId(entry.parentId);
      if (parentId === null || parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(
        (left, right) =>
          new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
      );
      stack.push(...node.children);
    }
    return roots;
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchTargetId;
    this.appendParentId = branchTargetId;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  resetLeaf(): void {
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateSessionEntryId(),
      parentId: branchTargetId,
      timestamp: new Date().toISOString(),
      fromId: branchTargetId ?? "root",
      summary,
      details,
      fromHook,
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }
}
