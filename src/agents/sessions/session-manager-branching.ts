import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import { projectCanonicalSessionEntryShape } from "../../config/sessions/store-entry-shape.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { parseOpaqueLeafEntry, parseParentLinkedOpaqueEntry } from "./session-manager-codec.js";
import { SessionManagerEntries } from "./session-manager-entries.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
import type {
  LabelEntry,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
} from "./session-manager-types.js";

export class SessionManagerBranching extends SessionManagerEntries {
  private collectBranchedSessionPath(leafId: string): {
    entries: SessionEntry[];
    opaqueEntries: PreservedOpaqueFileEntry[];
    tailId: string | null;
    usedIds: Set<string>;
  } {
    type BranchNode =
      | { type: "entry"; entry: SessionEntry }
      | { type: "opaque"; id: string; record: Record<string, unknown> };

    const opaqueById = new Map<string, Record<string, unknown>>();
    for (const opaqueEntry of this.opaqueFileEntries) {
      const leafEntry = parseOpaqueLeafEntry(opaqueEntry.record);
      const link = leafEntry ?? parseParentLinkedOpaqueEntry(opaqueEntry.record);
      if (link && isRecord(opaqueEntry.record)) {
        opaqueById.set(link.id, opaqueEntry.record);
      }
    }

    const reversedNodes: BranchNode[] = [];
    const seen = new Set<string>();
    let currentId: string | null = leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.byId.get(currentId);
      if (entry) {
        reversedNodes.push({ type: "entry", entry });
        if (this.logicalParentsById.has(entry.id)) {
          let physicalId = entry.parentId;
          while (physicalId && !seen.has(physicalId)) {
            const physicalRecord = opaqueById.get(physicalId);
            if (!physicalRecord || !this.opaqueParentsById.has(physicalId)) {
              break;
            }
            seen.add(physicalId);
            reversedNodes.push({ type: "opaque", id: physicalId, record: physicalRecord });
            physicalId = this.opaqueParentsById.get(physicalId) ?? null;
          }
          currentId = this.logicalParentsById.get(entry.id) ?? null;
        } else {
          currentId = entry.parentId;
        }
        continue;
      }
      const record = opaqueById.get(currentId);
      if (!record || !this.opaqueParentsById.has(currentId)) {
        break;
      }
      reversedNodes.push({ type: "opaque", id: currentId, record });
      currentId = this.opaqueParentsById.get(currentId) ?? null;
    }

    const entries: SessionEntry[] = [];
    const opaqueEntries: PreservedOpaqueFileEntry[] = [];
    const usedIds = new Set<string>();
    let tailId: string | null = null;
    for (const node of reversedNodes.toReversed()) {
      if (node.type === "entry") {
        if (node.entry.type === "label") {
          continue;
        }
        const branchEntry: SessionEntry =
          node.entry.parentId === tailId
            ? node.entry
            : ({ ...node.entry, parentId: tailId } as SessionEntry);
        entries.push(branchEntry);
        usedIds.add(branchEntry.id);
        tailId = branchEntry.id;
        continue;
      }
      if (parseOpaqueLeafEntry(node.record)) {
        continue;
      }
      opaqueEntries.push({
        index: entries.length + 1,
        record: { ...node.record, parentId: tailId },
      });
      usedIds.add(node.id);
      tailId = node.id;
    }
    return { entries, opaqueEntries, tailId, usedIds };
  }

  async createBranchedSession(leafId: string): Promise<string | undefined> {
    const previousSessionId = this.sessionId;
    const branchPath = this.collectBranchedSessionPath(leafId);
    if (branchPath.entries.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }

    const newSessionId = createManagedSessionId();
    const timestamp = new Date().toISOString();
    const persistenceTarget = this.persistenceTarget;

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: persistenceTarget ? previousSessionId : undefined,
    };
    const pathEntryIds = new Set(branchPath.entries.map((entry) => entry.id));
    const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
    for (const [targetId, label] of this.labelsById) {
      if (pathEntryIds.has(targetId)) {
        labelsToWrite.push({
          targetId,
          label,
          timestamp: this.labelTimestampsById.get(targetId)!,
        });
      }
    }

    const labelEntries: LabelEntry[] = [];
    let parentId = branchPath.tailId;
    for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
      const labelEntry: LabelEntry = {
        type: "label",
        id: generateSessionEntryId(branchPath.usedIds),
        parentId,
        timestamp: labelTimestamp,
        targetId,
        label,
      };
      branchPath.usedIds.add(labelEntry.id);
      labelEntries.push(labelEntry);
      parentId = labelEntry.id;
    }

    this.fileEntries = [header, ...branchPath.entries, ...labelEntries];
    this.opaqueFileEntries = branchPath.opaqueEntries;
    this.sessionId = newSessionId;
    this.buildIndex();
    if (!persistenceTarget) {
      return undefined;
    }

    const entryScope = {
      agentId: persistenceTarget.agentId,
      sessionKey: persistenceTarget.sessionKey,
      storePath: persistenceTarget.storePath,
    };
    const previousEntry = loadSessionEntry(entryScope);
    const updatedAt = Date.now();
    const nextTarget = { ...persistenceTarget, sessionId: newSessionId };
    const nextEntry = {
      ...(previousEntry ? projectCanonicalSessionEntryShape({ ...previousEntry }) : { updatedAt }),
      sessionId: newSessionId,
      updatedAt,
    };
    try {
      const persisted = await withTranscriptWriteTransaction(persistenceTarget, () => {
        const currentEntry = loadSessionEntry(entryScope);
        if (
          currentEntry?.sessionId !== previousSessionId ||
          currentEntry.lifecycleRevision !== previousEntry?.lifecycleRevision
        ) {
          return false;
        }
        replaceSessionEntrySync(entryScope, nextEntry);
        if (!replaceTranscriptEventsSync(nextTarget, this.getPersistedFileEntries())) {
          throw new Error("Branched session transcript was not persisted");
        }
        return true;
      });
      if (!persisted) {
        const actualEntry = loadSessionEntry(entryScope);
        const cause = actualEntry
          ? {
              actualSessionId: actualEntry.sessionId,
              code: "session-rebound" as const,
              expectedSessionId: previousSessionId,
              sessionKey: persistenceTarget.sessionKey,
            }
          : {
              code: "session-entry-missing" as const,
              expectedSessionId: previousSessionId,
              sessionKey: persistenceTarget.sessionKey,
            };
        throw new Error(`Branched session was not persisted: ${cause.code}`, { cause });
      }
    } catch (error) {
      this.setSessionTarget(persistenceTarget);
      throw error;
    }
    this.persistenceTarget = nextTarget;
    this.persistenceHeaderPending = false;
    return newSessionId;
  }
}
