import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  parseUsageCountedSessionIdFromFileName,
  resolveMemorySessionTargets,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  openOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
  tableExists,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import { DREAMS_FILENAMES } from "./dreaming-dreams-file.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  deleteMemoryEntryOrigins,
  listMemoryEntryOrigins,
  recordMemorySessionTombstones,
} from "./memory-entry-origins.js";
import { collectTranscriptWrites } from "./memory-forget-curated-writes.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { closeMemoryDatabase, openMemoryDatabaseAtPath } from "./memory/manager-db.js";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";
import {
  readSessionIngestionState,
  SESSION_CORPUS_RELATIVE_DIR,
  writeSessionIngestionState,
} from "./session-ingestion.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";

type ForgetDatabase = {
  memory_index_chunks: {
    id: string;
    path: string;
    source: string;
    hash: string;
    text: string;
  };
  memory_index_sources: { path: string; source: string };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: "owner" | "agent" | "untrusted" | "system";
    session_kind: "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";
  };
  memory_index_chunks_fts: { id: string; path: string; source: string };
  memory_index_chunks_vec: { id: string };
  memory_embedding_cache: { hash: string };
  memory_index_state: { id: number; revision: number };
};

type MemoryRewrite = {
  absolutePath: string;
  relativePath: string;
  content: string;
  remove: boolean;
};
type ForgetIndexPlan = {
  chunks: Array<ForgetDatabase["memory_index_chunks"]>;
  sources: Array<ForgetDatabase["memory_index_sources"]>;
  ftsRows: number;
  vectorRows: number;
  embeddingCacheRows: number;
  hasVectorTable: boolean;
};

export type MemoryForgetReport = {
  agentId: string;
  dryRun: boolean;
  sessionIds: string[];
  sessionResolutions: Array<{
    sessionId: string;
    sessionKey?: string;
    source: "live" | "archived" | "unresolved";
  }>;
  entryKeys: string[];
  mixedLineageEntryKeys: string[];
  untargetableEntryKeys: string[];
  curatedWrites: Array<{ relativePath: string; observedAt: number }>;
  artifacts: {
    memoryFiles: number;
    memoryEntries: number;
    memoryLines: number;
    sessionCorpusFiles: number;
    sessionCorpusLines: number;
    indexChunks: number;
    indexSources: number;
    ftsRows: number;
    vectorRows: number;
    embeddingCacheRows: number;
    shortTermEntries: number;
    seenHashScopes: number;
    backups: number;
    originRows: number;
  };
  refusals: string[];
};

const PROMOTION_MARKER = /^\s*<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->\s*$/u;
const LINEAGE_MARKER = /^\s*<!--\s*openclaw-memory-lineage:[^\n]*?-->\s*$/u;

