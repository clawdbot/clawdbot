import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  isJsonRecord,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import { SessionManagerEntries } from "./session-manager-entries.js";
import { createSessionId, generateSessionEntryId } from "./session-manager-id.js";
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
      if (link && isJsonRecord(opaqueEntry.record)) {
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

  createBranchedSession(leafId: string): string | undefined {
    const previousSessionFile = this.sessionFile;
    const branchPath = this.collectBranchedSessionPath(leafId);
    if (branchPath.entries.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }

    const newSessionId = createSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sqlitePersistence = this.sqlitePersistence;
    const newSessionFile = sqlitePersistence
      ? formatSqliteSessionFileMarker({
          agentId: sqlitePersistence.agentId,
          sessionId: newSessionId,
          storePath: sqlitePersistence.storePath,
        })
      : join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.shouldPersist ? previousSessionFile : undefined,
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
    this.sessionFileSnapshot = undefined;
    if (this.shouldPersist) {
      this.sessionFile = newSessionFile;
      if (sqlitePersistence) {
        const updatedAt = Date.now();
        const previousEntry = loadSessionEntry({
          agentId: sqlitePersistence.agentId,
          sessionKey: sqlitePersistence.sessionKey,
          storePath: sqlitePersistence.storePath,
        });
        this.sqlitePersistence = { ...sqlitePersistence, sessionId: newSessionId };
        replaceSessionEntrySync(
          {
            agentId: sqlitePersistence.agentId,
            sessionKey: sqlitePersistence.sessionKey,
            storePath: sqlitePersistence.storePath,
          },
          {
            ...(previousEntry ?? { updatedAt }),
            sessionFile: newSessionFile,
            sessionId: newSessionId,
            updatedAt,
          },
        );
      }
      this.buildIndex();
      const hasAssistant = this.fileEntries.some(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      if (hasAssistant) {
        this.replacePersistedTranscript();
        this.flushed = true;
      } else {
        this.flushed = false;
      }
      return newSessionFile;
    }

    this.buildIndex();
    return undefined;
  }
}
import { join } from "node:path";
