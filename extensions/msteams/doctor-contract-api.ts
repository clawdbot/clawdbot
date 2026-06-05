// Msteams API module exposes the plugin public contract.
import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStoredConversationId } from "./src/conversation-store-helpers.js";
import {
  buildMSTeamsConversationStateKey,
  MSTEAMS_CONVERSATIONS_LEGACY_FILENAME,
  MSTEAMS_CONVERSATIONS_NAMESPACE,
  MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
  normalizeMSTeamsLegacyConversationStore,
  prepareMSTeamsConversationReferenceForStorage,
  selectRetainedMSTeamsConversations,
  type MSTeamsLegacyConversationStoreData,
} from "./src/conversation-store-state.js";
import type { StoredConversationReference } from "./src/conversation-store.js";
import {
  buildMSTeamsPollStateKey,
  buildMSTeamsPollVoteBucketKey,
  MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS,
  MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
  MSTEAMS_POLLS_LEGACY_FILENAME,
  MSTEAMS_POLLS_NAMESPACE,
  MSTEAMS_SQLITE_MAX_POLL_ROWS,
  selectMSTeamsPollVoteBucket,
  selectRetainedMSTeamsPolls,
  splitMSTeamsPoll,
  type MSTeamsPoll,
  type MSTeamsPollStoreData,
  type StoredMSTeamsPoll,
  type StoredMSTeamsPollVoteBucket,
} from "./src/polls.js";
import {
  isMSTeamsSsoStoreData,
  makeMSTeamsSsoTokenStoreKey,
  MSTEAMS_MAX_SSO_TOKENS,
  MSTEAMS_SSO_TOKENS_LEGACY_FILENAME,
  MSTEAMS_SSO_TOKENS_NAMESPACE,
  normalizeMSTeamsSsoStoredToken,
  type MSTeamsSsoStoredToken,
} from "./src/sso-token-store.js";

type FeedbackLearningEntry = {
  sessionKey: string;
  learnings: string[];
  updatedAt: number;
};

const LEARNINGS_NAMESPACE = "feedback-learnings";
const MAX_LEARNING_ENTRIES = 10_000;
const MSTEAMS_PLUGIN_ID = "Microsoft Teams";

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function learningStoreKey(storePath: string, sessionKey: string): string {
  return crypto.createHash("sha256").update(`${storePath}\0${sessionKey}`, "utf8").digest("hex");
}

function decodeSessionKey(fileStem: string): string | null {
  try {
    const decoded = Buffer.from(fileStem, "base64url").toString("utf8");
    return encodeSessionKey(decoded) === fileStem && decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function resolveLearningSessionKey(fileStem: string): string | null {
  return decodeSessionKey(fileStem);
}

function legacySanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function listKnownSessionKeys(storePath: string): Promise<string[]> {
  const candidates = [storePath, path.join(storePath, "sessions.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const sessions =
        (parsed as { sessions?: unknown }).sessions &&
        typeof (parsed as { sessions?: unknown }).sessions === "object" &&
        !Array.isArray((parsed as { sessions?: unknown }).sessions)
          ? (parsed as { sessions: Record<string, unknown> }).sessions
          : (parsed as Record<string, unknown>);
      return Object.keys(sessions).filter((key) => key.trim());
    } catch {
      // Try the next known session index shape/location.
    }
  }
  return [];
}

function resolveLegacySanitizedSessionKey(
  fileStem: string,
  knownSessionKeys: string[],
): string | null {
  const matches = knownSessionKeys.filter(
    (sessionKey) => legacySanitizeSessionKey(sessionKey) === fileStem,
  );
  return matches.length === 1 ? matches[0] : null;
}

function listAgentIds(config: { agents?: { list?: Array<{ id?: unknown }> } }): string[] {
  const ids = new Set<string>(["main"]);
  for (const agent of config.agents?.list ?? []) {
    if (typeof agent.id === "string" && agent.id.trim()) {
      ids.add(agent.id.trim());
    }
  }
  return [...ids];
}

function listCandidateStorePaths(params: {
  config: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0]["config"];
  env: NodeJS.ProcessEnv;
}): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(params.config.session?.store, { env: params.env }));
  for (const agentId of listAgentIds(params.config)) {
    paths.add(resolveStorePath(params.config.session?.store, { agentId, env: params.env }));
  }
  return [...paths];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveStateFilePath(stateDir: string, filename: string): string {
  return path.join(stateDir, filename);
}

