// Accessor-backed transcript corpus discovery for memory session indexing.
import fsSync from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import {
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionsDir,
  canonicalizeMainSessionAlias,
  getRuntimeConfig,
  isCronRunSessionKey,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionEntries,
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptContentRevisionSync,
  resolveSessionAgentId,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
  type SessionEntry,
  type SessionTranscriptInstance,
} from "./openclaw-runtime-session.js";
import type { MemorySessionKind } from "./types.js";

type SessionTranscriptCorpusArtifactKind =
  | "active-session"
  | "retained-session"
  | "archive-artifact";

export type SessionTranscriptCorpusOptions = {
  /** Include rotated SQLite transcript identities retained behind current logical sessions. */
  includeRetainedSqlite?: boolean;
  /** Skip per-transcript revision reads when a caller only needs discovery metadata. */
  includeContentRevision?: boolean;
  /** Read session entries without joining the agent database writable lifecycle. */
  readOnly?: boolean;
};

export type SessionTranscriptCorpusEntry = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  /** Canonical source revision used by derived transcript consumers. */
  contentRevision?: string;
  artifactKind: SessionTranscriptCorpusArtifactKind;
  sessionKey?: string;
  storePath?: string;
  /** Present when an active transcript is addressed by SQLite identity, not a JSONL path. */
  transcriptSource?: "sqlite";
  /** Session entry activity timestamp used when the source has no filesystem stat. */
  updatedAtMs?: number;
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
};

