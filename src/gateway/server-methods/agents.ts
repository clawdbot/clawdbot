// Agents gateway methods expose agent listing, config mutation, workspace file
// reads/writes, identity merging, and safe deletion for operator clients.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsListParams,
  validateAgentsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createAgent } from "../../agents/agent-create.js";
import { findOverlappingWorkspaceAgentIds } from "../../agents/agent-delete-safety.js";
import {
  isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath,
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "../../agents/agent-dir-registry.js";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  beginAgentDeletion,
  claimCompletedAgentDeletion,
} from "../../agents/agent-lifecycle-registry.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import {
  createAgentIdentityConfig,
  mergeIdentityMarkdownContent,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../../agents/workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceSetupCompleted,
} from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import {
  readConfigFileSnapshotForWrite,
  withConfigMutationExclusive,
} from "../../config/config.js";
import { purgeAgentSessionStoreEntries } from "../../config/sessions.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withAgentExecApprovalsRemoved } from "../../infra/exec-approvals.js";
import { root, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  readAgentDeletionJournal,
  type AgentDeletionJournalCleanupPath,
} from "../../state/agent-deletion-journal.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { resolveUserPath } from "../../utils.js";
import { listAgentsForGateway } from "../session-utils.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
  isConfiguredAgent,
  updateAgentConfigEntry,
} from "./agents-config-mutations.js";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

const agentsHandlerDeps = {
  root,
  isWorkspaceSetupCompleted,
};

export const testing = {
  setDepsForTests(
    overrides: Partial<{
      root: typeof root;
      isWorkspaceSetupCompleted: typeof isWorkspaceSetupCompleted;
    }>,
  ) {
    if (overrides.isWorkspaceSetupCompleted) {
      agentsHandlerDeps.isWorkspaceSetupCompleted = overrides.isWorkspaceSetupCompleted;
    }
    if (overrides.root) {
      agentsHandlerDeps.root = overrides.root;
    }
  },
  resetDepsForTests() {
    agentsHandlerDeps.root = root;
    agentsHandlerDeps.isWorkspaceSetupCompleted = isWorkspaceSetupCompleted;
  },
};

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME] as const;

// Gateway file mutations are intentionally capped to the workspace files the UI owns.
const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
  cfg: OpenClawConfig,
): {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type WorkspaceRoot = Awaited<ReturnType<typeof root>>;

function isRegularWorkspaceFileStat(stat: {
  isFile: boolean | (() => boolean);
  isSymbolicLink: boolean | (() => boolean);
  nlink: number;
}): boolean {
  const isFile = typeof stat.isFile === "function" ? stat.isFile() : stat.isFile;
  const isSymbolicLink =
    typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : stat.isSymbolicLink;
  // Reject links even after path-root containment so workspace reads cannot follow shared files.
  return isFile && !isSymbolicLink && stat.nlink <= 1;
}

function toWorkspaceFileMeta(
  stat: {
    size: number;
    mtimeMs: number;
  } & Parameters<typeof isRegularWorkspaceFileStat>[0],
): FileMeta | null {
  if (!isRegularWorkspaceFileStat(stat)) {
    return null;
  }
  return {
    size: stat.size,
    updatedAtMs: Math.floor(stat.mtimeMs),
  };
}

async function statWorkspaceFileSafely(
  workspaceRoot: WorkspaceRoot | null,
  workspaceDir: string,
  name: string,
): Promise<FileMeta | null> {
  try {
    const stat = workspaceRoot
      ? await workspaceRoot.stat(name)
      : await fs.lstat(path.join(workspaceDir, name));
    return toWorkspaceFileMeta(stat);
  } catch {
    if (!workspaceRoot) {
      return null;
    }
    try {
      // fs-safe roots can reject fixtures that are still valid regular files for listing metadata.
      const stat = await fs.lstat(path.join(workspaceDir, name));
      return toWorkspaceFileMeta(stat);
    } catch {
      return null;
    }
  }
}

async function openWorkspaceRootSafely(workspaceDir: string): Promise<WorkspaceRoot | null> {
  try {
    return await agentsHandlerDeps.root(workspaceDir);
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const workspaceRoot = await openWorkspaceRootSafely(workspaceDir);
  if (!workspaceRoot) {
    // Keep the UI shape stable when the workspace path is missing or unsafe.
    const missingNames = [
      ...(options?.hideBootstrap ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING : BOOTSTRAP_FILE_NAMES),
      DEFAULT_MEMORY_FILENAME,
    ];
    return missingNames.map((name) => ({
      name,
      path: path.join(workspaceDir, name),
      missing: true,
    }));
  }

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryMeta = await statWorkspaceFileSafely(
    workspaceRoot,
    workspaceDir,
    DEFAULT_MEMORY_FILENAME,
  );
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
      missing: true,
    });
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: OpenClawConfig) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function respondInvalidMethodParams(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

type AgentDeleteRemovedPath = {
  path: string;
  method: "trash" | "missing";
};

type AgentDeleteFailedPath = {
  path: string;
  reason: string;
};

type AgentDeletePathOutcome =
  | { removed: AgentDeleteRemovedPath }
  | { skipped: AgentDeleteFailedPath }
  | { failed: AgentDeleteFailedPath };

class AgentCleanupIdentityMismatchError extends Error {}

function cleanupFailure(pathname: string, error: unknown): AgentDeletePathOutcome {
  const reason = error instanceof Error && error.message ? error.message : String(error);
  return { failed: { path: pathname, reason: reason || "unknown error" } };
}

function cleanupPathIdentity(stat: { dev?: number | bigint; ino?: number | bigint } | undefined) {
  if (
    (typeof stat?.dev !== "number" && typeof stat?.dev !== "bigint") ||
    (typeof stat.ino !== "number" && typeof stat.ino !== "bigint")
  ) {
    return null;
  }
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new Error("cleanup path identity exceeds the safe integer range");
  }
  return { dev, ino };
}

