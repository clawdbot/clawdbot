import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reclaimDefinitelyStaleFileLock } from "openclaw/plugin-sdk/file-lock";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
// Doctor enumeration cold-loads this closure; the host engine schema pulls the
// runtime-sqlite/kysely graph, so its helpers load lazily in the async migration.
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  legacyStateFileExists,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// sqlite-runtime re-exports the agent-db/kysely graph; keep it lazy so doctor
// enumeration does not cold-load it with this closure.
import {
  importLegacyMemorySidecarIndex,
  LEGACY_MEMORY_SIDECAR_SUFFIXES,
  LegacyMemoryDerivedRowsConflictError,
  type LegacyMemorySidecarSource,
} from "./doctor-memory-sidecar-import.js";

function formatLegacyVectorRows(count: number | undefined): string {
  return count === undefined ? "legacy vector rows" : `${count} vector row(s)`;
}

type MemoryFtsTokenizer = "unicode61" | "trigram";

function resolveConfiguredAgentIds(config: unknown): string[] {
  const cfg = config as { agents?: { entries?: unknown; list?: unknown } };
  const entries = asOptionalObjectRecord(cfg.agents?.entries);
  const listedIds = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.flatMap((entry) => {
        const id = asOptionalObjectRecord(entry)?.id;
        return typeof id === "string" ? [id] : [];
      })
    : [];
  const ids = new Set([...Object.keys(entries ?? {}), ...listedIds].map(normalizeAgentId));
  return ids.size > 0 ? [...ids] : [normalizeAgentId(undefined)];
}

function readAgentMemorySearch(
  config: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = asOptionalObjectRecord(asOptionalObjectRecord(config)?.agents);
  const keyedEntries = asOptionalObjectRecord(agents?.entries);
  const keyedEntry = keyedEntries
    ? Object.entries(keyedEntries).find(([id]) => normalizeAgentId(id) === agentId)?.[1]
    : undefined;
  const keyedSearch = asOptionalObjectRecord(
    asOptionalObjectRecord(asOptionalObjectRecord(keyedEntry)?.memory)?.search,
  );
  if (keyedSearch) {
    return keyedSearch;
  }
  const entries = Array.isArray(agents?.list) ? agents.list : [];
  const entry = entries
    .map(asOptionalObjectRecord)
    .find(
      (candidate) =>
        normalizeAgentId(typeof candidate?.id === "string" ? candidate.id : undefined) === agentId,
    );
  return asOptionalObjectRecord(asOptionalObjectRecord(entry?.memory)?.search);
}

function readMemorySearchLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  const cfg = asOptionalObjectRecord(config);
  return [
    readAgentMemorySearch(config, agentId),
    asOptionalObjectRecord(asOptionalObjectRecord(cfg?.memory)?.search),
    // Doctor still inspects the retired root shape to migrate its persisted sidecar path.
    asOptionalObjectRecord(cfg?.memorySearch),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function readStoreLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  return readMemorySearchLayers(config, agentId).flatMap((search) => {
    const store = asOptionalObjectRecord(search.store);
    return store ? [store] : [];
  });
}

function firstDefined(layers: Record<string, unknown>[], key: string): unknown {
  return layers.find((layer) => layer[key] !== undefined)?.[key];
}

function readNestedStoreLayers(
  config: unknown,
  agentId: string,
  key: string,
): Record<string, unknown>[] {
  return readStoreLayers(config, agentId).flatMap((store) => {
    const nested = asOptionalObjectRecord(store[key]);
    return nested ? [nested] : [];
  });
}

function readMemorySearchVectorExtensionPath(config: unknown, agentId: string): string | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "extensionPath");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readMemorySearchVectorEnabled(config: unknown, agentId: string): boolean {
  if (readMemorySearchProvider(config, agentId) === "none") {
    return false;
  }
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "enabled");
  return typeof raw === "boolean" ? raw : true;
}

