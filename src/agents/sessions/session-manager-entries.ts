import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
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
  protected appendEntry(entry: SessionEntry, options?: AppendPersistenceOptions): void {
    if (
      !isSessionTranscriptSideAppendEntry(entry) &&
      entry.parentId === this.appendParentId &&
      this.leafId !== this.appendParentId
    ) {
      this.logicalParentsById.set(entry.id, this.leafId);
    }
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.appendParentId = entry.id;
    if (isSessionTranscriptSideAppendEntry(entry)) {
      this.appendMode = "side";
      this.promptReleasedSideBranchParentId = entry.id;
    } else {
      this.leafId = entry.id;
      this.appendMode = undefined;
      this.promptReleasedSideBranchParentId = undefined;
    }
    this.persist(entry, options);
  }

  appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateSessionEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.appendEntry(entry, options);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = {
      type: "thinking_level_change",
      id: generateSessionEntryId(this.byId),
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
      id: generateSessionEntryId(this.byId),
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
  ): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateSessionEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }

  appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    const entry: ResetEntry = {
      type: "reset",
      id: generateSessionEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateSessionEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateSessionEntryId(this.byId),
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
      id: generateSessionEntryId(this.byId),
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
      id: generateSessionEntryId(this.byId),
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

  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    const seen = new Set<string>();
    let currentId = fromId ?? this.leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const current = this.byId.get(currentId);
      if (current) {
        const normalizedCurrent = this.normalizeEntryParent(current);
        path.push(normalizedCurrent);
        currentId = normalizedCurrent.parentId;
      } else {
        currentId = this.opaqueParentsById.get(currentId) ?? null;
      }
    }
    path.reverse();
    return path;
  }

  buildSessionContext(): SessionContext {
    return buildCoreSessionContext(this.getBranch() as CoreSessionTreeEntry[]) as SessionContext;
  }

  getBoundaryCount(): number {
    return this.getBranch().filter((entry) => entry.type === "compaction" || entry.type === "reset")
      .length;
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
    const branchTargetId = this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchTargetId;
    this.appendParentId = branchTargetId;
    this.appendMode = undefined;
    this.promptReleasedSideBranchParentId = undefined;
  }

  resetLeaf(): void {
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.promptReleasedSideBranchParentId = undefined;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const branchTargetId = branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchTargetId;
    this.appendParentId = branchTargetId;
    this.appendMode = undefined;
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateSessionEntryId(this.byId),
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