async function statAgentCleanupPath(cleanupPath: AgentDeleteCleanupPath) {
  const parentPath = cleanupPath.parentPath;
  const parentRoot = await agentsHandlerDeps.root(parentPath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  if (path.resolve(parentRoot.rootReal) !== parentPath) {
    throw new FsSafeError("path-mismatch", "cleanup path parent changed before deletion");
  }
  const stat = await parentRoot.stat(path.basename(cleanupPath.trashPath));
  const isSymlink = stat.isSymbolicLink;
  if (isSymlink !== (cleanupPath.kind === "symlink")) {
    throw new AgentCleanupIdentityMismatchError(
      `cleanup path changed from ${cleanupPath.kind} before deletion`,
    );
  }
  if (stat.isFile && stat.nlink > 1) {
    throw new AgentCleanupIdentityMismatchError("hardlinked cleanup replacement preserved");
  }
  const identity = cleanupPathIdentity(stat);
  if (cleanupPath.preparedIdentity === null) {
    if (identity !== null) {
      throw new AgentCleanupIdentityMismatchError(
        "cleanup path appeared after deletion preparation",
      );
    }
  } else if (
    identity === null ||
    identity.dev !== cleanupPath.preparedIdentity.dev ||
    identity.ino !== cleanupPath.preparedIdentity.ino
  ) {
    throw new AgentCleanupIdentityMismatchError("cleanup path identity changed before deletion");
  }
}

function isMissingCleanupPathError(error: unknown): boolean {
  return (
    (error instanceof FsSafeError && error.code === "not-found") ||
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function removeAgentPath(
  cleanupPath: AgentDeleteCleanupPath,
): Promise<AgentDeletePathOutcome> {
  const pathname = cleanupPath.path;
  const trashPath = cleanupPath.trashPath;
  try {
    await statAgentCleanupPath(cleanupPath);
  } catch (error) {
    if (error instanceof AgentCleanupIdentityMismatchError) {
      return { skipped: { path: pathname, reason: error.message } };
    }
    return isMissingCleanupPathError(error)
      ? { removed: { path: pathname, method: "missing" } }
      : cleanupFailure(pathname, error);
  }
  try {
    // fs-safe pins traversal and identity for validation; Trash has no fd-relative move API, so
    // replacement after this check and before its rename is the accepted residual race bound.
    await movePathToTrash(trashPath);
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return cleanupFailure(pathname, error);
    }
    try {
      await statAgentCleanupPath(cleanupPath);
      return cleanupFailure(pathname, error);
    } catch (statError) {
      return isMissingCleanupPathError(statError)
        ? { removed: { path: pathname, method: "missing" } }
        : cleanupFailure(pathname, statError);
    }
  }
}

type AgentDeleteCleanupPath = {
  path: string;
  parentPath: string;
  canonicalPath: string;
  trashPath: string;
  trashCoversDescendants: boolean;
  kind: "target" | "symlink";
  preparedIdentity: { dev: number; ino: number } | null;
  done: boolean;
  note?: string;
  preparationError?: unknown;
  sourcePaths: string[];
};

async function resolveAgentDeleteCleanupTarget(pathname: string): Promise<string> {
  let candidate = path.resolve(pathname);
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return path.resolve(await fs.realpath(candidate), ...missingSuffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      let candidateStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        candidateStat = await fs.lstat(candidate);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
      }
      if (candidateStat?.isSymbolicLink()) {
        const linkTarget = await fs.readlink(candidate);
        const resolvedLinkTarget = await resolveAgentDeleteCleanupTarget(
          path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(candidate), linkTarget),
        );
        return path.resolve(resolvedLinkTarget, ...missingSuffix);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function prepareAgentDeleteCleanupPaths(
  paths: readonly string[],
  persistedPaths: readonly AgentDeletionJournalCleanupPath[] = [],
): Promise<AgentDeleteCleanupPath[]> {
  const uniquePaths = new Map<string, AgentDeleteCleanupPath>();
  const addPath = (candidate: AgentDeleteCleanupPath) => {
    const existing = uniquePaths.get(candidate.trashPath);
    if (!existing) {
      uniquePaths.set(candidate.trashPath, candidate);
      return;
    }
    existing.sourcePaths = [...new Set([...existing.sourcePaths, ...candidate.sourcePaths])];
    existing.done ||= candidate.done;
    existing.note ??= candidate.note;
    existing.preparationError ??= candidate.preparationError;
    if (candidate.kind === "target") {
      existing.kind = "target";
      existing.canonicalPath = candidate.canonicalPath;
      existing.parentPath = candidate.parentPath;
      existing.trashCoversDescendants ||= candidate.trashCoversDescendants;
    }
  };
  if (persistedPaths.length > 0) {
    for (const persistedPath of persistedPaths) {
      const journalPath = path.resolve(persistedPath.path);
      const trashPath = path.resolve(persistedPath.canonicalPath);
      addPath({
        path: journalPath,
        parentPath: path.resolve(persistedPath.parentPath),
        canonicalPath: normalizeAgentDirRegistryPath(trashPath),
        trashPath,
        trashCoversDescendants: persistedPath.coversDescendants,
        kind: persistedPath.kind,
        preparedIdentity:
          persistedPath.dev === null || persistedPath.ino === null
            ? null
            : { dev: persistedPath.dev, ino: persistedPath.ino },
        done: persistedPath.done,
        note: persistedPath.note,
        sourcePaths: persistedPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
      });
    }
  }
  for (const pathname of paths) {
    const sourcePath = path.resolve(pathname);
    let sourceParentPath = path.dirname(sourcePath);
    let resolvedPath = sourcePath;
    let preparationError: unknown;
    try {
      resolvedPath = await resolveAgentDeleteCleanupTarget(pathname);
      sourceParentPath = await resolveAgentDeleteCleanupTarget(path.dirname(sourcePath));
    } catch (error) {
      preparationError = error;
    }
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      sourceStat = await fs.lstat(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        preparationError ??= error;
      }
    }
    let targetStat = sourceStat;
    if (resolvedPath !== sourcePath) {
      try {
        targetStat = await fs.lstat(resolvedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          preparationError ??= error;
        }
        targetStat = undefined;
      }
    }
    const canonicalPath = normalizeAgentDirRegistryPath(resolvedPath);
    let trashCoversDescendants = false;
    if (targetStat) {
      trashCoversDescendants = !targetStat.isSymbolicLink();
    }
    addPath({
      path: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      canonicalPath,
      trashPath: resolvedPath,
      trashCoversDescendants,
      kind: "target",
      preparedIdentity: cleanupPathIdentity(targetStat),
      done: false,
      preparationError,
      sourcePaths: [sourcePath],
    });
    if (sourceStat?.isSymbolicLink() && sourcePath !== resolvedPath) {
      addPath({
        path: sourcePath,
        parentPath: sourceParentPath,
        canonicalPath,
        trashPath: path.join(sourceParentPath, path.basename(sourcePath)),
        trashCoversDescendants: false,
        kind: "symlink",
        preparedIdentity: cleanupPathIdentity(sourceStat),
        done: false,
        sourcePaths: [sourcePath],
      });
    }
  }
  const depth = (pathname: string) =>
    path.relative(path.parse(pathname).root, pathname).split(path.sep).filter(Boolean).length;
  const cleanupDepth = (cleanupPath: AgentDeleteCleanupPath) =>
    Math.max(
      depth(cleanupPath.canonicalPath),
      depth(cleanupPath.trashPath),
      ...cleanupPath.sourcePaths.map(depth),
    );
  const compareFallback = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target" ? -1 : 1;
    }
    const depthDifference = cleanupDepth(right) - cleanupDepth(left);
    if (depthDifference !== 0) {
      return depthDifference;
    }
    const trashDepth = depth(right.trashPath) - depth(left.trashPath);
    return trashDepth || left.trashPath.localeCompare(right.trashPath);
  };
  const mustPrecede = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target";
    }
    if (isPathInside(right.trashPath, left.trashPath)) {
      return true;
    }
    if (isPathInside(left.trashPath, right.trashPath)) {
      return false;
    }
    const rightRoots = [right.trashPath, ...right.sourcePaths];
    return left.sourcePaths.some((leftSource) =>
      rightRoots.some((rightRoot) => isPathInside(rightRoot, leftSource)),
    );
  };
  const remaining = [...uniquePaths.values()].toSorted(compareFallback);
  const ordered: AgentDeleteCleanupPath[] = [];
  // Snapshot real targets and clean every physical or lexical descendant first; moving an
  // ancestor symlink would otherwise hide surviving child data and let recovery finalize.
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((candidate, candidateIndex) =>
      remaining.every(
        (other, otherIndex) => otherIndex === candidateIndex || !mustPrecede(other, candidate),
      ),
    );
    ordered.push(...remaining.splice(Math.max(0, nextIndex), 1));
  }
  return ordered;
}