function fileContentRevision(filePath: string): string | undefined {
  try {
    const stat = fsSync.statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return undefined;
    }
    return `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return undefined;
  }
}

function sqliteContentRevision(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
}): string | undefined {
  try {
    return readTranscriptContentRevisionSync(params);
  } catch {
    return undefined;
  }
}

type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

function isDreamingNarrativeSessionKeyLike(value: unknown): boolean {
  return typeof value === "string" && isDreamingNarrativeSessionStoreKey(value);
}

function normalizeComparablePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeRealComparablePath(pathname: string): string {
  try {
    return normalizeComparablePath(fsSync.realpathSync(pathname));
  } catch {
    try {
      return normalizeComparablePath(
        path.join(fsSync.realpathSync(path.dirname(pathname)), path.basename(pathname)),
      );
    } catch {
      return normalizeComparablePath(pathname);
    }
  }
}

function rememberArtifactDir(dirs: Map<string, string>, dir: string): void {
  dirs.set(normalizeRealComparablePath(dir), dir);
}

function classifySessionEntry(
  sessionKey: string,
  entry: SessionEntry,
  cronGeneratedSessionKeys: ReadonlySet<string>,
): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
  sessionKind: MemorySessionKind;
} {
  const generatedByDreamingNarrative =
    isDreamingNarrativeSessionStoreKey(sessionKey) ||
    isDreamingNarrativeSessionKeyLike(entry.spawnedBy);
  const generatedByCronRun = cronGeneratedSessionKeys.has(sessionKey);
  return {
    generatedByDreamingNarrative,
    generatedByCronRun,
    sessionKind: generatedByCronRun
      ? "cron"
      : typeof entry.heartbeatIsolatedBaseSessionKey === "string" &&
          entry.heartbeatIsolatedBaseSessionKey.trim()
        ? "heartbeat"
        : generatedByDreamingNarrative || Boolean(entry.spawnedBy)
          ? "subagent"
          : sessionKey.includes(":subagent:")
            ? "subagent"
            : "interactive",
  };
}

function readParentSessionKeys(entry: SessionEntry | undefined): string[] {
  const keys = new Set<string>();
  for (const value of [entry?.parentSessionKey, entry?.spawnedBy]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  }
  return [...keys];
}

function collectCronGeneratedSessionKeys(
  summaries: readonly SessionEntrySummary[],
): ReadonlySet<string> {
  // Build the cron-generated closure once so active entries and archive
  // artifacts share the same lineage classification.
  const entriesByKey = new Map(summaries.map((summary) => [summary.sessionKey, summary.entry]));
  const cronGeneratedKeys = new Set<string>();
  const cache = new Map<string, boolean>();
  const resolving = new Set<string>();

  const isCronGenerated = (sessionKey: string, entry: SessionEntry | undefined): boolean => {
    if (isCronRunSessionKey(sessionKey)) {
      cache.set(sessionKey, true);
      cronGeneratedKeys.add(sessionKey);
      return true;
    }
    const cached = cache.get(sessionKey);
    if (cached !== undefined) {
      return cached;
    }
    if (resolving.has(sessionKey)) {
      return false;
    }

    resolving.add(sessionKey);
    const generated = readParentSessionKeys(entry).some(
      (parentKey) =>
        // Parent rows can be pruned before child rows; a cron-shaped parent key
        // still carries cron lineage without requiring a store entry.
        isCronRunSessionKey(parentKey) || isCronGenerated(parentKey, entriesByKey.get(parentKey)),
    );
    resolving.delete(sessionKey);
    cache.set(sessionKey, generated);
    if (generated) {
      cronGeneratedKeys.add(sessionKey);
    }
    return generated;
  };

  for (const summary of summaries) {
    isCronGenerated(summary.sessionKey, summary.entry);
  }
  return cronGeneratedKeys;
}

function toSessionStoreCorpusEntry(
  agentId: string,
  storePath: string,
  summary: SessionEntrySummary,
  cronGeneratedSessionKeys: ReadonlySet<string>,
  includeContentRevision: boolean,
): SessionTranscriptCorpusEntry | null {
  const sessionId = summary.entry.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  const sessionKey = summary.sessionKey.trim();
  const classification = classifySessionEntry(
    summary.sessionKey,
    summary.entry,
    cronGeneratedSessionKeys,
  );
  const contentRevision = includeContentRevision
    ? sqliteContentRevision({
        agentId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        storePath,
      })
    : undefined;
  return {
    agentId,
    artifactKind: "active-session",
    sessionFile: sessionKey,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    transcriptSource: "sqlite",
    storePath,
    ...(Number.isFinite(summary.entry.updatedAt) ? { updatedAtMs: summary.entry.updatedAt } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: classification.sessionKind,
  };
}

function toRetainedSessionCorpusEntry(
  agentId: string,
  instance: SessionTranscriptInstance,
  sessionKey: string,
  storePath: string,
  cronGeneratedSessionKeys: ReadonlySet<string>,
  includeContentRevision: boolean,
): SessionTranscriptCorpusEntry | null {
  // Retained rows predate the current logical session entry. Only rows whose
  // exclusion-sensitive ownership was captured may enter historical ingestion.
  if (
    !instance.provenanceKnown ||
    instance.acpOwned ||
    instance.entry.pluginOwnerId ||
    instance.entry.hookExternalContentSource
  ) {
    return null;
  }
  const classification = classifySessionEntry(sessionKey, instance.entry, cronGeneratedSessionKeys);
  const contentRevision = includeContentRevision
    ? sqliteContentRevision({
        agentId,
        sessionId: instance.sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        storePath,
      })
    : undefined;
  return {
    agentId,
    artifactKind: "retained-session",
    sessionFile: sessionKey,
    sessionId: instance.sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    storePath,
    transcriptSource: "sqlite",
    updatedAtMs: instance.updatedAtMs,
    ...(sessionKey ? { sessionKey } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: classification.sessionKind,
  };
}

function listSessionTranscriptArtifactFiles(sessionsDir: string): string[] {
  try {
    return fsSync
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => isUsageCountedSessionTranscriptFileName(name))
      .filter((name) => isSessionArchiveArtifactName(name))
      .map((name) => path.join(sessionsDir, name));
  } catch (err) {
    // A missing artifact directory is authoritatively empty. Other failures
    // make the corpus incomplete, so destructive consumers must not proceed.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function toArtifactCorpusEntry(
  agentId: string,
  artifactPath: string,
  sessionId: string,
  primaryEntry?: SessionTranscriptCorpusEntry,
  includeContentRevision = true,
): SessionTranscriptCorpusEntry {
  const contentRevision = includeContentRevision ? fileContentRevision(artifactPath) : undefined;
  return {
    agentId,
    artifactKind: "archive-artifact",
    sessionFile: artifactPath,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    ...(primaryEntry?.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(primaryEntry?.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: primaryEntry?.sessionKind ?? "unknown",
  };
}

export function listSessionTranscriptCorpusEntriesForAgentSync(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): SessionTranscriptCorpusEntry[] {
  const includeContentRevision = options.includeContentRevision !== false;
  const normalizedAgentId = normalizeAgentId(agentId);
  const cfg = getRuntimeConfig();
  const configuredStore = cfg.session?.store;
  const storePath = resolveStorePath(configuredStore, {
    agentId: normalizedAgentId,
  });
  const sessionsDir = path.dirname(storePath);
  const fixedStoreOwnerAgentId = extractAgentIdFromSessionsDir(sessionsDir);
  const isAgentOwnedFixedStore =
    fixedStoreOwnerAgentId !== null &&
    normalizeAgentId(fixedStoreOwnerAgentId) === normalizedAgentId;
  const isSharedFixedStore =
    typeof configuredStore === "string" &&
    configuredStore.trim().length > 0 &&
    !configuredStore.includes("{agentId}") &&
    !isAgentOwnedFixedStore;
  const activeEntriesBySessionId = new Map<string, SessionTranscriptCorpusEntry>();
  const entryOwnersBySessionId = new Map<string, string>();
  const artifactDirsByPath = new Map<string, string>();
  rememberArtifactDir(artifactDirsByPath, sessionsDir);
  rememberArtifactDir(artifactDirsByPath, resolveSessionTranscriptsDirForAgent(normalizedAgentId));
  const sessionEntries = listSessionEntries({
    agentId: normalizedAgentId,
    hydrateSkillPromptRefs: false,
    readOnly: options.readOnly === true,
    storePath,
  });
  const retainedInstances = options.includeRetainedSqlite
    ? listSessionTranscriptInstances({
        agentId: normalizedAgentId,
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        storePath,
      })
    : [];
  const artifactPaths: string[] = [];
  const scannedArtifactPaths = new Set<string>();
  for (const artifactDir of artifactDirsByPath.values()) {
    for (const artifactPath of listSessionTranscriptArtifactFiles(artifactDir)) {
      const normalizedArtifactPath = normalizeRealComparablePath(artifactPath);
      if (!scannedArtifactPaths.has(normalizedArtifactPath)) {
        scannedArtifactPaths.add(normalizedArtifactPath);
        artifactPaths.push(artifactPath);
      }
    }
  }
  const archivedIdentitiesByName = new Map(
    listSessionTranscriptArchivesReadOnly({
      agentId: normalizedAgentId,
      archiveNames: artifactPaths.map((artifactPath) => path.basename(artifactPath)),
      storePath,
    }).map((archive) => [archive.archiveName, archive]),
  );
  const cronGeneratedSessionKeys = collectCronGeneratedSessionKeys([
    ...retainedInstances.map(({ entry, sessionKey }) => ({ entry, sessionKey })),
    ...sessionEntries,
  ]);
  for (const summary of sessionEntries) {
    const sessionKey = isSharedFixedStore
      ? summary.sessionKey
      : canonicalizeMainSessionAlias({
          cfg,
          agentId: normalizedAgentId,
          sessionKey: summary.sessionKey,
        });
    const ownerAgentId = resolveSessionAgentId({
      config: cfg,
      sessionKey,
      ...(isSharedFixedStore ? {} : { fallbackAgentId: normalizedAgentId }),
    });
    const entry = toSessionStoreCorpusEntry(
      ownerAgentId,
      storePath,
      summary,
      cronGeneratedSessionKeys,
      includeContentRevision,
    );
    if (!entry) {
      continue;
    }
    entryOwnersBySessionId.set(entry.sessionId, ownerAgentId);
    if (ownerAgentId === normalizedAgentId) {
      activeEntriesBySessionId.set(entry.sessionId, entry);
    }
  }
  const includeUnownedArtifacts = !isSharedFixedStore;
  const corpusEntries = [...activeEntriesBySessionId.values()];
  if (options.includeRetainedSqlite) {
    for (const instance of retainedInstances) {
      if (activeEntriesBySessionId.has(instance.sessionId)) {
        continue;
      }
      const sessionKey = isSharedFixedStore
        ? instance.sessionKey
        : canonicalizeMainSessionAlias({
            cfg,
            agentId: normalizedAgentId,
            sessionKey: instance.sessionKey,
          });
      const ownerAgentId = resolveSessionAgentId({
        config: cfg,
        sessionKey,
        ...(isSharedFixedStore ? {} : { fallbackAgentId: normalizedAgentId }),
      });
      if (ownerAgentId !== normalizedAgentId) {
        continue;
      }
      const entry = toRetainedSessionCorpusEntry(
        ownerAgentId,
        instance,
        sessionKey,
        storePath,
        cronGeneratedSessionKeys,
        includeContentRevision,
      );
      if (entry?.transcriptSource === "sqlite") {
        corpusEntries.push(entry);
      }
    }
  }
  for (const artifactPath of artifactPaths) {
    const artifactName = path.basename(artifactPath);
    const archivedIdentity = archivedIdentitiesByName.get(artifactName);
    const primarySessionId =
      archivedIdentity?.sessionId ?? parseUsageCountedSessionIdFromFileName(artifactName);
    if (!primarySessionId) {
      continue;
    }
    const primaryEntry = activeEntriesBySessionId.get(primarySessionId);
    const primaryOwner = entryOwnersBySessionId.get(primarySessionId);
    if (primaryOwner && primaryOwner !== normalizedAgentId) {
      continue;
    }
    if (!primaryOwner && !archivedIdentity && !includeUnownedArtifacts) {
      continue;
    }
    corpusEntries.push({
      ...toArtifactCorpusEntry(
        normalizedAgentId,
        artifactPath,
        primarySessionId,
        primaryEntry,
        includeContentRevision,
      ),
      ...(archivedIdentity?.sessionKey ? { sessionKey: archivedIdentity.sessionKey } : {}),
      ...(archivedIdentity ? { storePath } : {}),
    });
  }
  return corpusEntries;
}

/**
 * Lists transcript corpus entries for memory indexing.
 *
 * Active sessions come from the session accessor seam; retained reset/delete
 * transcript artifacts remain explicit file artifacts until core owns archive
 * artifact enumeration.
 */
export async function listSessionTranscriptCorpusEntriesForAgent(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): Promise<SessionTranscriptCorpusEntry[]> {
  return listSessionTranscriptCorpusEntriesForAgentSync(agentId, options);
}