function readMemorySearchProvider(config: unknown, agentId: string): string | undefined {
  const raw = firstDefined(readMemorySearchLayers(config, agentId), "provider");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readLegacyMemorySearchStorePaths(config: unknown, agentId: string): string[] {
  return [
    ...new Set(
      readStoreLayers(config, agentId).flatMap((store) =>
        typeof store.path === "string" && store.path.trim() ? [store.path.trim()] : [],
      ),
    ),
  ];
}

function readMemorySearchFtsTokenizer(
  config: unknown,
  agentId: string,
): MemoryFtsTokenizer | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "fts"), "tokenizer");
  return raw === "unicode61" || raw === "trigram" ? raw : undefined;
}

async function collectLegacyMemorySidecarSources(params: {
  config: unknown;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<LegacyMemorySidecarSource[]> {
  const { resolveOpenClawAgentSqlitePath } = await import("openclaw/plugin-sdk/sqlite-runtime");
  const agentIds = new Set(resolveConfiguredAgentIds(params.config));
  const legacyDir = path.join(params.stateDir, "memory");
  const retrySidecars: Array<{ agentId: string; legacyPath: string }> = [];
  try {
    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        const stem = entry.name.slice(0, -".sqlite".length);
        const retryMarker = ".retry-";
        const retryIndex = stem.indexOf(retryMarker);
        const rawAgentId = retryIndex === -1 ? stem : stem.slice(0, retryIndex);
        const agentId = normalizeAgentId(rawAgentId);
        if (retryIndex !== -1 && rawAgentId === agentId && agentIds.has(agentId)) {
          retrySidecars.push({ agentId, legacyPath: path.join(legacyDir, entry.name) });
        }
      }
    }
  } catch {}

  const migrationEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sources: LegacyMemorySidecarSource[] = [];
  const seen = new Set<string>();
  async function addSource(agentId: string, legacyPath: string): Promise<void> {
    const normalizedPath = path.resolve(legacyPath);
    const key = `${agentId}\0${normalizedPath}`;
    if (seen.has(key) || !(await legacyStateFileExists(normalizedPath))) {
      return;
    }
    seen.add(key);
    sources.push({
      agentId,
      legacyPath: normalizedPath,
      stateDir: params.stateDir,
      agentDatabasePath: resolveOpenClawAgentSqlitePath({ agentId, env: migrationEnv }),
    });
  }
  for (const agentId of agentIds) {
    for (const configuredPath of readLegacyMemorySearchStorePaths(params.config, agentId)) {
      await addSource(
        agentId,
        resolveUserPath(configuredPath.replaceAll("{agentId}", agentId), migrationEnv),
      );
    }
    await addSource(agentId, path.join(legacyDir, `${agentId}.sqlite`));
  }
  for (const retrySidecar of retrySidecars) {
    await addSource(retrySidecar.agentId, retrySidecar.legacyPath);
  }
  return sources;
}