function cleanupPathCovers(
  cleanupPath: AgentDeleteCleanupPath,
  targetPath: string,
  canonicalTargetPath: string,
): boolean {
  const trashTargetPath = path.resolve(targetPath);
  return (
    cleanupPath.sourcePaths.includes(trashTargetPath) ||
    cleanupPath.trashPath === trashTargetPath ||
    (cleanupPath.trashCoversDescendants &&
      (cleanupPath.kind === "target" || isPathInside(cleanupPath.trashPath, trashTargetPath)) &&
      isPathInside(cleanupPath.canonicalPath, canonicalTargetPath))
  );
}

type AgentDeleteDatabasePlan = {
  paths: string[];
  registrationPaths: string[];
  fileGroups: string[][];
  relocatedFileGroups: string[][];
};

function resolveSurvivingDatabaseFilePaths(
  registeredDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases>,
  agentId: string,
): string[] {
  return [
    ...new Set(
      registeredDatabases
        .filter((entry) => normalizeAgentId(entry.agentId) !== agentId)
        .flatMap((entry) => resolveSqliteDatabaseFilePaths(entry.path))
        .map((pathname) => normalizeAgentDirRegistryPath(pathname)),
    ),
  ];
}

function isPathOwnedBySurvivingAgent(
  cfg: OpenClawConfig,
  agentId: string,
  pathname: string,
  survivingDatabaseFilePaths: readonly string[] = [],
): boolean {
  const canonicalPath = normalizeAgentDirRegistryPath(pathname);
  return (
    isPathOwnedByAnotherRegisteredAgent({ agentId, pathname }) ||
    findOverlappingWorkspaceAgentIds(cfg, agentId, pathname).length > 0 ||
    survivingDatabaseFilePaths.some(
      (databasePath) =>
        databasePath === canonicalPath ||
        isPathInside(databasePath, canonicalPath) ||
        isPathInside(canonicalPath, databasePath),
    )
  );
}

