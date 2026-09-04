import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { replaceSessionWithBranchedTranscript } from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { parseOpaqueLeafEntry, parseParentLinkedOpaqueEntry } from "./session-manager-codec.js";
import type { SessionManagerPersistenceTarget } from "./session-manager-core.js";
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
      tailId = node.id;
    }
    return { entries, opaqueEntries, tailId };
  }

  async createBranchedSession(leafId: string): Promise<string | undefined> {
    this.ensureCompletePersistedHistory();
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
        id: generateSessionEntryId(),
        parentId,
        timestamp: labelTimestamp,
        targetId,
        label,
      };
      labelEntries.push(labelEntry);
      parentId = labelEntry.id;
    }

    // Build leaf controls on a detached tree: queued or failed persistence must
    // never expose a new in-memory identity paired with the old durable target.
    const branch = new SessionManagerBranching(this.cwd, undefined, [
      header,
      ...branchPath.entries,
      ...labelEntries,
    ]);
    branch.opaqueFileEntries = branchPath.opaqueEntries;
    branch.buildIndex();
    const adoptBranch = (target?: SessionManagerPersistenceTarget) => {
      this.fileEntries = branch.fileEntries;
      this.opaqueFileEntries = branch.opaqueFileEntries;
      this.sessionId = newSessionId;
      this.buildIndex();
      this.persistenceTarget = target;
      this.persistenceHeaderPending = false;
    };
    if (persistenceTarget) {
      await replaceSessionWithBranchedTranscript(
        persistenceTarget,
        { sessionId: newSessionId, events: branch.getPersistedFileEntries() },
        adoptBranch,
      );
    } else {
      adoptBranch();
    }
    return persistenceTarget ? newSessionId : undefined;
  }
}