async function archiveLegacyMemorySidecar(params: {
  source: LegacyMemorySidecarSource;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const existingSources = (
    await Promise.all(
      LEGACY_MEMORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const filePath = `${params.source.legacyPath}${suffix}`;
        return (await legacyStateFileExists(filePath)) ? filePath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingSources.length === 0) {
    return;
  }
  const existingArchives = (
    await Promise.all(
      existingSources.map(async (sourcePath) => {
        const archivedPath = `${sourcePath}.migrated`;
        return (await legacyStateFileExists(archivedPath)) ? archivedPath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingArchives.length > 0) {
    params.warnings.push(
      `Left migrated Memory Core legacy memory index sidecar in place because ${existingArchives[0]} already exists`,
    );
    return;
  }
  const renamed: Array<{ sourcePath: string; archivedPath: string }> = [];
  for (const sourcePath of existingSources) {
    const archivedPath = `${sourcePath}.migrated`;
    try {
      await fs.rename(sourcePath, archivedPath);
      renamed.push({ sourcePath, archivedPath });
    } catch (err) {
      for (const entry of renamed.toReversed()) {
        try {
          if (
            (await legacyStateFileExists(entry.archivedPath)) &&
            !(await legacyStateFileExists(entry.sourcePath))
          ) {
            await fs.rename(entry.archivedPath, entry.sourcePath);
          }
        } catch (rollbackErr) {
          params.warnings.push(
            `Failed restoring Memory Core legacy memory index sidecar ${entry.archivedPath}: ${String(rollbackErr)}`,
          );
        }
      }
      params.warnings.push(
        `Failed archiving Memory Core legacy memory index sidecar ${sourcePath}: ${String(err)}; restored ${renamed.length} already archived file(s)`,
      );
      return;
    }
  }
  params.changes.push(
    `Archived Memory Core legacy memory index sidecar -> ${params.source.legacyPath}.migrated`,
  );
}

async function preserveLegacyMemorySidecarRetryPath(params: {
  source: LegacyMemorySidecarSource;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const retryPath = path.join(params.source.stateDir, "memory", `${params.source.agentId}.sqlite`);
  if (path.resolve(retryPath) === path.resolve(params.source.legacyPath)) {
    return;
  }
  const resolvedSourcePath = path.resolve(params.source.legacyPath);
  const sourceName = path.basename(resolvedSourcePath);
  // Avoid creating retry-of-retry files on every doctor run.
  if (
    path.dirname(resolvedSourcePath) === path.resolve(params.source.stateDir, "memory") &&
    sourceName.startsWith(`${params.source.agentId}.retry-`) &&
    sourceName.endsWith(".sqlite")
  ) {
    return;
  }
  const existingTargets = (
    await Promise.all(
      LEGACY_MEMORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const targetPath = `${retryPath}${suffix}`;
        return (await legacyStateFileExists(targetPath)) ? targetPath : null;
      }),
    )
  ).filter((targetPath): targetPath is string => targetPath !== null);
  const targetBasePath =
    existingTargets.length === 0
      ? retryPath
      : path.join(
          params.source.stateDir,
          "memory",
          `${params.source.agentId}.retry-${crypto
            .createHash("sha256")
            .update(path.resolve(params.source.legacyPath))
            .digest("hex")
            .slice(0, 12)}.sqlite`,
        );
  if (await legacyStateFileExists(targetBasePath)) {
    return;
  }
  const existingSources = (
    await Promise.all(
      LEGACY_MEMORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const sourcePath = `${params.source.legacyPath}${suffix}`;
        return (await legacyStateFileExists(sourcePath))
          ? { sourcePath, targetPath: `${targetBasePath}${suffix}` }
          : null;
      }),
    )
  ).filter((entry): entry is { sourcePath: string; targetPath: string } => entry !== null);
  if (existingSources.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(targetBasePath), { recursive: true });
  const copied: string[] = [];
  try {
    for (const entry of existingSources) {
      await fs.copyFile(entry.sourcePath, entry.targetPath, fs.constants.COPYFILE_EXCL);
      copied.push(entry.targetPath);
    }
  } catch (err) {
    for (const targetPath of copied) {
      try {
        await fs.rm(targetPath, { force: true });
      } catch {}
    }
    params.warnings.push(
      `Failed copying Memory Core legacy memory index sidecar retry path ${params.source.legacyPath} -> ${retryPath}: ${String(err)}`,
    );
    return;
  }
  params.changes.push(
    `Copied Memory Core legacy memory index sidecar retry path -> ${targetBasePath}`,
  );
}

/**
 * List the sidecar files when every persisted byte is absent: the main file is
 * zero bytes and no WAL/journal sidecar holds content. Returns null when any
 * file carries bytes, because WAL frames alone can contain legacy rows.
 */
async function listEmptyLegacySidecarFiles(legacyPath: string): Promise<string[] | null> {
  const emptyFiles: string[] = [];
  for (const suffix of LEGACY_MEMORY_SIDECAR_SUFFIXES) {
    const candidate = `${legacyPath}${suffix}`;
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > 0) {
        return null;
      }
      emptyFiles.push(candidate);
    } catch (err: unknown) {
      // Only ENOENT means the sidecar is genuinely absent (never written or
      // cleaned up by SQLite).  Other errors (EACCES, EIO, ELOOP, EMFILE)
      // mean we cannot determine the state — fail closed by treating the
      // sidecar as non-empty so no legacy data is silently dropped.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return null;
      }
    }
  }
  return emptyFiles.length > 0 ? emptyFiles : null;
}

