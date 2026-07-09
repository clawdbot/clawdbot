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
  agentHarnessId?: string;
};

type SourceMigrationResult = {
  archived: boolean;
  importedKeys: number;
  warning?: string;
  notice?: string;
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

async function* iterateIndexedSidecars(
  surface: SessionSurface,
  params: MigrationEnvironment,
): AsyncGenerator<string> {
  for (const storePath of surface.storePaths) {
    let entries: ReturnType<typeof listSessionEntries>;
    try {
      entries = listSessionEntries({ storePath, hydrateSkillPromptRefs: false });
    } catch {
      continue;
    }
    for (const { sessionKey, entry } of entries) {
      const sessionId = entry.sessionId?.trim();
      if (!sessionId) {
        continue;
      }
      const agentId = resolveLegacyBindingOwnerAgentId({
        sessionKey,
        config: params.config,
        storeAgentIds: surface.agentIds,
      });
      let transcriptPath: string;
      try {
        transcriptPath = resolveSessionFilePath(sessionId, entry, {
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
): Promise<Map<string, LegacyBindingOwner[]>> {
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
  for (const storePath of storePaths) {
    let entries: ReturnType<typeof listSessionEntries>;
    try {
      entries = listSessionEntries({ storePath, hydrateSkillPromptRefs: false });
    } catch {
      continue;
    }
    const sessionsDir = path.dirname(storePath);
    for (const { sessionKey, entry } of entries) {
      const sessionId = entry.sessionId?.trim();
      if (!sessionId) {
        continue;
      }
      const agentId = resolveLegacyBindingOwnerAgentId({
        sessionKey,
        config: params.config,
        storeAgentIds: storeAgentIds.get(storePath),
      });
      let transcriptPath: string;
      let legacyTranscriptPath: string;
      try {
        legacyTranscriptPath = resolveLegacySessionFileLocator(sessionsDir, entry, sessionId);
        transcriptPath = await canonicalizePath(
          resolveSessionFilePath(sessionId, entry, { sessionsDir, agentId }),
        );
      } catch {
        continue;
      }
      if (!sourcePaths.has(transcriptPath)) {
        continue;
      }
      const owner: LegacyBindingOwner = {
        agentId,
        sessionId,
        sessionKey,
        storePath,
        transcriptPath: legacyTranscriptPath,
        ...(entry.agentHarnessId?.trim() ? { agentHarnessId: entry.agentHarnessId.trim() } : {}),
      };
      const candidates = owners.get(transcriptPath) ?? new Map<string, LegacyBindingOwner>();
      candidates.set(`${agentId}\0${sessionId}\0${sessionKey}\0${storePath}`, owner);
      owners.set(transcriptPath, candidates);
    }
  }
  return new Map([...owners].map(([key, values]) => [key, [...values.values()]]));
}

function resolveLegacySessionFileLocator(
  sessionsDir: string,
  entry: { sessionFile?: string },
  sessionId: string,
): string {
  const sessionFile = entry.sessionFile?.trim();
  return path.resolve(sessionsDir, sessionFile || `${sessionId}.jsonl`);
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
  owner: LegacyBindingOwner | undefined,
  params: MigrationParams,
  store: PluginStateKeyedStore<MigratedBindingRow>,
): Promise<SourceMigrationResult> {
  let importedKeys = 0;
  const retain = (reason: string): SourceMigrationResult => ({
    archived: false,
    importedKeys,
    warning: `Left Codex binding sidecar in place because ${reason}: ${source.sidecarPath}`,
  });
  try {
    return await withFileLock(source.sidecarPath, LEGACY_BINDING_LOCK_OPTIONS, async () => {
      const [contents, stat] = await Promise.all([
        fs.readFile(source.sidecarPath, "utf8"),
        fs.stat(source.sidecarPath),
      ]);
      const raw = JSON.parse(contents) as Record<string, unknown>;
      const [
        { bindingStoreKey, createStoredCodexAppServerBinding, readCodexAppServerThreadBinding },
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
        currentConversation ??= await store.lookup(key);
      }
      const stored = currentConversation ?? baseStored;
      if (stored.state !== "active" && stored.state !== "cleared") {
        return retain(`canonical plugin state changed at ${conversationKeys[0]}`);
      }
      const sessionKey = owner
        ? bindingStoreKey({
            kind: "session",
            agentId: owner.agentId,
            sessionId: owner.sessionId,
            sessionKey: owner.sessionKey,
          })
        : undefined;
      const entries = [
        ...conversationKeys.map((key) => ({ key, value: stored })),
        ...(owner && sessionKey
          ? [{ key: sessionKey, value: copyBindingForSession(stored, owner.sessionId) }]
          : []),
      ];
      const hasExpected = (value: MigratedBindingRow | undefined, expected: MigratedBindingRow) =>
        expected.state === "cleared"
          ? value?.state === "cleared" &&
            value.sessionId === expected.sessionId &&
            value.retired === expected.retired
          : value?.state === "active" &&
            value.sessionId === expected.sessionId &&
            isDeepStrictEqual(readCodexAppServerThreadBinding(value.binding), expected.binding);

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
      if (!owner) {
        return {
          archived: false,
          importedKeys,
          notice: `Left Codex binding sidecar in place after importing its conversation binding because its session owner could not be resolved: ${source.sidecarPath}`,
        };
      }
      const ownershipWarning = await recordSessionOwner(owner);
      if (ownershipWarning) {
        return retain(ownershipWarning);
      }
      for (const entry of entries) {
        if (!hasExpected(await store.lookup(entry.key), entry.value)) {
          return retain(`canonical plugin state changed at ${entry.key}`);
        }
      }
      await archiveBindingSidecar(source.sidecarPath);
      return { archived: true, importedKeys };
    });
  } catch (error) {
    return retain(`migration or archiving failed: ${String(error)}`);
  }
}

async function recordSessionOwner(owner: LegacyBindingOwner): Promise<string | undefined> {
  const updated = await updateSessionStoreEntry({
    storePath: owner.storePath,
    sessionKey: owner.sessionKey,
    skipMaintenance: true,
    requireWriteSuccess: true,
    update: (entry) => {
      if (entry.sessionId.trim() !== owner.sessionId) {
        return null;
      }
      const harnessId = entry.agentHarnessId?.trim();
      return harnessId ? null : { agentHarnessId: CODEX_AGENT_HARNESS_ID };
    },
  });
  if (!updated || updated.sessionId.trim() !== owner.sessionId) {
    return "its session owner changed before Codex ownership could be recorded";
  }
  const harnessId = updated.agentHarnessId?.trim();
  return harnessId === CODEX_AGENT_HARNESS_ID
    ? undefined
    : harnessId
      ? `its session is owned by agent harness ${harnessId}`
      : "Codex harness ownership could not be recorded on its session";
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
      const notices: string[] = [];
      const { sources, surfaces } = await collectLegacyBindingSources(params);
      if (sources.length === 0) {
        return { changes, warnings };
      }
      const owners = await collectBindingOwners(sources, surfaces, params);
      const store = params.context.openPluginStateKeyedStore<MigratedBindingRow>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      let migrated = 0;
      let partialImports = 0;
      for (const source of sources) {
        const candidates = owners.get(await canonicalizePath(source.transcriptPath)) ?? [];
        const owner = candidates.length === 1 ? candidates[0] : undefined;
        const result = await migrateSource(source, owner, params, store);
        if (result.warning) {
          warnings.push(result.warning);
        }
        if (result.notice) {
          notices.push(result.notice);
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
      return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
    },
  },
];
