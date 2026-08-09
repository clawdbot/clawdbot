import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  MSTEAMS_CONVERSATIONS_LEGACY_FILENAME,
  normalizeMSTeamsLegacyConversationStore,
  type MSTeamsLegacyConversationStoreData,
} from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";

export type LegacyConversationMigrationSource = {
  filePath: string;
  state: MSTeamsLegacyConversationStoreData;
  archived: boolean;
};

function parseLegacyConversationStore(value: unknown): MSTeamsLegacyConversationStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.conversations)) {
    return null;
  }
  return normalizeMSTeamsLegacyConversationStore({
    version: 1,
    conversations: value.conversations as Record<string, StoredConversationReference>,
  });
}

async function readLegacyConversationStore(
  filePath: string,
): Promise<MSTeamsLegacyConversationStoreData | null> {
  try {
    return parseLegacyConversationStore(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function resolveLegacyConversationMigrationSource(
  stateDir: string,
): Promise<LegacyConversationMigrationSource | null> {
  const filePath = path.join(stateDir, MSTEAMS_CONVERSATIONS_LEGACY_FILENAME);
  const activeState = await readLegacyConversationStore(filePath);
  if (activeState) {
    return { filePath, state: activeState, archived: false };
  }
  // Broken shipped migrations may have archived the only recoverable source before
  // canonical rows were visible. Doctor may reread that snapshot, but never removes it.
  const archivedPath = `${filePath}.migrated`;
  const archivedState = await readLegacyConversationStore(archivedPath);
  return archivedState ? { filePath: archivedPath, state: archivedState, archived: true } : null;
}