function referencesSession(
  value: string,
  agentId: string,
  sessionIds: ReadonlySet<string>,
): boolean {
  const agent = escapePattern(agentId);
  const references = new RegExp(
    `(?:^|[\\s[/:])(?:sessions/${agent}/|${agent}:(?!sessions/))([^\\s\\]#;:/]+)`,
    "gu",
  );
  // Decode archive filenames with the session owner's grammar; a shared prefix
  // or an arbitrary dotted suffix is not the selected session's identity.
  return (
    [...value.matchAll(references)].some(([, reference]) =>
      sessionIds.has(parseUsageCountedSessionIdFromFileName(reference!) ?? reference!),
    ) ||
    [...value.matchAll(/\bSession ID:\s*([^;\s]+)/giu)].some(([, sessionId]) =>
      sessionIds.has(sessionId!),
    )
  );
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scrubMemoryContent(params: {
  content: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  corpusSnippets: ReadonlySet<string>;
  agentId: string;
}): { content: string; removedEntries: number; removedLines: number } {
  // Preserve surviving line endings so unrelated artifacts do not enter the purge plan.
  const lines = params.content.split("\n");
  const corpusSnippets = [...params.corpusSnippets];
  let removedEntries = 0;
  let removedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const markerKey = PROMOTION_MARKER.exec(lines[index] ?? "")?.[1]?.trim();
    if (markerKey && params.entryKeys.has(markerKey)) {
      const start = index > 0 && LINEAGE_MARKER.test(lines[index - 1] ?? "") ? index - 1 : index;
      let end = index + 1;
      if (end < lines.length && !PROMOTION_MARKER.test(lines[end] ?? "")) {
        end += 1;
        while (end < lines.length && /^\s+\S/u.test(lines[end] ?? "")) {
          end += 1;
        }
      }
      lines.splice(start, end - start);
      removedEntries += 1;
      index = start - 1;
      continue;
    }
    if (corpusSnippets.some((snippet) => lines[index]?.includes(snippet))) {
      lines.splice(index, 1);
      removedLines += 1;
      index -= 1;
      continue;
    }
    if (!referencesSession(lines[index] ?? "", params.agentId, params.sessionIds)) {
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(lines[index] ?? "");
    const rowIndent = /^(\s*)[-*+]\s/u.exec(lines[index] ?? "")?.[1]?.length;
    if (!heading && !/\bSession ID:/iu.test(lines[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = /^(#{1,6})\s/u.exec(lines[end] ?? "");
      if (
        (rowIndent !== undefined && (lines[end] ?? "").search(/\S/u) <= rowIndent) ||
        (nextHeading && (!heading || nextHeading[1]!.length <= heading[1]!.length)) ||
        /\bSession ID:/iu.test(lines[end] ?? "")
      ) {
        break;
      }
      end += 1;
    }
    lines.splice(index, end - index);
    removedEntries += 1;
    index -= 1;
  }
  return { content: lines.join("\n"), removedEntries, removedLines };
}

async function planMemoryIndex(params: {
  agentId: string;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  excludedSessionIds: ReadonlySet<string>;
  matchesMemory: (content: string) => boolean;
}): Promise<ForgetIndexPlan> {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db, path: databasePath }) => {
      const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
      const indexedChunks = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("memory_index_chunks")
          .leftJoin(
            "memory_index_chunk_provenance",
            "memory_index_chunk_provenance.chunk_id",
            "memory_index_chunks.id",
          )
          .select([
            "memory_index_chunks.id as id",
            "memory_index_chunks.path as path",
            "memory_index_chunks.source as source",
            "memory_index_chunks.hash as hash",
            "memory_index_chunks.text as text",
            "memory_index_chunk_provenance.origin_class as originClass",
            "memory_index_chunk_provenance.session_kind as sessionKind",
          ]),
      ).rows;
      const changedPaths = new Set(params.changedPaths);
      // Another workspace agent may already have scrubbed the shared file.
      // Its remaining indexed snapshot still owns evidence for this agent's purge.
      for (const chunk of indexedChunks) {
        if (chunk.source === "memory" && params.matchesMemory(chunk.text)) {
          changedPaths.add(chunk.path);
        }
      }
      const chunks = indexedChunks.filter(
        (chunk) =>
          changedPaths.has(chunk.path) ||
          referencesSession(chunk.path, params.agentId, params.sessionIds) ||
          (params.sessionIds.size > 0 &&
            chunk.source === "sessions" &&
            (chunk.originClass === "system" ||
              !isMemorySessionIndexable({ sessionKind: chunk.sessionKind ?? "unknown" }) ||
              referencesSession(chunk.path, params.agentId, params.excludedSessionIds))),
      );
      const removedSessionPaths = new Set(
        chunks.filter((chunk) => chunk.source === "sessions").map((chunk) => chunk.path),
      );
      const sources = executeSqliteQuerySync(
        db,
        kysely.selectFrom("memory_index_sources").select(["path", "source"]),
      ).rows.filter(
        (source) =>
          params.removedPaths.has(source.path) ||
          (source.source === "sessions" && removedSessionPaths.has(source.path)),
      );
      const chunkIds = chunks.map((chunk) => chunk.id);
      const chunkHashes = [...new Set(chunks.map((chunk) => chunk.hash))];
      const ftsRows =
        chunkIds.length > 0 && tableExists(db, "memory_index_chunks_fts")
          ? executeSqliteQuerySync(
              db,
              kysely.selectFrom("memory_index_chunks_fts").select("id").where("id", "in", chunkIds),
            ).rows.length
          : 0;
      const hasVectorTable = tableExists(db, "memory_index_chunks_vec");
      const embeddingCacheRows =
        chunkHashes.length > 0 && tableExists(db, "memory_embedding_cache")
          ? executeSqliteQuerySync(
              db,
              kysely
                .selectFrom("memory_embedding_cache")
                .select("hash")
                .where("hash", "in", chunkHashes),
            ).rows.length
          : 0;
      return { chunks, sources, ftsRows, embeddingCacheRows, hasVectorTable, databasePath };
    },
    { agentId: params.agentId },
  );
  if (!result.found) {
    return {
      chunks: [],
      sources: [],
      ftsRows: 0,
      vectorRows: 0,
      embeddingCacheRows: 0,
      hasVectorTable: false,
    };
  }
  let vectorRows = 0;
  if (result.value.hasVectorTable && result.value.chunks.length > 0) {
    const probe = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    let extensionPath: string;
    try {
      const loaded = await loadSqliteVecExtension({ db: probe });
      if (!loaded.ok || !loaded.extensionPath) {
        throw new Error(
          `memory forget cannot inspect vector index: ${loaded.error ?? "load failed"}`,
        );
      }
      extensionPath = loaded.extensionPath;
    } finally {
      probe.close();
    }
    // Ordinary owner handles cannot enable extensions after construction.
    // This fresh owner-validated handle stays read-only while exposing vec0.
    const vectorResult = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => {
        db.enableLoadExtension(true);
        db.loadExtension(extensionPath);
        const vectorKysely = getNodeSqliteKysely<ForgetDatabase>(db);
        return executeSqliteQuerySync(
          db,
          vectorKysely
            .selectFrom("memory_index_chunks_vec")
            .select("id")
            .where(
              "id",
              "in",
              result.value.chunks.map((chunk) => chunk.id),
            ),
        ).rows.length;
      },
      { agentId: params.agentId },
      { allowExtension: true },
    );
    vectorRows = vectorResult.found ? vectorResult.value : 0;
  }
  return { ...result.value, vectorRows };
}

type MemoryForgetParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionIds?: string[];
  hookSources?: string[];
  participants?: string[];
  since?: string;
  dryRun?: boolean;
};

export async function forgetMemoryEntries(params: MemoryForgetParams): Promise<MemoryForgetReport> {
  if (!params.sessionIds?.length && !params.hookSources?.length && !params.participants?.length) {
    throw new Error("memory forget requires a session, hook source, or participant selector");
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  // Plan against the same locked state we remove; staging and promotion must
  // not publish an earlier snapshot after a successful purge. Preview never writes a lock.
  return params.dryRun
    ? forgetWorkspaceMemory(params, workspaceDir)
    : withMemoryWorkspaceLock(workspaceDir, () => forgetWorkspaceMemory(params, workspaceDir));
}

async function forgetWorkspaceMemory(
  params: MemoryForgetParams,
  workspaceDir: string,
): Promise<MemoryForgetReport> {
  const targets = resolveMemorySessionTargets({
    agentId: params.agentId,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
    sessionIds: params.sessionIds,
    hookSources: params.hookSources,
    participants: params.participants,
    since: params.since,
  });
  const sessionIds = new Set(targets.map((target) => target.sessionId));
  const allOrigins = listMemoryEntryOrigins({ agentId: params.agentId });
  const entryKeys = new Set(
    allOrigins
      .filter((origin) => sessionIds.has(origin.sessionId))
      .map((origin) => origin.entryKey),
  );
  const allOriginKeys = new Set(allOrigins.map((origin) => origin.entryKey));
  const mixedLineageEntryKeys = new Set(
    allOrigins
      .filter((origin) => entryKeys.has(origin.entryKey) && !sessionIds.has(origin.sessionId))
      .map((origin) => origin.entryKey),
  );
  const untargetableEntryKeys = new Set<string>();
  const refusals: string[] = [];
  const corpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const corpusFiles = await fs
    .readdir(corpusDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isFileMissingError(error)) {
        return [];
      }
      throw error;
    });
  const corpusRewrites: MemoryRewrite[] = [];
  const corpusSnippets = new Set<string>();
  let removedCorpusLines = 0;
  for (const file of corpusFiles) {
    if (!file.isFile() || !/\.(?:txt|md)$/iu.test(file.name)) {
      continue;
    }
    const absolutePath = path.join(corpusDir, file.name);
    const content = await fs.readFile(absolutePath, "utf8");
    const lines = content.split("\n");
    const retained = lines.filter((line) => {
      if (!referencesSession(line, params.agentId, sessionIds)) {
        return true;
      }
      const snippet = /^\[[^\]]+#L\d+\]\s*(.+)$/u.exec(line.trimEnd())?.[1]?.trim();
      // Ingestion only admits snippets of at least 12 characters; shorter
      // malformed corpus rows must never trigger broad substring deletion.
      if (snippet && snippet.length >= 12) {
        corpusSnippets.add(snippet);
      }
      return false;
    });
    if (retained.length !== lines.length) {
      removedCorpusLines += lines.length - retained.length;
      const rewritten = retained.join("\n");
      corpusRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: rewritten,
        remove: rewritten.trim().length === 0,
      });
    }
  }

  const memoryRewrites: MemoryRewrite[] = [];
  const scrub = (content: string) =>
    scrubMemoryContent({ content, entryKeys, sessionIds, corpusSnippets, agentId: params.agentId });
  let removedMemoryEntries = 0;
  let removedMemoryLines = 0;
  const memoryFiles = await listMemoryFiles(
    workspaceDir,
    DREAMS_FILENAMES.map((name) => path.join(workspaceDir, name)),
  );
  for (const absolutePath of memoryFiles) {
    // Corpus evidence must survive until every dependent artifact is clean.
    if (path.dirname(absolutePath) === corpusDir) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const key = PROMOTION_MARKER.exec(line)?.[1]?.trim();
      if (key && !allOriginKeys.has(key)) {
        untargetableEntryKeys.add(key);
      }
    }
    const scrubbed = scrub(content);
    if (/^## Memory Consolidation History\r?$[\s\S]*^ {2}- `[+-] /mu.test(scrubbed.content)) {
      refusals.push(
        `Cannot trace historical consolidation highlights in ${path.relative(workspaceDir, absolutePath)}; review them manually.`,
      );
    }
    if (scrubbed.content !== content) {
      memoryRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: scrubbed.content,
        remove: false,
      });
      removedMemoryEntries += scrubbed.removedEntries;
      removedMemoryLines += scrubbed.removedLines;
    }
  }

  const [shortTermEntries, ingestionState, backups, artifactProvenance, sessionCorpusEntries] =
    await Promise.all([
      readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
        namespace: SHORT_TERM_RECALL_NAMESPACE,
        workspaceDir,
      }),
      readSessionIngestionState(workspaceDir),
      readMemoryPreimages(workspaceDir),
      listMemoryArtifactProvenance({ workspaceDir }),
      listSessionTranscriptCorpusEntriesForAgent(params.agentId),
    ]);
  const sessionKeys = new Set(targets.map((target) => target.sessionKey));
  const curatedWrites = new Map(
    artifactProvenance
      .filter(({ provenance }) =>
        provenance.sessionId
          ? sessionIds.has(provenance.sessionId)
          : Boolean(provenance.sessionKey && sessionKeys.has(provenance.sessionKey)),
      )
      .map(({ relativePath, provenance }) => [
        relativePath,
        { relativePath, observedAt: provenance.observedAt },
      ]),
  );
  const retainedShortTerm = shortTermEntries.filter(
    ({ key, value }) =>
      !entryKeys.has(key) &&
      !entryKeys.has(value.key) &&
      !referencesSession(`${value.path}\n${value.snippet}`, params.agentId, sessionIds),
  );
  const retainedSeenMessages = Object.entries(ingestionState.seenMessages).filter(
    ([scope]) => !referencesSession(scope, params.agentId, sessionIds),
  );
  const removedSeenScopes =
    Object.keys(ingestionState.seenMessages).length - retainedSeenMessages.length;
  const retainedFileStates = Object.fromEntries(
    Object.entries(ingestionState.files).filter(
      ([key]) => !referencesSession(key, params.agentId, sessionIds),
    ),
  );
  let rewrittenBackups = 0;
  const nextBackups = backups.map(({ key, value }) => {
    const scrubbed = scrub(value.content);
    if (scrubbed.content === value.content) {
      return { key, value };
    }
    rewrittenBackups += 1;
    return {
      key,
      value: {
        ...value,
        content: scrubbed.content,
        contentHash: createHash("sha256").update(scrubbed.content).digest("hex"),
      },
    };
  });

  const excludedSessionIds = new Set<string>();
  for (const entry of sessionCorpusEntries) {
    const selectedSession = sessionIds.has(entry.sessionId);
    if (!isMemorySessionIndexable(entry)) {
      excludedSessionIds.add(entry.sessionId);
      if (!selectedSession) {
        continue;
      }
    }
    if (
      selectedSession ||
      (entry.artifactKind === "archive-artifact" &&
        (!entry.sessionKind || entry.sessionKind === "unknown"))
    ) {
      const parsed = await buildSessionEntry(entry.sessionFile, {
        ...(entry.transcriptSource === "sqlite"
          ? { agentId: entry.agentId, sessionId: entry.sessionId, storePath: entry.storePath }
          : {}),
        ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
        ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
        ...(selectedSession
          ? {
              onTranscriptMessage: (message: unknown, observedAt: number) =>
                collectTranscriptWrites({
                  message,
                  observedAt,
                  workspaceDir,
                  writes: curatedWrites,
                }),
            }
          : {}),
      });
      if (parsed && !isMemorySessionIndexable(parsed)) {
        excludedSessionIds.add(entry.sessionId);
      }
    }
  }

  const changedPaths = new Set(
    [...memoryRewrites, ...corpusRewrites].map((rewrite) => rewrite.relativePath),
  );
  const indexPlan = await planMemoryIndex({
    agentId: params.agentId,
    changedPaths,
    removedPaths: new Set(
      corpusRewrites.filter((rewrite) => rewrite.remove).map((rewrite) => rewrite.relativePath),
    ),
    sessionIds,
    excludedSessionIds,
    matchesMemory: (content) => scrub(content).content !== content,
  });
  const report: MemoryForgetReport = {
    agentId: params.agentId,
    dryRun: params.dryRun === true,
    sessionIds: [...sessionIds].toSorted(),
    sessionResolutions: targets
      .map(({ sessionId, sessionKey, resolution }) =>
        sessionKey
          ? { sessionId, sessionKey, source: resolution }
          : { sessionId, source: resolution },
      )
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId)),
    entryKeys: [...entryKeys].toSorted(),
    mixedLineageEntryKeys: [...mixedLineageEntryKeys].toSorted(),
    untargetableEntryKeys: [...untargetableEntryKeys].toSorted(),
    curatedWrites: [...curatedWrites.values()].toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    artifacts: {
      memoryFiles: memoryRewrites.length,
      memoryEntries: removedMemoryEntries,
      memoryLines: removedMemoryLines,
      sessionCorpusFiles: corpusRewrites.length,
      sessionCorpusLines: removedCorpusLines,
      indexChunks: indexPlan.chunks.length,
      indexSources: indexPlan.sources.length,
      ftsRows: indexPlan.ftsRows,
      vectorRows: indexPlan.vectorRows,
      embeddingCacheRows: indexPlan.embeddingCacheRows,
      shortTermEntries: shortTermEntries.length - retainedShortTerm.length,
      seenHashScopes: removedSeenScopes,
      backups: rewrittenBackups,
      originRows: allOrigins.filter((origin) => entryKeys.has(origin.entryKey)).length,
    },
    refusals,
  };
  if (params.dryRun || sessionIds.size === 0) {
    return report;
  }

  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  const vectorDb =
    indexPlan.chunks.length > 0 && indexPlan.hasVectorTable
      ? openMemoryDatabaseAtPath(database.path, true, params.agentId)
      : undefined;
  const db = vectorDb ?? database.db;
  const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
  const chunkIds = indexPlan.chunks.map((chunk) => chunk.id);
  const chunkHashes = [...new Set(indexPlan.chunks.map((chunk) => chunk.hash))];
  try {
    if (vectorDb) {
      const loaded = await loadSqliteVecExtension({ db });
      if (!loaded.ok) {
        throw new Error(
          `memory forget cannot purge vector index: ${loaded.error ?? "load failed"}`,
        );
      }
    }

    // Forget is durable admission policy: persist it before removing the
    // checkpoints that would otherwise make this session look newly eligible.
    const recorded = recordMemorySessionTombstones({
      agentId: params.agentId,
      sessionIds: [...sessionIds],
    });
    if (recorded === 0 && changedPaths.size > 0) {
      // Repeating a partial purge can still rewrite an unindexed file. Fence
      // pending shadow rebuilds before any filesystem mutation, even on failure.
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("memory_index_state")
          .set((expression) => ({ revision: expression("revision", "+", 1) }))
          .where("id", "=", 1),
      );
    }

    // Remove derived records before their matching evidence. On any failure,
    // unchanged files/corpus/origins still identify the remaining work on retry.
    // The workspace lock and index snapshot/revision checks fence stale publishers.
    runSqliteImmediateTransactionSync(db, () => {
      if (chunkIds.length > 0) {
        if (indexPlan.ftsRows > 0) {
          executeSqliteQuerySync(
            db,
            kysely.deleteFrom("memory_index_chunks_fts").where("id", "in", chunkIds),
          );
        }
        if (indexPlan.hasVectorTable) {
          executeSqliteQuerySync(
            db,
            kysely.deleteFrom("memory_index_chunks_vec").where("id", "in", chunkIds),
          );
        }
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("memory_index_chunks").where("id", "in", chunkIds),
        );
      }
      for (const source of indexPlan.sources) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("memory_index_sources")
            .where("path", "=", source.path)
            .where("source", "=", source.source),
        );
      }
      if (indexPlan.embeddingCacheRows > 0) {
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("memory_embedding_cache").where("hash", "in", chunkHashes),
        );
      }
    });
    if (retainedShortTerm.length !== shortTermEntries.length) {
      await writeMemoryCoreWorkspaceEntries({
        namespace: SHORT_TERM_RECALL_NAMESPACE,
        workspaceDir,
        entries: retainedShortTerm,
      });
    }
    if (
      removedSeenScopes > 0 ||
      Object.keys(retainedFileStates).length !== Object.keys(ingestionState.files).length
    ) {
      await writeSessionIngestionState(workspaceDir, {
        ...ingestionState,
        files: retainedFileStates,
        seenMessages: Object.fromEntries(retainedSeenMessages),
      });
    }
    if (rewrittenBackups > 0) {
      await writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
        workspaceDir,
        entries: nextBackups,
      });
    }
    for (const rewrite of [...memoryRewrites, ...corpusRewrites]) {
      if (rewrite.remove) {
        await fs.unlink(rewrite.absolutePath);
      } else {
        await fs.writeFile(rewrite.absolutePath, rewrite.content, "utf8");
      }
    }
    deleteMemoryEntryOrigins({ agentId: params.agentId, entryKeys: [...entryKeys] });
    return report;
  } finally {
    if (vectorDb) {
      closeMemoryDatabase(vectorDb);
    }
  }
}