async function readLegacyJsonFile<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  try {
    return parse(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseLegacyConversationStore(value: unknown): MSTeamsLegacyConversationStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.conversations)) {
    return null;
  }
  return normalizeMSTeamsLegacyConversationStore({
    version: 1,
    conversations: value.conversations as Record<string, StoredConversationReference>,
  });
}

function parseLegacyPoll(value: unknown): MSTeamsPoll | null {
  if (!isRecord(value)) {
    return null;
  }
  const votes = isRecord(value.votes) ? value.votes : null;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.question !== "string" ||
    !value.question ||
    !isStringArray(value.options) ||
    typeof value.maxSelections !== "number" ||
    !Number.isFinite(value.maxSelections) ||
    typeof value.createdAt !== "string" ||
    !votes
  ) {
    return null;
  }
  const normalizedVotes: Record<string, string[]> = {};
  for (const [voterId, selections] of Object.entries(votes)) {
    if (typeof voterId === "string" && isStringArray(selections)) {
      normalizedVotes[voterId] = selections;
    }
  }
  return {
    id: value.id,
    question: value.question,
    options: value.options,
    maxSelections: value.maxSelections,
    createdAt: value.createdAt,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    votes: normalizedVotes,
  };
}

function parseLegacyPollStore(value: unknown): MSTeamsPollStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.polls)) {
    return null;
  }
  const polls: Record<string, MSTeamsPoll> = {};
  for (const [pollId, poll] of Object.entries(value.polls)) {
    const parsed = parseLegacyPoll(poll);
    if (parsed) {
      polls[pollId] = parsed;
    }
  }
  return { version: 1, polls };
}

async function listLegacyLearningFiles(
  storePath: string,
): Promise<
  Array<{ storePath: string; sessionKey: string | null; filePath: string; learnings: string[] }>
> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(storePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const suffix = ".learnings.json";
  const knownSessionKeys = await listKnownSessionKeys(storePath);
  const files: Array<{
    storePath: string;
    sessionKey: string | null;
    filePath: string;
    learnings: string[];
  }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) {
      continue;
    }
    const fileStem = entry.name.slice(0, -suffix.length);
    const sessionKey =
      resolveLearningSessionKey(fileStem) ??
      resolveLegacySanitizedSessionKey(fileStem, knownSessionKeys);
    const filePath = path.join(storePath, entry.name);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        const learnings = parsed.filter((item): item is string => typeof item === "string");
        if (learnings.length > 0) {
          files.push({ storePath, sessionKey, filePath, learnings: learnings.slice(-10) });
        }
      }
    } catch {
      // Malformed legacy feedback notes are ignored by migration.
    }
  }
  return files;
}

