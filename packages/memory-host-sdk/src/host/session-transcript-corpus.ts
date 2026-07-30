// Accessor-backed transcript corpus discovery for memory/QMD session indexing.
import fsSync from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import {
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionPath,
  extractAgentIdFromSessionsDir,
  canonicalizeMainSessionAlias,
  getRuntimeConfig,
  isCronRunSessionKey,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionEntries,
  listSessionTranscriptInstances,
  parseSqliteSessionFileMarker,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptContentRevisionSync,
  resolveSessionAgentId,
  resolveSessionFilePath,
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

type ResolvedSessionStoreCorpusSource = {
  sessionFile: string;
  sessionId: string;
  transcriptSource: "sqlite" | "file";
};

function resolveSessionStoreTranscriptCorpusSource(
  agentId: string,
  sessionKey: string,
  sessionsDir: string,
  storePath: string,
  entry: { sessionFile?: unknown; sessionId?: unknown } | undefined,
): ResolvedSessionStoreCorpusSource | null {
  const sessionFile =
    typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0
      ? entry.sessionFile.trim()
      : undefined;
  const sqliteMarker = sessionFile ? parseSqliteSessionFileMarker(sessionFile) : undefined;
  const explicitSessionId =
    typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0
      ? entry.sessionId.trim()
      : null;
  const sessionId =
    explicitSessionId ??
    sqliteMarker?.sessionId ??
    (sessionFile ? parseUsageCountedSessionIdFromFileName(path.basename(sessionFile)) : null);
  if (!sessionId) {
    return null;
  }
  if (!sessionFile) {
    return {
      sessionFile: sessionKey,
      sessionId,
      transcriptSource: "sqlite",
    };
  }
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== sessionId ||
      normalizeAgentId(sqliteMarker.agentId) !== normalizeAgentId(agentId) ||
      normalizeComparablePath(sqliteMarker.storePath) !== normalizeComparablePath(storePath)
    ) {
      return null;
    }
    return {
      sessionFile,
      sessionId,
      transcriptSource: "sqlite",
    };
  }
  try {
    if (!sessionFile) {
      return {
        sessionFile: resolveSessionFilePath(sessionId, undefined, { agentId, sessionsDir }),
        sessionId,
        transcriptSource: "file",
      };
    }
    const resolved = resolveSessionFilePath(
      sessionId,
      { sessionFile },
      {
        agentId,
        sessionsDir,
      },
    );
    if (!path.isAbsolute(sessionFile)) {
      const candidate = path.resolve(sessionsDir, sessionFile);
      if (
        normalizeComparablePath(path.dirname(candidate)) !== normalizeComparablePath(sessionsDir)
      ) {
        return null;
      }
      return normalizeRealComparablePath(resolved) === normalizeRealComparablePath(candidate)
        ? { sessionFile: candidate, sessionId, transcriptSource: "file" }
        : null;
    }
    const pathAgentId = extractAgentIdFromSessionPath(sessionFile);
    if (pathAgentId && normalizeAgentId(pathAgentId) !== normalizeAgentId(agentId)) {
      return null;
    }
    return normalizeRealComparablePath(resolved) === normalizeRealComparablePath(sessionFile)
      ? { sessionFile, sessionId, transcriptSource: "file" }
      : null;
  } catch {
    return null;
  }
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
  sessionsDir: string,
  storePath: string,
  summary: SessionEntrySummary,
  cronGeneratedSessionKeys: ReadonlySet<string>,
): SessionTranscriptCorpusEntry | null {
  const source = resolveSessionStoreTranscriptCorpusSource(
    agentId,
    summary.sessionKey,
    sessionsDir,
    storePath,
    summary.entry,
  );
  if (!source) {
    return null;
  }
  if (
    source.transcriptSource === "file" &&
    !isUsageCountedSessionTranscriptFileName(path.basename(source.sessionFile))
  ) {
    return null;
  }
  const sessionKey = summary.sessionKey.trim();
  const classification = classifySessionEntry(
    summary.sessionKey,
    summary.entry,
    cronGeneratedSessionKeys,
  );
  const contentRevision =
    source.transcriptSource === "sqlite"
      ? sqliteContentRevision({
          agentId,
          sessionId: source.sessionId,
          ...(sessionKey ? { sessionKey } : {}),
          storePath,
        })
      : fileContentRevision(source.sessionFile);
  return {
    agentId,
    artifactKind: "active-session",
    sessionFile: source.sessionFile,
    sessionId: source.sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    ...(source.transcriptSource === "sqlite" ? { transcriptSource: "sqlite" as const } : {}),
    ...(source.transcriptSource === "sqlite" ? { storePath } : {}),
    ...(source.transcriptSource === "sqlite" && Number.isFinite(summary.entry.updatedAt)
      ? { updatedAtMs: summary.entry.updatedAt }
      : {}),
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
  const contentRevision = sqliteContentRevision({
    agentId,
    sessionId: instance.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    storePath,
  });
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
  } catch {
    return [];
  }
}

