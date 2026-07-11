import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  listAgentIds,
  resolveAgentDir,
  resolveSessionAgentIds,
} from "openclaw/plugin-sdk/agent-runtime";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk/file-lock";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  listSessionEntries,
  resolveSessionFilePath,
  resolveStorePath,
  updateSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "../app-server/session-binding-meta.js";

const LEGACY_BINDING_SUFFIX = ".codex-app-server.json";
const CODEX_AGENT_HARNESS_ID = "codex";
const MAX_SESSION_DIRECTORY_DEPTH = 16;
const LEGACY_BINDING_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 75, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
  stale: 120_000,
};

type MigrationParams = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type MigrationEnvironment = Pick<MigrationParams, "config" | "env" | "stateDir">;

type SessionSurface = {
  root: string;
  scan: boolean;
  storePaths: Set<string>;
  agentIds: Set<string>;
};

type LegacyBindingSource = {
  sidecarPath: string;
  transcriptPath: string;
  agentIds: Set<string>;
};

type LegacyBindingOwner = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  transcriptPath: string;
  lifecycleRevision?: string;
  agentHarnessId?: string;
};

type LegacySessionIndexEntry = {
  sessionId: string;
  sessionFile?: string;
  lifecycleRevision?: string;
  agentHarnessId?: string;
};

type BindingOwnerCollection = {
  owners: Map<string, LegacyBindingOwner[]>;
  failures: string[];
};

type SourceMigrationResult = {
  archived: boolean;
  importedKeys: number;
  warning?: string;
};

// Keep the doctor contract graph independent from the full Codex runtime.
// The runtime parser loaded in migrateSource validates binding payloads before writes.
type MigratedBindingRow =
  | {
      version: 1;
      state: "active";
      binding: unknown;
      sessionId?: string;
    }
  | {
      version: 1;
      state: "cleared";
      sessionId?: string;
      retired?: true;
    };

async function collectSessionSurfaces(params: MigrationEnvironment): Promise<SessionSurface[]> {
  const surfaces = new Map<string, SessionSurface>();
  const stateRoot = await canonicalizePath(params.stateDir);
  const add = async (root: string, storePath: string, agentId: string, scan: boolean) => {
    const canonicalRoot = await canonicalizePath(root);
    const surface = surfaces.get(canonicalRoot) ?? {
      root: canonicalRoot,
      scan: false,
      storePaths: new Set<string>(),
      agentIds: new Set<string>(),
    };
    surface.scan ||= scan;
    // A store's configured path defines how relative sessionFile locators are
    // resolved. Keep it intact; canonicalize only when deduplicating aliases.
    surface.storePaths.add(path.resolve(storePath));
    surface.agentIds.add(agentId);
    surfaces.set(canonicalRoot, surface);
  };

  const agentIds = new Set(listAgentIds(params.config));
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of await readDirectoryEntries(agentsDir)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const agentId = resolveSessionAgentIds({
      agentId: entry.name,
      config: params.config,
    }).sessionAgentId;
    agentIds.add(agentId);
    const root = path.join(agentsDir, entry.name, "sessions");
    await add(root, path.join(root, "sessions.json"), agentId, true);
  }

  for (const agentId of agentIds) {
    const storePath = resolveStorePath(params.config.session?.store, {
      agentId,
      env: params.env,
    });
    const root = path.dirname(storePath);
    await add(root, storePath, agentId, isPathWithin(stateRoot, await canonicalizePath(root)));
  }

  const legacyRoot = path.join(params.stateDir, "sessions");
  const defaultAgentId = resolveSessionAgentIds({ config: params.config }).defaultAgentId;
  await add(legacyRoot, path.join(legacyRoot, "sessions.json"), defaultAgentId, true);
  return [...surfaces.values()].toSorted((a, b) => a.root.localeCompare(b.root));
}