async function migrateLegacyMemorySidecarSource(params: {
  source: LegacyMemorySidecarSource;
  config: unknown;
  env: NodeJS.ProcessEnv;
  changes: string[];
  warnings: string[];
}): Promise<{ archiveReady: boolean }> {
  const { ensureMemoryIndexSchema, loadSqliteVecExtension } =
    await import("openclaw/plugin-sdk/memory-core-host-engine-schema");
  const { ensureOpenClawAgentDatabaseSchema, openNodeSqliteDatabase } =
    await import("openclaw/plugin-sdk/sqlite-runtime");
  // OpenClaw itself can leave a zero-byte placeholder at the legacy sidecar
  // path while the live index is the per-agent SQLite database. An empty file
  // holds no legacy rows, so remove it quietly instead of emitting a permanent
  // self-inflicted "not a legacy memory index" warning.
  const emptySidecarFiles = await listEmptyLegacySidecarFiles(params.source.legacyPath);
  if (emptySidecarFiles) {
    let removedAll = true;
    for (const emptyPath of emptySidecarFiles) {
      try {
        await fs.rm(emptyPath, { force: true });
      } catch {
        removedAll = false;
      }
    }
    if (removedAll) {
      params.changes.push(
        `Removed empty Memory Core legacy memory index sidecar placeholder: ${params.source.legacyPath}`,
      );
      return { archiveReady: false };
    }
    // Fall through to the regular import path when cleanup fails so the file
    // is still diagnosed instead of silently ignored.
  }
  await fs.mkdir(path.dirname(params.source.agentDatabasePath), { recursive: true });
  const db = openNodeSqliteDatabase(params.source.agentDatabasePath, { allowExtension: true });
  try {
    const migrationEnv = {
      ...params.env,
      OPENCLAW_STATE_DIR: params.source.stateDir,
    };
    ensureOpenClawAgentDatabaseSchema(db, {
      agentId: params.source.agentId,
      env: migrationEnv,
      path: params.source.agentDatabasePath,
      register: true,
    });
    const ftsTokenizer = readMemorySearchFtsTokenizer(params.config, params.source.agentId);
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true, ftsTokenizer });
    const vectorEnabled = readMemorySearchVectorEnabled(params.config, params.source.agentId);
    const vectorExtensionPath = vectorEnabled
      ? readMemorySearchVectorExtensionPath(params.config, params.source.agentId)
      : undefined;
    const loadedVector = vectorEnabled
      ? await loadSqliteVecExtension({
          db,
          extensionPath: vectorExtensionPath
            ? resolveUserPath(vectorExtensionPath, params.env)
            : undefined,
        })
      : { ok: false as const, error: "vector search is disabled" };
    let result: ReturnType<typeof importLegacyMemorySidecarIndex>;
    try {
      result = importLegacyMemorySidecarIndex({
        db,
        legacySidecarDatabasePath: params.source.legacyPath,
        copyVectorRows: vectorEnabled && loadedVector.ok,
        requireVectorRows: vectorEnabled,
      });
    } catch (err) {
      if (err instanceof LegacyMemoryDerivedRowsConflictError) {
        // Every imported table is a derived search index. A same-identity mismatch means the
        // current per-agent row wins; normal sync rebuilds any rows skipped with the sidecar.
        params.changes.push(
          `Resolved Memory Core legacy memory index conflict for agent ${params.source.agentId} by keeping canonical per-agent SQLite rows`,
        );
        return { archiveReady: true };
      }
      await preserveLegacyMemorySidecarRetryPath(params);
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because legacy rows could not be imported: ${String(err)}`,
      );
      return { archiveReady: false };
    }
    if (result.reason === "legacy-schema-missing") {
      await preserveLegacyMemorySidecarRetryPath(params);
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because the sidecar schema is not a legacy memory index`,
      );
      return { archiveReady: false };
    }
    if (!result.imported) {
      await preserveLegacyMemorySidecarRetryPath(params);
      return { archiveReady: false };
    }
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true, ftsTokenizer });
    params.changes.push(
      `Migrated Memory Core legacy memory index for agent ${params.source.agentId} -> per-agent SQLite (${result.sources} source(s), ${result.chunks} chunk(s), ${result.cacheEntries} cache row(s))`,
    );
    if (!result.vectorEntriesImported) {
      await preserveLegacyMemorySidecarRetryPath(params);
      const vectorReason = loadedVector.ok
        ? "legacy vector table could not be validated"
        : (loadedVector.error ?? "unknown sqlite-vec load error");
      params.warnings.push(
        `Left Memory Core legacy memory index sidecar in place for agent ${params.source.agentId} because ${formatLegacyVectorRows(result.vectorEntries)} still require sqlite-vec: ${vectorReason}`,
      );
      return { archiveReady: false };
    }
    return { archiveReady: true };
  } finally {
    db.close();
  }
}

