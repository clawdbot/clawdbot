import { readFile } from "node:fs/promises";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry as PiSessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry as StoredSessionEntry,
} from "../config/sessions.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";

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

function readSessionEntryId(entry: PiSessionEntry): string | undefined {
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function readSessionEntryParentId(entry: PiSessionEntry): string | null | undefined {
  const parentId = (entry as { parentId?: unknown }).parentId;
  if (parentId === null) {
    return null;
  }
  return typeof parentId === "string" && parentId.trim().length > 0 ? parentId : undefined;
}

function hasParentLinkedEntries(entries: PiSessionEntry[]): boolean {
  return entries.some((entry) => Boolean(readSessionEntryId(entry) && "parentId" in entry));
}

function buildSessionBranchEntries(
  entries: PiSessionEntry[],
  leafId: string | undefined,
): PiSessionEntry[] | undefined {
  if (!leafId) {
    return undefined;
  }
  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    const id = readSessionEntryId(entry);
    if (id) {
      byId.set(id, entry);
    }
  }
  const branch: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return undefined;
    }
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) {
      return undefined;
    }
    branch.push(entry);
    currentId = readSessionEntryParentId(entry) ?? undefined;
  }
  return branch.toReversed();
}

function readDefaultLeafId(entries: PiSessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = readSessionEntryId(entries[index]);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function isTrailingUserMessage(entry: PiSessionEntry | undefined): boolean {
  return (
    entry?.type === "message" &&
    (entry as { message?: { role?: unknown } }).message?.role === "user"
  );
}

export async function readBtwTranscriptMessages(params: {
  sessionFile: string;
  sessionId: string;
  snapshotLeafId?: string | null;
}): Promise<unknown[]> {
  try {
    const entries = parseSessionEntries(await readFile(params.sessionFile, "utf-8"));
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter(
      (entry): entry is PiSessionEntry => entry.type !== "session",
    );
    if (!hasParentLinkedEntries(sessionEntries)) {
      return buildSessionContext(sessionEntries).messages;
    }

    let branchEntries = params.snapshotLeafId
      ? buildSessionBranchEntries(sessionEntries, params.snapshotLeafId)
      : undefined;
    if (params.snapshotLeafId && !branchEntries) {
      diag.debug(
        `btw snapshot leaf unavailable: sessionId=${params.sessionId} leaf=${params.snapshotLeafId}`,
      );
    }
    branchEntries ??= buildSessionBranchEntries(sessionEntries, readDefaultLeafId(sessionEntries));
    if (!params.snapshotLeafId && isTrailingUserMessage(branchEntries?.at(-1))) {
      const parentId = readSessionEntryParentId(branchEntries!.at(-1)!);
      branchEntries = parentId ? (buildSessionBranchEntries(sessionEntries, parentId) ?? []) : [];
    }
    const sessionContext = buildSessionContext(branchEntries ?? sessionEntries);
    return Array.isArray(sessionContext.messages) ? sessionContext.messages : [];
  } catch {
    return [];
  }
}