async function collectLegacyBindingSources(
  params: MigrationEnvironment,
  options: { firstOnly?: boolean } = {},
): Promise<{ sources: LegacyBindingSource[]; surfaces: SessionSurface[] }> {
  const surfaces = await collectSessionSurfaces(params);
  const sources = new Map<string, LegacyBindingSource>();
  const addSource = async (sidecarPath: string, surface: SessionSurface) => {
    const canonicalSidecar = await canonicalizePath(sidecarPath);
    const source = sources.get(canonicalSidecar) ?? {
      sidecarPath: canonicalSidecar,
      transcriptPath: sidecarPath.slice(0, -LEGACY_BINDING_SUFFIX.length),
      agentIds: new Set<string>(),
    };
    for (const agentId of surface.agentIds) {
      source.agentIds.add(agentId);
    }
    sources.set(canonicalSidecar, source);
    return source;
  };
  for (const surface of surfaces) {
    const sidecars = surface.scan
      ? walkSidecars(surface.root)
      : iterateIndexedSidecars(surface, params);
    for await (const sidecarPath of sidecars) {
      const source = await addSource(sidecarPath, surface);
      if (options.firstOnly) {
        return { sources: [source], surfaces };
      }
    }
  }
  return {
    sources: [...sources.values()].toSorted((a, b) => a.sidecarPath.localeCompare(b.sidecarPath)),
    surfaces,
  };
}

async function readLegacySessionIndex(
  storePath: string,
): Promise<
  { entries: Array<{ sessionKey: string; entry: LegacySessionIndexEntry }> } | { failure: string }