function prepareAgentDeleteDatabases(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
): AgentDeleteDatabasePlan {
  const registeredDatabases = listOpenClawRegisteredAgentDatabases();
  const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
    registeredDatabases,
    agentId,
  );
  const registeredDatabasePaths = new Set([
    resolveOpenClawAgentSqlitePath({
      agentId,
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    }),
    ...registeredDatabases
      .filter((entry) => normalizeAgentId(entry.agentId) === agentId)
      .map((entry) => entry.path),
  ]);
  const databasePaths = [...registeredDatabasePaths].filter((pathname) =>
    resolveSqliteDatabaseFilePaths(pathname).every(
      (filePath) =>
        !isPathOwnedBySurvivingAgent(cfg, agentId, filePath, survivingDatabaseFilePaths),
    ),
  );
  for (const databasePath of databasePaths) {
    closeOpenClawAgentDatabaseByPath(databasePath);
  }
  assertNoOpenClawAgentDatabaseLeases(agentId);
  const fileGroups = databasePaths.map(resolveSqliteDatabaseFilePaths);
  const relocatedFileGroups = fileGroups.filter((fileGroup) => {
    const relative = path.relative(agentDir, fileGroup[0] ?? agentDir);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  return {
    paths: databasePaths,
    registrationPaths: [...registeredDatabasePaths],
    fileGroups,
    relocatedFileGroups,
  };
}

function unregisterAgentDeleteDatabases(agentId: string, databasePaths: string[]): void {
  for (const databasePath of databasePaths) {
    unregisterOpenClawAgentDatabase({ agentId, path: databasePath });
  }
}

function prepareJournaledAgentDirOwnership(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
): void {
  for (const configuredAgentId of listAgentIds(cfg)) {
    resolveAgentDir(cfg, configuredAgentId);
  }
  const registeredOwner = resolveRegisteredAgentIdForDir(agentDir);
  if (registeredOwner !== undefined) {
    return;
  }
  // The durable journal retains ownership across restarts after the roster entry is gone.
  registerResolvedAgentDir({ agentId, agentDir });
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

function respondWorkspaceFileMissing(params: {
  respond: RespondFn;
  agentId: string;
  workspaceDir: string;
  name: string;
  filePath: string;
}): void {
  params.respond(
    true,
    {
      agentId: params.agentId,
      workspace: params.workspaceDir,
      file: { name: params.name, path: params.filePath, missing: true },
    },
    undefined,
  );
}

async function writeWorkspaceFileOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
  content: string;
}): Promise<boolean> {
  await fs.mkdir(params.workspaceDir, { recursive: true });
  try {
    const workspaceRoot = await agentsHandlerDeps.root(params.workspaceDir);
    await workspaceRoot.write(params.name, params.content, { encoding: "utf8" });
  } catch (err) {
    if (err instanceof FsSafeError) {
      respondWorkspaceFileUnsafe(params.respond, params.name);
      return false;
    }
    throw err;
  }
  return true;
}