async function archiveLegacySource(params: {
  filePath: string;
  label?: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  const label = params.label ?? "Microsoft Teams feedback-learning";
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated ${label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${label} legacy source: ${String(err)}`);
  }
}

function mergeLearnings(legacy: string[], existing?: FeedbackLearningEntry): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const learning of [...legacy, ...(existing?.learnings ?? [])]) {
    if (seen.has(learning)) {
      continue;
    }
    seen.add(learning);
    merged.push(learning);
  }
  return merged.slice(-10);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "msteams-conversations-json-to-plugin-state",
    label: "Microsoft Teams conversations",
    async detectLegacyState(params) {
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_CONVERSATIONS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, parseLegacyConversationStore);
      if (!state || Object.keys(state.conversations).length === 0) {
        return null;
      }
      return {
        preview: [
          `- ${MSTEAMS_PLUGIN_ID} conversations: ${Object.keys(state.conversations).length} entries -> plugin state (${MSTEAMS_CONVERSATIONS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_CONVERSATIONS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, parseLegacyConversationStore);
      if (!state) {
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<StoredConversationReference>({
        namespace: MSTEAMS_CONVERSATIONS_NAMESPACE,
        maxEntries: MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
      });
      let imported = 0;
      for (const [rawConversationId, reference] of selectRetainedMSTeamsConversations(
        state.conversations,
      )) {
        const conversationId = normalizeStoredConversationId(rawConversationId);
        if (!conversationId) {
          continue;
        }
        const didImport = await store.registerIfAbsent(
          buildMSTeamsConversationStateKey(conversationId),
          prepareMSTeamsConversationReferenceForStorage(conversationId, reference),
        );
        if (didImport) {
          imported++;
        }
      }
      changes.push(
        `Migrated ${imported} ${MSTEAMS_PLUGIN_ID} conversation ${imported === 1 ? "entry" : "entries"} -> plugin state`,
      );
      await archiveLegacySource({
        filePath,
        label: `${MSTEAMS_PLUGIN_ID} conversation`,
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
  {
    id: "msteams-polls-json-to-plugin-state",
    label: "Microsoft Teams polls",
    async detectLegacyState(params) {
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_POLLS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, parseLegacyPollStore);
      if (!state || Object.keys(state.polls).length === 0) {
        return null;
      }
      return {
        preview: [
          `- ${MSTEAMS_PLUGIN_ID} polls: ${Object.keys(state.polls).length} entries -> plugin state (${MSTEAMS_POLLS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_POLLS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, parseLegacyPollStore);
      if (!state) {
        return { changes, warnings };
      }
      const pollStore = params.context.openPluginStateKeyedStore<StoredMSTeamsPoll>({
        namespace: MSTEAMS_POLLS_NAMESPACE,
        maxEntries: MSTEAMS_SQLITE_MAX_POLL_ROWS,
      });
      const voteBucketStore = params.context.openPluginStateKeyedStore<StoredMSTeamsPollVoteBucket>(
        {
          namespace: MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
          maxEntries: MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS,
        },
      );
      let imported = 0;
      for (const [pollId, poll] of selectRetainedMSTeamsPolls(state.polls)) {
        const { metadata, votes } = splitMSTeamsPoll(poll);
        const didImportPoll = await pollStore.registerIfAbsent(
          buildMSTeamsPollStateKey(pollId),
          metadata,
        );
        const buckets = new Map<string, Record<string, string[]>>();
        for (const [voterId, selections] of Object.entries(votes)) {
          const bucket = selectMSTeamsPollVoteBucket(pollId, voterId);
          const bucketVotes = buckets.get(bucket) ?? {};
          bucketVotes[voterId] = selections;
          buckets.set(bucket, bucketVotes);
        }
        let importedVoteBucket = false;
        for (const [bucket, bucketVotes] of buckets) {
          const key = buildMSTeamsPollVoteBucketKey(pollId, bucket);
          const existing = await voteBucketStore.lookup(key);
          await voteBucketStore.register(key, {
            pollId,
            bucket,
            votes: { ...bucketVotes, ...existing?.votes },
            updatedAt: poll.updatedAt ?? poll.createdAt,
          });
          importedVoteBucket = true;
        }
        if (didImportPoll || importedVoteBucket) {
          imported++;
        }
      }
      changes.push(
        `Migrated ${imported} ${MSTEAMS_PLUGIN_ID} poll ${imported === 1 ? "entry" : "entries"} -> plugin state`,
      );
      await archiveLegacySource({
        filePath,
        label: `${MSTEAMS_PLUGIN_ID} poll`,
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
  {
    id: "msteams-sso-tokens-json-to-plugin-state",
    label: "Microsoft Teams SSO tokens",
    async detectLegacyState(params) {
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_SSO_TOKENS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, (value) =>
        isMSTeamsSsoStoreData(value) ? value : null,
      );
      if (!state || Object.keys(state.tokens).length === 0) {
        return null;
      }
      return {
        preview: [
          `- ${MSTEAMS_PLUGIN_ID} SSO tokens: ${Object.keys(state.tokens).length} entries -> plugin state (${MSTEAMS_SSO_TOKENS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveStateFilePath(params.stateDir, MSTEAMS_SSO_TOKENS_LEGACY_FILENAME);
      const state = await readLegacyJsonFile(filePath, (value) =>
        isMSTeamsSsoStoreData(value) ? value : null,
      );
      if (!state) {
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<MSTeamsSsoStoredToken>({
        namespace: MSTEAMS_SSO_TOKENS_NAMESPACE,
        maxEntries: MSTEAMS_MAX_SSO_TOKENS,
      });
      let imported = 0;
      let skipped = 0;
      for (const token of Object.values(state.tokens)) {
        const normalized = normalizeMSTeamsSsoStoredToken(token);
        if (!normalized) {
          skipped++;
          continue;
        }
        const didImport = await store.registerIfAbsent(
          makeMSTeamsSsoTokenStoreKey(normalized.connectionName, normalized.userId),
          normalized,
        );
        if (didImport) {
          imported++;
        }
      }
      changes.push(
        `Migrated ${imported} ${MSTEAMS_PLUGIN_ID} SSO token ${imported === 1 ? "entry" : "entries"} -> plugin state`,
      );
      if (skipped > 0) {
        warnings.push(
          `Skipped ${skipped} malformed ${MSTEAMS_PLUGIN_ID} SSO token ${skipped === 1 ? "entry" : "entries"} during migration`,
        );
      }
      await archiveLegacySource({
        filePath,
        label: `${MSTEAMS_PLUGIN_ID} SSO-token`,
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
  {
    id: "msteams-feedback-learnings-json-to-plugin-state",
    label: "Microsoft Teams feedback learnings",
    async detectLegacyState(params) {
      const files = (
        await Promise.all(
          listCandidateStorePaths(params).map((storePath) => listLegacyLearningFiles(storePath)),
        )
      ).flat();
      if (files.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Microsoft Teams feedback learnings: ${files.length} ${files.length === 1 ? "file" : "files"} -> plugin state (${LEARNINGS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const files = (
        await Promise.all(
          listCandidateStorePaths(params).map((storePath) => listLegacyLearningFiles(storePath)),
        )
      ).flat();
      const store = params.context.openPluginStateKeyedStore<FeedbackLearningEntry>({
        namespace: LEARNINGS_NAMESPACE,
        maxEntries: MAX_LEARNING_ENTRIES,
      });
      const existingEntries = await store.entries();
      const existingKeys = new Set(existingEntries.map((entry) => entry.key));
      const importableFiles = files.filter((file) => file.sessionKey);
      const missingKeys = new Set(
        importableFiles
          .map((file) => learningStoreKey(file.storePath, file.sessionKey ?? ""))
          .filter((key) => !existingKeys.has(key)),
      );
      if (missingKeys.size > MAX_LEARNING_ENTRIES - existingKeys.size) {
        warnings.push(
          `Skipped Microsoft Teams feedback-learning migration because plugin state has room for ${MAX_LEARNING_ENTRIES - existingKeys.size} of ${missingKeys.size} missing entries; left legacy sources in place`,
        );
        return { changes, warnings };
      }
      let imported = 0;
      for (const file of files) {
        if (!file.sessionKey) {
          warnings.push(
            `Left Microsoft Teams feedback-learning source in place because its legacy filename cannot be mapped to a session key: ${file.filePath}`,
          );
          continue;
        }
        const key = learningStoreKey(file.storePath, file.sessionKey);
        const existing = await store.lookup(key);
        await store.register(key, {
          sessionKey: existing?.sessionKey ?? file.sessionKey,
          learnings: mergeLearnings(file.learnings, existing),
          updatedAt: Date.now(),
        });
        imported++;
        await archiveLegacySource({ filePath: file.filePath, changes, warnings });
      }
      if (imported > 0) {
        changes.unshift(
          `Migrated ${imported} Microsoft Teams feedback-learning ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      return { changes, warnings };
    },
  },
];
