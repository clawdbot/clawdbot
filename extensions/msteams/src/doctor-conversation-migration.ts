import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeStoredConversationId } from "./conversation-store-helpers.js";
import {
  MSTEAMS_CONVERSATIONS_LEGACY_FILENAME,
  normalizeMSTeamsLegacyConversationStore,
  type MSTeamsLegacyConversationStoreData,
} from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";

type LegacyConversationMigrationSource = {
  filePath: string;
  archivePaths: string[];
  state: MSTeamsLegacyConversationStoreData;
  archived: boolean;
};

type ArchivedConversationStore = {
  filePath: string;
  generation: bigint;
  state: MSTeamsLegacyConversationStoreData;
};

function isUsableStoredConversationReference(value: unknown): value is StoredConversationReference {
  if (!isRecord(value) || typeof value.serviceUrl !== "string" || !value.serviceUrl.trim()) {
    return false;
  }
  const agent = isRecord(value.agent) ? value.agent : null;
  const bot = isRecord(value.bot) ? value.bot : null;
  const user = isRecord(value.user) ? value.user : null;
  // Proactive sends require a Connector endpoint plus user and bot identities. Drop
  // unusable archive rows before retention so they cannot crowd out valid references.
  return (
    typeof user?.id === "string" &&
    Boolean(user.id.trim()) &&
    ((typeof agent?.id === "string" && Boolean(agent.id.trim())) ||
      (typeof bot?.id === "string" && Boolean(bot.id.trim())))
  );
}

function parseLegacyConversationStore(value: unknown): MSTeamsLegacyConversationStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.conversations)) {
    return null;
  }
  const conversations = Object.fromEntries(
    Object.entries(value.conversations).filter(
      (entry): entry is [string, StoredConversationReference] => isRecord(entry[1]),
    ),
  );
  return normalizeMSTeamsLegacyConversationStore({
    version: 1,
    conversations,
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

function parseArchiveGeneration(filename: string): bigint | null {
  const prefix = `${MSTEAMS_CONVERSATIONS_LEGACY_FILENAME}.migrated`;
  if (filename === prefix) {
    return 1n;
  }
  if (!filename.startsWith(`${prefix}.`)) {
    return null;
  }
  const suffix = filename.slice(prefix.length + 1);
  if (!/^[1-9][0-9]*$/u.test(suffix)) {
    return null;
  }
  const generation = BigInt(suffix);
  return generation >= 2n ? generation : null;
}

async function readArchivedConversationStores(
  stateDir: string,
): Promise<ArchivedConversationStore[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(stateDir);
  } catch {
    return [];
  }
  const candidates = filenames.flatMap((filename) => {
    const generation = parseArchiveGeneration(filename);
    return generation == null ? [] : [{ filePath: path.join(stateDir, filename), generation }];
  });
  const stores = await Promise.all(
    candidates.map(async ({ filePath, generation }) => {
      const state = await readLegacyConversationStore(filePath);
      return state ? { filePath, generation, state } : null;
    }),
  );
  return stores
    .filter((entry): entry is ArchivedConversationStore => entry !== null)
    .toSorted((a, b) => (a.generation < b.generation ? 1 : a.generation > b.generation ? -1 : 0));
}

export function resolveLegacyConversationId(
  rawConversationId: string,
  reference: StoredConversationReference,
): string {
  const storedConversationId = reference.conversation?.id
    ? normalizeStoredConversationId(reference.conversation.id)
    : "";
  return storedConversationId || normalizeStoredConversationId(rawConversationId);
}

export async function resolveLegacyConversationMigrationSource(
  stateDir: string,
): Promise<LegacyConversationMigrationSource | null> {
  const filePath = path.join(stateDir, MSTEAMS_CONVERSATIONS_LEGACY_FILENAME);
  const activeState = await readLegacyConversationStore(filePath);
  if (activeState) {
    return { filePath, archivePaths: [], state: activeState, archived: false };
  }
  // Broken shipped migrations may have archived the only recoverable source before
  // canonical rows were visible. Newer rotated snapshots win, and Doctor keeps all archives.
  const archivedStores = await readArchivedConversationStores(stateDir);
  const [newest] = archivedStores;
  if (!newest) {
    return null;
  }
  const conversations: Record<string, StoredConversationReference> = {};
  for (const archivedStore of archivedStores) {
    for (const [rawConversationId, reference] of Object.entries(
      archivedStore.state.conversations,
    )) {
      if (!isUsableStoredConversationReference(reference)) {
        continue;
      }
      const conversationId = resolveLegacyConversationId(rawConversationId, reference);
      if (conversationId) {
        // Archives are newest-first. Collapse aliases at the canonical key before
        // retention so an older reference cannot win later via raw-key ordering.
        conversations[conversationId] ??= reference;
      }
    }
  }
  return {
    filePath: newest.filePath,
    archivePaths: archivedStores.map((entry) => entry.filePath),
    state: { version: 1, conversations },
    archived: true,
  };
}