async function readWorkspaceFileContent(
  workspaceDir: string,
  name: string,
): Promise<string | undefined> {
  try {
    const workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
    const safeRead = await workspaceRoot.read(name, {
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    return safeRead.buffer.toString("utf-8");
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "not-found") {
      return undefined;
    }
    throw err;
  }
}

async function buildIdentityMarkdownForWrite(params: {
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string> {
  let baseContent: string | undefined;
  if (params.preferFallbackWorkspaceContent && params.fallbackWorkspaceDir) {
    // Workspace moves may create a blank identity file; merge into the previous user-edited file.
    baseContent = await readWorkspaceFileContent(
      params.fallbackWorkspaceDir,
      DEFAULT_IDENTITY_FILENAME,
    );
    if (baseContent === undefined) {
      baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
    }
  } else {
    baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
    if (baseContent === undefined && params.fallbackWorkspaceDir) {
      baseContent = await readWorkspaceFileContent(
        params.fallbackWorkspaceDir,
        DEFAULT_IDENTITY_FILENAME,
      );
    }
  }

  return mergeIdentityMarkdownContent(baseContent, params.identity);
}

async function buildIdentityMarkdownOrRespondUnsafe(params: {
  respond: RespondFn;
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string | null> {
  try {
    return await buildIdentityMarkdownForWrite(params);
  } catch (err) {
    if (err instanceof FsSafeError) {
      respondWorkspaceFileUnsafe(params.respond, DEFAULT_IDENTITY_FILENAME);
      return null;
    }
    throw err;
  }
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": async ({ params, respond, context, client }) => {
    if (!validateAgentsListParams(params)) {
      respondInvalidMethodParams(respond, "agents.list", validateAgentsListParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const modelCatalog = await loadOptionalServerMethodModelCatalog(context, "agents.list", {
      logOnceKey: "agents.list",
    });
    const result = listAgentsForGateway(cfg, modelCatalog, {
      includeSystem: hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND),
    });
    respond(true, result, undefined);
  },
  "agents.create": async ({ params, respond }) => {
    if (!validateAgentsCreateParams(params)) {
      respondInvalidMethodParams(respond, "agents.create", validateAgentsCreateParams.errors);
      return;
    }

    const result = await createAgent({
      name: params.name,
      workspace: params.workspace,
      model: params.model,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    if (result.status === "error") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.message));
      return;
    }
    respond(
      true,
      {
        ok: true,
        agentId: result.agentId,
        name: result.name,
        workspace: result.workspace,
        ...(result.model ? { model: result.model } : {}),
      },
      undefined,
    );
  },
  "agents.update": async ({ params, respond, context }) => {
    if (!validateAgentsUpdateParams(params)) {
      respondInvalidMethodParams(respond, "agents.update", validateAgentsUpdateParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const agentId = normalizeAgentId(params.agentId);
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = params.model === null ? null : resolveOptionalStringParam(params.model);

    const safeName =
      typeof params.name === "string" && params.name.trim()
        ? sanitizeAgentIdentityLine(params.name.trim())
        : undefined;

    const identity = createAgentIdentityConfig({
      name: safeName,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    const hasIdentityFields = Boolean(identity);

    const agentConfigUpdate: Parameters<typeof updateAgentConfigEntry>[0] = {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(identity ? { identity } : {}),
    };
    const nextConfig = applyAgentConfig(cfg, agentConfigUpdate);

    let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      ensuredWorkspace = await ensureAgentWorkspace({
        dir: workspaceDir,
        ensureBootstrapFiles: !skipBootstrap,
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
    }

    const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
    if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
      const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
      const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const fallbackWorkspaceDir =
        workspaceDir && identityWorkspaceDir !== previousWorkspaceDir
          ? previousWorkspaceDir
          : undefined;
      const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
        respond,
        workspaceDir: identityWorkspaceDir,
        identity: persistedIdentity,
        fallbackWorkspaceDir,
        preferFallbackWorkspaceContent:
          Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true,
      });
      if (identityContent === null) {
        return;
      }
      if (
        !(await writeWorkspaceFileOrRespond({
          respond,
          workspaceDir: identityWorkspaceDir,
          name: DEFAULT_IDENTITY_FILENAME,
          content: identityContent,
        }))
      ) {
        return;
      }
    }

    try {
      await updateAgentConfigEntry(agentConfigUpdate);
    } catch (error) {
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!validateAgentsDeleteParams(params)) {
      respondInvalidMethodParams(respond, "agents.delete", validateAgentsDeleteParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const agentId = normalizeAgentId(params.agentId);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`),
      );
      return;
    }
    const existingJournal = readAgentDeletionJournal(agentId);
    if (
      !isConfiguredAgent(cfg, agentId) &&
      (!existingJournal || existingJournal.cleanupCompleted)
    ) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const requestedDeleteFiles =
      typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    try {
      const result = await withConfigMutationExclusive(async (lockedConfig) => {
        let lockedJournal = readAgentDeletionJournal(agentId);
        const configured = isConfiguredAgent(lockedConfig, agentId);
        if (!configured && (!lockedJournal || lockedJournal.cleanupCompleted)) {
          throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
        }
        if (configured && lockedJournal?.cleanupCompleted) {
          const claimed = claimCompletedAgentDeletion(agentId, lockedJournal.operationId);
          const remainingJournal = readAgentDeletionJournal(agentId);
          if (!claimed && remainingJournal) {
            throw new Error(`agent "${agentId}" deletion tombstone changed before fresh deletion`);
          }
          lockedJournal = undefined;
        }
        const deleteFiles = lockedJournal?.deleteFiles ?? requestedDeleteFiles;
        const deletion = beginAgentDeletion(
          lockedJournal ?? {
            agentId,
            agentDir: resolveAgentDir(lockedConfig, agentId),
            workspaceDir: resolveAgentWorkspaceDir(lockedConfig, agentId),
            sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
            deleteFiles,
          },
        );
        const journal = deletion.entry;
        let rosterCommitted = !configured;
        let committed: Awaited<ReturnType<typeof deleteAgentConfigEntry>> | undefined;
        let databasePlan: AgentDeleteDatabasePlan | undefined;
        try {
          prepareJournaledAgentDirOwnership(lockedConfig, agentId, journal.agentDir);
          databasePlan = prepareAgentDeleteDatabases(lockedConfig, agentId, journal.agentDir);
          deletion.fenceDatabasePaths([
            ...journal.databasePaths,
            ...databasePlan.fileGroups.flat(),
          ]);
          if (deleteFiles) {
            const fencedSourcePaths = new Set(
              journal.cleanupPaths.flatMap((cleanupPath) =>
                cleanupPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
              ),
            );
            const unfencedSourcePaths = [
              journal.workspaceDir,
              journal.agentDir,
              journal.sessionsDir,
              ...journal.databasePaths,
            ].filter((sourcePath) => !fencedSourcePaths.has(path.resolve(sourcePath)));
            if (unfencedSourcePaths.length > 0) {
              const unfencedSourcePathSet = new Set(
                unfencedSourcePaths.map((sourcePath) => path.resolve(sourcePath)),
              );
              const cleanupPlan = await prepareAgentDeleteCleanupPaths(
                unfencedSourcePaths,
                journal.cleanupPaths,
              );
              const unresolvedPath = cleanupPlan.find(
                (cleanupPath) =>
                  cleanupPath.preparationError !== undefined &&
                  cleanupPath.sourcePaths.some((sourcePath) =>
                    unfencedSourcePathSet.has(path.resolve(sourcePath)),
                  ),
              );
              if (unresolvedPath) {
                throw unresolvedPath.preparationError;
              }
              deletion.fenceCleanupPaths(
                cleanupPlan.map(
                  ({
                    path: cleanupPath,
                    trashPath,
                    parentPath,
                    kind,
                    preparedIdentity,
                    trashCoversDescendants,
                    done,
                    note,
                    sourcePaths,
                  }) => {
                    const journalPath: AgentDeletionJournalCleanupPath = {
                      path: cleanupPath,
                      canonicalPath: trashPath,
                      parentPath,
                      kind,
                      sourcePaths,
                      dev: preparedIdentity?.dev ?? null,
                      ino: preparedIdentity?.ino ?? null,
                      coversDescendants: trashCoversDescendants,
                      done,
                    };
                    if (note) {
                      journalPath.note = note;
                    }
                    return journalPath;
                  },
                ),
              );
            }
          }
          await context.cron.removeAgentJobsTransactional(
            agentId,
            async () =>
              await withAgentExecApprovalsRemoved(agentId, async () => {
                if (!rosterCommitted) {
                  try {
                    committed = await deleteAgentConfigEntry({ agentId });
                  } catch (error) {
                    try {
                      const persisted = await readConfigFileSnapshotForWrite();
                      if (!isConfiguredAgent(persisted.snapshot.sourceConfig, agentId)) {
                        rosterCommitted = true;
                        throw new AgentDeletionCommitUncertainError(error);
                      }
                    } catch (readError) {
                      if (readError instanceof AgentDeletionCommitUncertainError) {
                        throw readError;
                      }
                      throw new AgentDeletionCommitUncertainError(error);
                    }
                    throw error;
                  }
                  if (!committed.result) {
                    rosterCommitted = !isConfiguredAgent(committed.nextConfig, agentId);
                    const missingResultError = new Error(
                      "agent delete config mutation did not return its target",
                    );
                    if (rosterCommitted) {
                      throw new AgentDeletionCommitUncertainError(missingResultError);
                    }
                    throw missingResultError;
                  }
                  rosterCommitted = true;
                }
              }),
          );
          deletion.commit();
        } catch (error) {
          let canReleaseFence =
            !rosterCommitted &&
            !lockedJournal &&
            !(error instanceof AgentDeletionAuthorityRollbackError) &&
            !(error instanceof AgentDeletionCommitUncertainError);
          if (canReleaseFence) {
            try {
              const persisted = await readConfigFileSnapshotForWrite();
              canReleaseFence = isConfiguredAgent(persisted.snapshot.sourceConfig, agentId);
            } catch {
              canReleaseFence = false;
            }
          }
          if (canReleaseFence) {
            deletion.rollback();
          }
          throw error;
        }

        const deleteResult = committed?.result ?? {
          agentDir: journal.agentDir,
          workspaceDir: journal.workspaceDir,
          sessionsDir: journal.sessionsDir,
          removedBindings: 0,
        };
        const nextConfig = committed?.nextConfig ?? lockedConfig;

        // A journaled path is trash-eligible only while registry ownership still points at the
        // deleted agent; recovery must not consume a path claimed by a surviving agent.
        const agentDirRegistryPath = normalizeAgentDirRegistryPath(deleteResult.agentDir);
        await purgeAgentSessionStoreEntries(lockedConfig, agentId);

        const removed: AgentDeleteRemovedPath[] = [];
        const failed: AgentDeleteFailedPath[] = [];

        if (deleteFiles) {
          const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
            listOpenClawRegisteredAgentDatabases(),
            agentId,
          );
          const workspaceTrashEligible = !isPathOwnedBySurvivingAgent(
            nextConfig,
            agentId,
            deleteResult.workspaceDir,
            survivingDatabaseFilePaths,
          );
          // The config mutation lock and durable journal fence block new roster and database
          // claims across this final ownership recheck and the filesystem cleanup below.
          const agentDirTrashEligible =
            resolveRegisteredAgentIdForDir(deleteResult.agentDir) === agentId &&
            !isPathOwnedBySurvivingAgent(
              nextConfig,
              agentId,
              deleteResult.agentDir,
              survivingDatabaseFilePaths,
            );
          const sessionsDirTrashEligible = !isPathOwnedBySurvivingAgent(
            nextConfig,
            agentId,
            deleteResult.sessionsDir,
            survivingDatabaseFilePaths,
          );
          const databaseFilePaths = [
            ...(agentDirTrashEligible
              ? (databasePlan?.relocatedFileGroups ?? [])
              : (databasePlan?.fileGroups ?? [])
            ).flat(),
            ...journal.databasePaths,
          ].filter(
            (pathname) =>
              !isPathOwnedBySurvivingAgent(
                nextConfig,
                agentId,
                pathname,
                survivingDatabaseFilePaths,
              ),
          );
          const eligibleSourcePaths = new Set(
            [
              ...(workspaceTrashEligible ? [deleteResult.workspaceDir] : []),
              ...(agentDirTrashEligible ? [deleteResult.agentDir] : []),
              ...(sessionsDirTrashEligible ? [deleteResult.sessionsDir] : []),
              ...databaseFilePaths,
            ].map((sourcePath) => path.resolve(sourcePath)),
          );
          const cleanupPaths = (
            await prepareAgentDeleteCleanupPaths([], journal.cleanupPaths)
          ).filter(
            (cleanupPath) =>
              cleanupPath.sourcePaths.some((sourcePath) => eligibleSourcePaths.has(sourcePath)) &&
              (agentDirTrashEligible ||
                !cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath)),
          );
          const workspaceCanonicalPath = normalizeAgentDirRegistryPath(deleteResult.workspaceDir);
          const workspaceCleanupPaths = cleanupPaths.filter((cleanupPath) =>
            cleanupPathCovers(cleanupPath, deleteResult.workspaceDir, workspaceCanonicalPath),
          );
          const legacyPlan =
            workspaceCleanupPaths.length > 0
              ? prepareLegacyWorkspaceStateReset(deleteResult.workspaceDir)
              : undefined;
          const statePlan =
            workspaceCleanupPaths.length > 0
              ? prepareWorkspaceStateDeletion(deleteResult.workspaceDir)
              : undefined;
          const outcomes: Array<{
            cleanupPath: AgentDeleteCleanupPath;
            outcome: AgentDeletePathOutcome;
          }> = [];
          const completedCleanupPaths = new Set(
            cleanupPaths.filter((cleanupPath) => cleanupPath.done),
          );
          const markCleanupPathDone = (cleanupPath: AgentDeleteCleanupPath, note?: string) => {
            const canonicalPath = path.resolve(cleanupPath.trashPath);
            deletion.fenceCleanupPaths(
              journal.cleanupPaths.map((entry) => {
                if (
                  path.resolve(entry.canonicalPath) !== canonicalPath ||
                  entry.kind !== cleanupPath.kind
                ) {
                  return entry;
                }
                const updated = Object.assign({}, entry, { done: true });
                if (note) {
                  updated.note = note;
                }
                return updated;
              }),
            );
            cleanupPath.done = true;
            cleanupPath.note = note;
            completedCleanupPaths.add(cleanupPath);
          };
          const protectedCleanupPaths: Array<{
            cleanupPath: AgentDeleteCleanupPath;
            protectAliases: boolean;
            terminal: boolean;
            note?: string;
          }> = [];
          for (const cleanupPath of cleanupPaths) {
            if (cleanupPath.done) {
              let replacementPresent = true;
              let note =
                cleanupPath.note ?? "completed cleanup path is occupied; replacement preserved";
              try {
                await statAgentCleanupPath(cleanupPath);
              } catch (error) {
                if (isMissingCleanupPathError(error)) {
                  replacementPresent = false;
                } else if (!(error instanceof AgentCleanupIdentityMismatchError)) {
                  note = "completed cleanup path could not be verified; replacement preserved";
                }
              }
              if (replacementPresent) {
                markCleanupPathDone(cleanupPath, note);
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: true,
                  note,
                });
              }
              continue;
            }
            const refreshedDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
              listOpenClawRegisteredAgentDatabases(),
              agentId,
            );
            const blockingProtection = protectedCleanupPaths.find(
              ({ cleanupPath: protectedPath, protectAliases }) =>
                ((cleanupPath.kind !== "symlink" || protectAliases) &&
                  (protectedPath.canonicalPath === cleanupPath.canonicalPath ||
                    isPathInside(cleanupPath.canonicalPath, protectedPath.canonicalPath))) ||
                [
                  protectedPath.trashPath,
                  ...(protectAliases ? protectedPath.sourcePaths : []),
                ].some(
                  (protectedSourcePath) =>
                    protectedSourcePath === cleanupPath.trashPath ||
                    isPathInside(cleanupPath.trashPath, protectedSourcePath),
                ),
            );
            const ownedBySurvivor =
              isPathOwnedBySurvivingAgent(
                nextConfig,
                agentId,
                cleanupPath.path,
                refreshedDatabaseFilePaths,
              ) ||
              (cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath) &&
                resolveRegisteredAgentIdForDir(deleteResult.agentDir) !== agentId);
            if (blockingProtection || ownedBySurvivor) {
              const terminal = ownedBySurvivor || blockingProtection?.terminal === true;
              const note = ownedBySurvivor
                ? "replacement owned by a surviving agent"
                : blockingProtection?.note;
              if (terminal) {
                markCleanupPathDone(cleanupPath, note ?? "protected replacement preserved");
              }
              protectedCleanupPaths.push({
                cleanupPath,
                protectAliases: blockingProtection?.protectAliases ?? false,
                terminal,
                note,
              });
              continue;
            }
            const outcome = cleanupPath.preparationError
              ? cleanupFailure(cleanupPath.path, cleanupPath.preparationError)
              : await removeAgentPath(cleanupPath);
            outcomes.push({
              cleanupPath,
              outcome,
            });
            if ("removed" in outcome) {
              markCleanupPathDone(cleanupPath);
            } else if ("skipped" in outcome) {
              markCleanupPathDone(cleanupPath, outcome.skipped.reason);
              protectedCleanupPaths.push({
                cleanupPath,
                protectAliases: true,
                terminal: true,
                note: outcome.skipped.reason,
              });
            } else {
              protectedCleanupPaths.push({
                cleanupPath,
                protectAliases: true,
                terminal: false,
              });
            }
          }
          for (const { outcome } of outcomes) {
            if ("removed" in outcome) {
              removed.push(outcome.removed);
            } else if ("failed" in outcome) {
              failed.push(outcome.failed);
            }
          }
          if (
            workspaceCleanupPaths.length > 0 &&
            workspaceCleanupPaths.every((cleanupPath) => completedCleanupPaths.has(cleanupPath)) &&
            legacyPlan &&
            statePlan
          ) {
            try {
              await removeLegacyWorkspaceStateForReset(legacyPlan);
              deleteWorkspaceState(statePlan);
            } catch {
              // Best-effort cleanup. A later explicit reset can remove stale rows.
            }
          }
          const agentDirCleanupPaths = cleanupPaths.filter((cleanupPath) =>
            cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath),
          );
          if (
            agentDirCleanupPaths.length > 0 &&
            agentDirCleanupPaths.every((cleanupPath) => completedCleanupPaths.has(cleanupPath))
          ) {
            unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
          }
        }
        if (failed.length === 0) {
          unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
          if (deleteFiles) {
            unregisterAgentDeleteDatabases(agentId, databasePlan?.registrationPaths ?? []);
          }
          deletion.finish();
        }
        return {
          ok: true,
          agentId,
          removedBindings: deleteResult.removedBindings,
          removed,
          failed,
        };
      });
      respond(true, result, undefined);
    } catch (error) {
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }
  },
  "agents.files.list": async ({ params, respond, context }) => {
    if (!validateAgentsFilesListParams(params)) {
      respondInvalidMethodParams(
        respond,
        "agents.files.list",
        validateAgentsFilesListParams.errors,
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = resolveAgentIdOrError(params.agentId, cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await agentsHandlerDeps.isWorkspaceSetupCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond, context }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    let safeRead: ReadResult;
    try {
      const workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
      safeRead = await workspaceRoot.read(name, {
        hardlinks: "reject",
        nonBlockingRead: true,
      });
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "not-found") {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      if (err instanceof FsSafeError) {
        respondWorkspaceFileUnsafe(respond, name);
        return;
      }
      throw err;
    }
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
          content: safeRead.buffer.toString("utf-8"),
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond, context }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const content = params.content;
    let workspaceRoot: WorkspaceRoot;
    try {
      workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
      await workspaceRoot.write(name, content, { encoding: "utf8" });
    } catch (err) {
      if (!(err instanceof FsSafeError)) {
        throw err;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
};
export { testing as __testing };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