function groupLegacyMemorySidecarSourcesByPath(
  sources: LegacyMemorySidecarSource[],
): LegacyMemorySidecarSource[][] {
  const groups = new Map<string, LegacyMemorySidecarSource[]>();
  for (const source of sources) {
    const group = groups.get(source.legacyPath) ?? [];
    group.push(source);
    groups.set(source.legacyPath, group);
  }
  return [...groups.values()];
}

export const memorySidecarStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-legacy-sidecar-index-to-agent-sqlite",
  label: "Memory Core legacy memory index sidecar",
  async detectLegacyState(params) {
    const sources = await collectLegacyMemorySidecarSources({
      config: params.config,
      env: params.env,
      stateDir: params.stateDir,
    });
    if (sources.length === 0) {
      return null;
    }
    return {
      preview: sources.map(
        (source) =>
          `- Memory Core legacy memory index: ${source.legacyPath} -> ${source.agentDatabasePath}`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const groups = groupLegacyMemorySidecarSourcesByPath(
      await collectLegacyMemorySidecarSources({
        config: params.config,
        env: params.env,
        stateDir: params.stateDir,
      }),
    );
    for (const sources of groups) {
      let archiveReady = true;
      for (const source of sources) {
        try {
          const result = await migrateLegacyMemorySidecarSource({
            source,
            config: params.config,
            env: params.env,
            changes,
            warnings,
          });
          archiveReady &&= result.archiveReady;
        } catch (err) {
          archiveReady = false;
          await preserveLegacyMemorySidecarRetryPath({ source, changes, warnings });
          warnings.push(
            `Skipped Memory Core legacy memory index import for agent ${source.agentId} because the sidecar could not be imported: ${String(err)}`,
          );
        }
      }
      if (archiveReady && sources[0]) {
        await archiveLegacyMemorySidecar({
          source: sources[0],
          changes,
          warnings,
        });
      }
    }
    return { changes, warnings };
  },
};

const RETIRED_QMD_GLOBAL_LOCK_NAME = "embed.lock.lock";
const RETIRED_QMD_AGENT_LOCK_NAME = "qmd-write.lock.lock";

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

async function collectRetiredQmdFileLocks(stateDir: string): Promise<string[]> {
  const stateEntries = await readDirectoryEntries(stateDir);
  const lockPaths: string[] = [];
  if (stateEntries.some((entry) => entry.name === "qmd" && entry.isDirectory())) {
    const qmdDir = path.join(stateDir, "qmd");
    const qmdEntries = await readDirectoryEntries(qmdDir);
    if (qmdEntries.some((entry) => entry.name === RETIRED_QMD_GLOBAL_LOCK_NAME && entry.isFile())) {
      lockPaths.push(path.join(qmdDir, RETIRED_QMD_GLOBAL_LOCK_NAME));
    }
  }
  if (!stateEntries.some((entry) => entry.name === "agents" && entry.isDirectory())) {
    return lockPaths;
  }
  const agentsDir = path.join(stateDir, "agents");
  for (const entry of await readDirectoryEntries(agentsDir)) {
    if (!entry.isDirectory() || entry.name !== normalizeAgentId(entry.name)) {
      continue;
    }
    const agentDir = path.join(agentsDir, entry.name);
    const agentEntries = await readDirectoryEntries(agentDir);
    if (
      agentEntries.some(
        (agentEntry) => agentEntry.name === RETIRED_QMD_AGENT_LOCK_NAME && agentEntry.isFile(),
      )
    ) {
      lockPaths.push(path.join(agentDir, RETIRED_QMD_AGENT_LOCK_NAME));
    }
  }
  return lockPaths;
}

async function collectRetiredQmdWorkspaceHomes(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  const homes: string[] = [];
  for (const entry of await readDirectoryEntries(agentsDir)) {
    if (!entry.isDirectory() || entry.name !== normalizeAgentId(entry.name)) {
      continue;
    }
    const agentDir = path.join(agentsDir, entry.name);
    const agentEntries = await readDirectoryEntries(agentDir);
    if (agentEntries.some((candidate) => candidate.name === "qmd" && candidate.isDirectory())) {
      homes.push(path.join(agentDir, "qmd"));
    }
  }
  return homes;
}

export const qmdWorkspaceStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-qmd-workspace-retired",
  label: "Memory Core retired QMD workspaces",
  doctorOnly: true,
  async detectLegacyState(params) {
    const homes = await collectRetiredQmdWorkspaceHomes(params.stateDir);
    if (homes.length === 0) {
      return null;
    }
    return {
      preview: homes.map(
        (home) =>
          `- Retired Memory Core QMD workspace: ${home} -> remove derived index, config, cache, and session-export artifacts`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const home of await collectRetiredQmdWorkspaceHomes(params.stateDir)) {
      try {
        await fs.rm(home, { recursive: true, force: true });
        changes.push(`Removed retired Memory Core QMD workspace: ${home}`);
      } catch (err) {
        warnings.push(`Failed removing retired Memory Core QMD workspace ${home}: ${String(err)}`);
      }
    }
    return { changes, warnings };
  },
};

export const qmdLocksStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-qmd-file-locks-to-sqlite-leases",
  label: "Memory Core retired QMD file locks",
  async detectLegacyState(params) {
    const lockPaths = await collectRetiredQmdFileLocks(params.stateDir);
    if (lockPaths.length === 0) {
      return null;
    }
    return {
      preview: lockPaths.map(
        (lockPath) =>
          `- Retired Memory Core QMD file lock: ${lockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const lockPath of await collectRetiredQmdFileLocks(params.stateDir)) {
      try {
        const result = await reclaimDefinitelyStaleFileLock(lockPath);
        if (result === "removed") {
          changes.push(`Removed retired Memory Core QMD file lock: ${lockPath}`);
        } else if (result === "retained") {
          warnings.push(
            `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${lockPath}`,
          );
        }
      } catch (err) {
        warnings.push(
          `Failed removing retired Memory Core QMD file lock ${lockPath}: ${String(err)}`,
        );
      }
    }
    return { changes, warnings };
  },
};
