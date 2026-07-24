/**
 * Reads prior session transcript context for `/btw` side-question handoffs.
 */
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry as StoredSessionEntry,
} from "../config/sessions.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import {
  scanSessionTranscriptTree,
  type SessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";
import {
  buildSessionContext,
  migrateSessionEntries,
  type SessionEntry as AgentSessionEntry,
} from "./sessions/session-manager.js";

/** Resolves the persisted transcript file for a BTW session handoff. */
export function resolveBtwSessionTranscriptPath(params: {
  sessionId: string;
  sessionEntry?: StoredSessionEntry;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  try {
    const agentId = params.sessionKey?.split(":")[1];
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: params.storePath,
    });
    return resolveSessionFilePath(params.sessionId, params.sessionEntry, pathOpts);
  } catch (error) {
    diag.debug(
      `resolveSessionTranscriptPath failed: sessionId=${params.sessionId} err=${String(error)}`,
    );
    return undefined;
  }
}

// Session entries can come from older transcript formats, so id fields are
// narrowed at this boundary before branch reconstruction trusts them.
function readSessionEntryId(entry: AgentSessionEntry): string | undefined {
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

// Reconstructs the selected branch from leaf to root. Missing links or cycles
// mean the snapshot cannot be trusted, so callers fall back to a safe branch.
function buildSessionBranchEntries(
  tree: SessionTranscriptTree<AgentSessionEntry>,
  leafId: string | null | undefined,
): AgentSessionEntry[] | undefined {
  if (leafId === null) {
    return [];
  }
  if (!leafId) {
    return undefined;
  }
  const branch: AgentSessionEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return undefined;
    }
    seen.add(currentId);
    const node = tree.byId.get(currentId);
    if (!node) {
      return undefined;
    }
    if ((node.entry as { type?: unknown }).type !== "leaf") {
      branch.push(
        node.entry.parentId === node.parentId
          ? node.entry
          : ({ ...node.entry, parentId: node.parentId } as AgentSessionEntry),
      );
    }
    currentId = node.parentId ?? undefined;
  }
  return branch.toReversed();
}

function isTrailingUserMessage(entry: AgentSessionEntry | undefined): boolean {
  return (
    entry?.type === "message" &&
    (entry as { message?: { role?: unknown } }).message?.role === "user"
  );
}

/**
 * Reads prior messages for BTW continuation.
 *
 * When a transcript has fork links, this returns the selected snapshot branch
 * instead of the full file so a resumed agent does not inherit sibling-branch
 * messages.
 */
export async function readBtwTranscriptMessages(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
  snapshotLeafId?: string | null;
}): Promise<unknown[]> {
  try {
    if (!params.sessionKey || !params.storePath) {
      return [];
    }
    const sessionEntries = (await loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    })) as AgentSessionEntry[];
    migrateSessionEntries(sessionEntries);
    const tree = scanSessionTranscriptTree(sessionEntries);
    if (!tree.hasLeafUpdate) {
      return buildSessionContext(sessionEntries).messages;
    }

    const hasSnapshotLeaf = params.snapshotLeafId !== undefined;
    let branchEntries = hasSnapshotLeaf
      ? buildSessionBranchEntries(tree, params.snapshotLeafId)
      : undefined;
    if (hasSnapshotLeaf && branchEntries === undefined) {
      diag.debug(
        `btw snapshot leaf unavailable: sessionId=${params.sessionId} leaf=${params.snapshotLeafId}`,
      );
    }
    branchEntries ??= buildSessionBranchEntries(tree, tree.leafId);
    if (!hasSnapshotLeaf && isTrailingUserMessage(branchEntries?.at(-1))) {
      // Auto-selecting the newest branch must not include the current user turn
      // that triggered BTW handoff; the subagent should continue from its parent.
      const trailingId = readSessionEntryId(branchEntries!.at(-1)!);
      const parentId = trailingId ? tree.byId.get(trailingId)?.parentId : null;
      branchEntries = parentId ? (buildSessionBranchEntries(tree, parentId) ?? []) : [];
    }
    const sessionContext = buildSessionContext(branchEntries ?? sessionEntries);
    return Array.isArray(sessionContext.messages) ? sessionContext.messages : [];
  } catch {
    return [];
  }
}