function classifyTranscriptArtifact(
  artifactPath: string,
  activeEntriesByPath: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
  activeEntriesBySessionId: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
  sessionKind: MemorySessionKind;
} {
  const directEntry = activeEntriesByPath.get(normalizeRealComparablePath(artifactPath));
  if (directEntry) {
    return {
      generatedByDreamingNarrative: directEntry.generatedByDreamingNarrative === true,
      generatedByCronRun: directEntry.generatedByCronRun === true,
      sessionKind: directEntry.sessionKind ?? "unknown",
    };
  }
  const sessionsDir = path.dirname(artifactPath);
  const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
  const primaryEntry =
    primarySessionId && isSessionArchiveArtifactName(path.basename(artifactPath))
      ? (activeEntriesByPath.get(
          normalizeRealComparablePath(path.join(sessionsDir, `${primarySessionId}.jsonl`)),
        ) ?? activeEntriesBySessionId.get(primarySessionId))
      : undefined;
  return {
    generatedByDreamingNarrative: primaryEntry?.generatedByDreamingNarrative === true,
    generatedByCronRun: primaryEntry?.generatedByCronRun === true,
    sessionKind: primaryEntry?.sessionKind ?? "unknown",
  };
}

function toArtifactCorpusEntry(
  agentId: string,
  artifactPath: string,
  activeEntriesByPath: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
  activeEntriesBySessionId: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
): SessionTranscriptCorpusEntry | null {
  const sessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
  if (!sessionId) {
    return null;
  }
  if (!isSessionArchiveArtifactName(path.basename(artifactPath))) {
    return null;
  }
  const classification = classifyTranscriptArtifact(
    artifactPath,
    activeEntriesByPath,
    activeEntriesBySessionId,
  );
  const contentRevision = fileContentRevision(artifactPath);
  return {
    agentId,
    artifactKind: "archive-artifact",
    sessionFile: artifactPath,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: classification.sessionKind,
  };
}

export function listSessionTranscriptCorpusEntriesForAgentSync(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): SessionTranscriptCorpusEntry[] {
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
  const activeEntriesByPath = new Map<string, SessionTranscriptCorpusEntry>();
  const activeEntriesBySessionId = new Map<string, SessionTranscriptCorpusEntry>();
  const activeEntryOwnersByPath = new Map<string, string>();
  const artifactDirsByPath = new Map<string, string>();
  rememberArtifactDir(artifactDirsByPath, sessionsDir);
  rememberArtifactDir(artifactDirsByPath, resolveSessionTranscriptsDirForAgent(normalizedAgentId));
  const sessionEntries = listSessionEntries({
    agentId: normalizedAgentId,
    hydrateSkillPromptRefs: false,
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
      sessionsDir,
      storePath,
      summary,
      cronGeneratedSessionKeys,
    );
    if (!entry) {
      continue;
    }
    const normalizedEntryPath =
      entry.transcriptSource === "sqlite" ? null : normalizeRealComparablePath(entry.sessionFile);
    if (normalizedEntryPath) {
      activeEntryOwnersByPath.set(normalizedEntryPath, ownerAgentId);
      rememberArtifactDir(artifactDirsByPath, path.dirname(entry.sessionFile));
    }
    if (ownerAgentId === normalizedAgentId) {
      activeEntriesBySessionId.set(entry.sessionId, entry);
      if (normalizedEntryPath) {
        activeEntriesByPath.set(normalizedEntryPath, entry);
      }
    }
  }
  const includeUnownedArtifacts = !isSharedFixedStore;
  const corpusEntries = [...activeEntriesBySessionId.values()].filter(
    (entry) => entry.transcriptSource === "sqlite",
  );
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
      );
      if (entry?.transcriptSource === "sqlite") {
        corpusEntries.push(entry);
      }
    }
  }
  const scannedArtifactPaths = new Set<string>();
  for (const artifactDir of artifactDirsByPath.values()) {
    for (const artifactPath of listSessionTranscriptArtifactFiles(artifactDir)) {
      const normalizedArtifactPath = normalizeRealComparablePath(artifactPath);
      if (scannedArtifactPaths.has(normalizedArtifactPath)) {
        continue;
      }
      scannedArtifactPaths.add(normalizedArtifactPath);
      if (activeEntriesByPath.has(normalizedArtifactPath)) {
        continue;
      }
      const artifactOwner = activeEntryOwnersByPath.get(normalizedArtifactPath);
      if (artifactOwner) {
        continue;
      }
      const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
      const primaryOwner =
        primarySessionId && isSessionArchiveArtifactName(path.basename(artifactPath))
          ? (activeEntryOwnersByPath.get(
              normalizeRealComparablePath(
                path.join(path.dirname(artifactPath), `${primarySessionId}.jsonl`),
              ),
            ) ?? activeEntriesBySessionId.get(primarySessionId)?.agentId)
          : undefined;
      if (primaryOwner && primaryOwner !== normalizedAgentId) {
        continue;
      }
      if (!primaryOwner && !includeUnownedArtifacts) {
        continue;
      }
      const entry = toArtifactCorpusEntry(
        normalizedAgentId,
        artifactPath,
        activeEntriesByPath,
        activeEntriesBySessionId,
      );
      if (entry) {
        corpusEntries.push(entry);
      }
    }
  }
  return corpusEntries;
}

/**
 * Lists transcript corpus entries for QMD/memory indexing.
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