> {
  let contents: string;
  try {
    contents = await fs.readFile(storePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { entries: [] }
      : { failure: `session index ${storePath} could not be read${code ? ` (${code})` : ""}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { failure: `session index ${storePath} could not be read (invalid JSON)` };
  }
  if (!isRecord(raw)) {
    return { failure: `session index ${storePath} has invalid entries` };
  }
  let normalizedEntries: ReturnType<typeof listSessionEntries>;
  try {
    normalizedEntries = listSessionEntries({ storePath, hydrateSkillPromptRefs: false });
  } catch {
    return { failure: `session index ${storePath} could not be normalized` };
  }
  const normalizedByKey = new Map(
    normalizedEntries.map(({ sessionKey, entry }) => [sessionKey, entry] as const),
  );
  const entries: Array<{ sessionKey: string; entry: LegacySessionIndexEntry }> = [];
  for (const [sessionKey, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      return { failure: `session index ${storePath} has invalid entries` };
    }
    // Metadata-only rows have no transcript identity and therefore cannot own
    // a binding sidecar. Runtime normalization preserves this shipped shape.
    if (value.sessionId === undefined) {
      continue;
    }
    const rawSessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    const sessionId = normalizedByKey.get(sessionKey)?.sessionId?.trim() ?? "";
    const sessionFile = value.sessionFile;
    const lifecycleRevision = value.lifecycleRevision;
    const agentHarnessId = value.agentHarnessId;
    if (
      !sessionId ||
      sessionId !== rawSessionId ||
      (sessionFile !== undefined && typeof sessionFile !== "string") ||
      (lifecycleRevision !== undefined && typeof lifecycleRevision !== "string") ||
      (agentHarnessId !== undefined && typeof agentHarnessId !== "string")
    ) {
      return { failure: `session index ${storePath} has invalid entries` };
    }
    entries.push({
      sessionKey,
      entry: {
        sessionId,
        ...(typeof sessionFile === "string" ? { sessionFile } : {}),
        ...(typeof lifecycleRevision === "string" ? { lifecycleRevision } : {}),
        ...(typeof agentHarnessId === "string" ? { agentHarnessId } : {}),
      },
    });
  }
  return { entries };
}

async function* iterateIndexedSidecars(
  surface: SessionSurface,
  params: MigrationEnvironment,
): AsyncGenerator<string> {
  for (const storePath of surface.storePaths) {
    const index = await readLegacySessionIndex(storePath);
    if ("failure" in index) {
      continue;
    }
    for (const { sessionKey, entry } of index.entries) {
      const agentId = resolveLegacyBindingOwnerAgentId({
        sessionKey,
        config: params.config,
        storeAgentIds: surface.agentIds,
      });
      let transcriptPath: string;
      try {
        transcriptPath = resolveSessionFilePath(entry.sessionId, entry, {
          sessionsDir: path.dirname(storePath),
          agentId,
        });
      } catch {
        continue;
      }
      const sidecarPath = `${transcriptPath}${LEGACY_BINDING_SUFFIX}`;
      if (await isRegularFile(sidecarPath)) {
        yield sidecarPath;
      }
    }
  }
}

async function* walkSidecars(root: string): AsyncGenerator<string> {
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of (await readDirectoryEntries(current.directory)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(LEGACY_BINDING_SUFFIX)) {
        yield entryPath;
      } else if (entry.isDirectory() && current.depth < MAX_SESSION_DIRECTORY_DEPTH) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
      }
    }
  }
}

async function collectBindingOwners(
  sources: LegacyBindingSource[],
  surfaces: SessionSurface[],
  params: MigrationEnvironment,
): Promise<BindingOwnerCollection> {
  const sourcePaths = new Set(
    await Promise.all(sources.map((source) => canonicalizePath(source.transcriptPath))),
  );
  const owners = new Map<string, Map<string, LegacyBindingOwner>>();
  const storePaths = new Set(surfaces.flatMap((surface) => [...surface.storePaths]));
  const storeAgentIds = new Map<string, Set<string>>();
  for (const surface of surfaces) {
    for (const storePath of surface.storePaths) {
      const agents = storeAgentIds.get(storePath) ?? new Set<string>();
      for (const agentId of surface.agentIds) {
        agents.add(agentId);
      }
      storeAgentIds.set(storePath, agents);
    }
  }
  const failures: string[] = [];
  for (const storePath of storePaths) {
    const canonicalStorePath = await canonicalizePath(storePath);
    const index = await readLegacySessionIndex(storePath);
    if ("failure" in index) {
      failures.push(index.failure);
      continue;
    }
    const sessionsDir = path.dirname(storePath);
    for (const { sessionKey, entry } of index.entries) {
      const sessionId = entry.sessionId;
      const agentId = resolveLegacyBindingOwnerAgentId({
        sessionKey,
        config: params.config,
        storeAgentIds: storeAgentIds.get(storePath),
      });
      let effectiveTranscriptPath: string;
      try {
        effectiveTranscriptPath = resolveSessionFilePath(sessionId, entry, {
          sessionsDir,
          agentId,
        });
      } catch {
        failures.push(`session index ${storePath} has an invalid locator for ${sessionKey}`);
        continue;
      }
      const transcriptPath = await canonicalizePath(effectiveTranscriptPath);
      if (!sourcePaths.has(transcriptPath)) {
        continue;
      }
      const owner: LegacyBindingOwner = {
        agentId,
        sessionId,
        sessionKey,
        storePath,
        transcriptPath: effectiveTranscriptPath,
        ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
        ...(entry.agentHarnessId?.trim() ? { agentHarnessId: entry.agentHarnessId.trim() } : {}),
      };
      const candidates = owners.get(transcriptPath) ?? new Map<string, LegacyBindingOwner>();
      const ownerKey = `${agentId}\0${sessionId}\0${sessionKey}\0${canonicalStorePath}`;
      const configuredStorePath = resolveStorePath(params.config.session?.store, {
        agentId,
        env: params.env,
      });
      // The same physical store can appear through a configured symlink and a
      // discovered real path. Mutate through the path the runtime itself owns.
      if (!candidates.has(ownerKey) || storePath === configuredStorePath) {
        candidates.set(ownerKey, owner);
      }
      owners.set(transcriptPath, candidates);
    }
  }
  return {
    owners: new Map([...owners].map(([key, values]) => [key, [...values.values()]])),
    failures,
  };
}

function resolveLegacyBindingOwnerAgentId(params: {
  sessionKey: string;
  config: MigrationEnvironment["config"];
  storeAgentIds?: Set<string>;
}): string {
  if (params.sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    }).sessionAgentId;
  }
  const storeAgentId = params.storeAgentIds?.size === 1 ? [...params.storeAgentIds][0] : undefined;
  return resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    ...(storeAgentId ? { agentId: storeAgentId } : {}),
  }).sessionAgentId;
}

function copyBindingForSession(stored: MigratedBindingRow, sessionId: string): MigratedBindingRow {
  return stored.state === "active"
    ? { version: 1, state: "active", binding: stored.binding, sessionId }
    : {
        version: 1,
        state: "cleared",
        sessionId,
        ...(stored.retired ? { retired: true } : {}),
      };
}

async function migrateSource(
  source: LegacyBindingSource,
  candidates: LegacyBindingOwner[],
  params: MigrationParams,
  store: PluginStateKeyedStore<MigratedBindingRow>,
): Promise<SourceMigrationResult> {
  let importedKeys = 0;
  const retain = (reason: string): SourceMigrationResult => ({
    archived: false,
    importedKeys,
    warning: `Left Codex binding sidecar in place because ${reason}: ${source.sidecarPath}`,
  });
  const owner = candidates.length === 1 ? candidates[0] : undefined;
  try {
    return await withFileLock(source.sidecarPath, LEGACY_BINDING_LOCK_OPTIONS, async () => {
      const [contents, stat] = await Promise.all([
        fs.readFile(source.sidecarPath, "utf8"),
        fs.stat(source.sidecarPath),
      ]);
      const raw = JSON.parse(contents) as Record<string, unknown>;
      const [
        { bindingStoreKey, createStoredCodexAppServerBinding, readStoredCodexAppServerBinding },
        { legacyCodexConversationBindingId },
      ] = await Promise.all([
        import("../app-server/session-binding.js"),
        import("../conversation-binding-data.js"),
      ]);
      const agentId =
        owner?.agentId ?? (source.agentIds.size === 1 ? [...source.agentIds][0] : undefined);
      const baseStored = createStoredCodexAppServerBinding(raw, {
        now: stat.mtime.toISOString(),
        lookup: {
          config: params.config,
          ...(agentId ? { agentDir: resolveAgentDir(params.config, agentId, params.env) } : {}),
        },
      });
      if (!baseStored) {
        return retain("its binding is invalid");
      }
      if (candidates.length > 1) {
        // The legacy writer keyed one sidecar to one active session file. Multiple
        // current owners are indeterminate, so preserve the source without writes.
        return retain(`${candidates.length} matching session owners make ownership ambiguous`);
      }
      if (owner?.agentHarnessId && owner.agentHarnessId !== CODEX_AGENT_HARNESS_ID) {
        return retain(`its session is owned by agent harness ${owner.agentHarnessId}`);
      }
      const sourceSessionFile =
        typeof raw.sessionFile === "string" && raw.sessionFile.trim()
          ? raw.sessionFile
          : source.transcriptPath;
      const ownerSessionFile =
        typeof raw.sessionFile === "string" && raw.sessionFile.trim()
          ? raw.sessionFile
          : owner?.transcriptPath;
      const conversationKeys = [
        sourceSessionFile,
        ...(ownerSessionFile && ownerSessionFile !== sourceSessionFile ? [ownerSessionFile] : []),
      ].map((sessionFile) =>
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(sessionFile),
        }),
      );
      let currentConversation: MigratedBindingRow | undefined;
      for (const key of conversationKeys) {
        const current = await store.lookup(key);
        if (current === undefined) {
          continue;
        }
        const parsed = readStoredCodexAppServerBinding(current);
        if (!parsed) {
          return retain(`canonical plugin state is invalid at ${key}`);
        }
        currentConversation ??= parsed;
      }
      const stored = currentConversation ?? baseStored;
      const sessionKey = owner
        ? bindingStoreKey({
            kind: "session",
            agentId: owner.agentId,
            sessionId: owner.sessionId,
            sessionKey: owner.sessionKey,
          })
        : undefined;
      const conversationEntries = conversationKeys.map((key) => ({ key, value: stored }));
      const sessionEntry =
        owner && sessionKey
          ? { key: sessionKey, value: copyBindingForSession(stored, owner.sessionId) }
          : undefined;
      const entries = [...conversationEntries, ...(sessionEntry ? [sessionEntry] : [])];
      const hasExpected = (value: MigratedBindingRow | undefined, target: MigratedBindingRow) => {
        const parsed = readStoredCodexAppServerBinding(value);
        if (!parsed) {
          return false;
        }
        return target.state === "cleared"
          ? parsed.state === "cleared" &&
              parsed.sessionId === target.sessionId &&
              parsed.retired === target.retired
          : parsed.state === "active" &&
              parsed.sessionId === target.sessionId &&
              isDeepStrictEqual(parsed.binding, target.binding);
      };
      for (const entry of entries) {
        const current = await store.lookup(entry.key);
        if (current !== undefined && !hasExpected(current, entry.value)) {
          return retain(`canonical plugin state changed at ${entry.key}`);
        }
      }
      for (const entry of entries) {
        if (await store.registerIfAbsent(entry.key, entry.value)) {
          importedKeys++;
        }
        if (!hasExpected(await store.lookup(entry.key), entry.value)) {
          return retain(`canonical plugin state changed at ${entry.key}`);
        }
      }
      if (owner) {
        const ownershipWarning = await recordSessionOwner(owner);
        if (ownershipWarning) {
          if (sessionEntry?.value.state === "active") {
            const update = store.update;
            if (!update) {
              return retain(`${ownershipWarning}; its stale session binding could not be retired`);
            }
            await update(sessionEntry.key, (current) => {
              const parsed = readStoredCodexAppServerBinding(current);
              if (parsed?.lease && parsed.lease.expiresAt > Date.now()) {
                return undefined;
              }
              if (!hasExpected(current, sessionEntry.value)) {
                // Atomic no-op: a concurrent runtime owner replaced or removed this row.
                return undefined;
              }
              return {
                version: 1,
                state: "cleared",
                sessionId: owner.sessionId,
                retired: true,
              };
            });
            if (hasExpected(await store.lookup(sessionEntry.key), sessionEntry.value)) {
              return retain(`${ownershipWarning}; its stale session binding could not be retired`);
            }
          }
          return retain(ownershipWarning);
        }
        for (const entry of entries) {
          if (!hasExpected(await store.lookup(entry.key), entry.value)) {
            return retain(`canonical plugin state changed at ${entry.key}`);
          }
        }
      }
      // Legacy writers only created sidecars for an existing session file. Once
      // unique ownership is recorded, or zero ownership is proven, it is safe to archive.
      await archiveBindingSidecar(source.sidecarPath);
      return { archived: true, importedKeys };
    });
  } catch (error) {
    // Parallel doctor runs can both discover a source before the first archives it.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !(await pathExists(source.sidecarPath))
    ) {
      return { archived: true, importedKeys };
    }
    return retain(`migration or archiving failed: ${String(error)}`);
  }
}

async function recordSessionOwner(owner: LegacyBindingOwner): Promise<string | undefined> {
  let observedForeignHarness: string | undefined;
  const updated = await updateSessionStoreEntry({
    storePath: owner.storePath,
    sessionKey: owner.sessionKey,
    skipMaintenance: true,
    requireWriteSuccess: true,
    update: (entry) => {
      const transcriptPath = resolveOwnerTranscriptPath(owner, entry);
      if (
        entry.sessionId.trim() !== owner.sessionId ||
        transcriptPath !== owner.transcriptPath ||
        entry.lifecycleRevision !== owner.lifecycleRevision
      ) {
        return null;
      }
      const harnessId =
        typeof entry.agentHarnessId === "string" ? entry.agentHarnessId.trim() : undefined;
      if (entry.agentHarnessId !== undefined && harnessId === undefined) {
        return null;
      }
      if (harnessId && harnessId !== CODEX_AGENT_HARNESS_ID) {
        observedForeignHarness = harnessId;
        return null;
      }
      return { agentHarnessId: CODEX_AGENT_HARNESS_ID };
    },
  });
  if (!updated) {
    return observedForeignHarness
      ? `its session is owned by agent harness ${observedForeignHarness}`
      : "its session owner changed before Codex ownership could be recorded";
  }
  const transcriptPath = resolveOwnerTranscriptPath(owner, updated);
  if (
    updated.sessionId.trim() !== owner.sessionId ||
    transcriptPath !== owner.transcriptPath ||
    updated.lifecycleRevision !== owner.lifecycleRevision
  ) {
    return "its session owner changed before Codex ownership could be recorded";
  }
  const harnessId = updated.agentHarnessId?.trim();
  return harnessId === CODEX_AGENT_HARNESS_ID
    ? undefined
    : harnessId
      ? `its session is owned by agent harness ${harnessId}`
      : "Codex harness ownership could not be recorded on its session";
}

function resolveOwnerTranscriptPath(
  owner: LegacyBindingOwner,
  entry: { sessionFile?: string; sessionId: string },
): string | undefined {
  try {
    return resolveSessionFilePath(entry.sessionId, entry, {
      sessionsDir: path.dirname(owner.storePath),
      agentId: owner.agentId,
    });
  } catch {
    return undefined;
  }
}

async function readDirectoryEntries(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return [];
    }
    throw error;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  // Bare ".." (candidate is root's parent) must stay outside; treating it as
  // inside would let doctor recursively scan the whole tree above stateDir.
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalizePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

async function archiveBindingSidecar(sourcePath: string): Promise<void> {
  const archivePath = `${sourcePath}.migrated`;
  if (await pathExists(archivePath)) {
    const [sourceBytes, archiveBytes] = await Promise.all([
      fs.readFile(sourcePath),
      fs.readFile(archivePath),
    ]);
    if (sourceBytes.equals(archiveBytes)) {
      await fs.rm(sourcePath, { force: true });
      return;
    }
    await fs.rename(sourcePath, await firstFreeArchivePath(sourcePath));
    return;
  }
  await fs.rename(sourcePath, archivePath);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "codex-app-server-sidecars-to-plugin-state",
    label: "Codex app-server thread bindings",
    async detectLegacyState(params) {
      const { sources } = await collectLegacyBindingSources(params, { firstOnly: true });
      return sources.length > 0
        ? {
            preview: [
              `- Codex app-server bindings: legacy sidecar -> plugin state (${CODEX_APP_SERVER_BINDING_NAMESPACE})`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const { sources, surfaces } = await collectLegacyBindingSources(params);
      if (sources.length === 0) {
        return { changes, warnings };
      }
      const ownerCollection = await collectBindingOwners(sources, surfaces, params);
      if (ownerCollection.failures.length > 0) {
        warnings.push(
          `Left ${sources.length} Codex binding sidecar(s) in place because session ownership is indeterminate: ${ownerCollection.failures.join("; ")}`,
        );
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<MigratedBindingRow>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      let migrated = 0;
      let partialImports = 0;
      for (const source of sources) {
        const candidates =
          ownerCollection.owners.get(await canonicalizePath(source.transcriptPath)) ?? [];
        const result = await migrateSource(source, candidates, params, store);
        if (result.warning) {
          warnings.push(result.warning);
        }
        if (result.archived) {
          migrated++;
        } else {
          partialImports += result.importedKeys;
        }
      }
      if (migrated > 0) {
        changes.push(
          `Migrated ${migrated} Codex app-server binding sidecar(s) to plugin state and archived the legacy sources`,
        );
      }
      if (partialImports > 0) {
        changes.push(
          `Migrated ${partialImports} safe Codex app-server binding row(s) to plugin state; retained legacy sidecars needing review`,
        );
      }
      return { changes, warnings };
    },
  },
];
