// Agents gateway methods expose agent listing, config mutation, workspace file
// reads/writes, identity merging, and safe deletion for operator clients.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
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
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
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
import { purgeAgentSessionStoreEntries } from "../../config/sessions.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
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
  | { failed: AgentDeleteFailedPath };

function cleanupFailure(pathname: string, error: unknown): AgentDeletePathOutcome {
  const reason = error instanceof Error && error.message ? error.message : String(error);
  return { failed: { path: pathname, reason: reason || "unknown error" } };
}

async function removeAgentPath(pathname: string): Promise<AgentDeletePathOutcome> {
  try {
    await fs.lstat(pathname);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { removed: { path: pathname, method: "missing" } }
      : cleanupFailure(pathname, error);
  }
  try {
    await movePathToTrash(pathname);
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    return cleanupFailure(pathname, error);
  }
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
  "agents.list": async ({ params, respond, context }) => {
    if (!validateAgentsListParams(params)) {
      respondInvalidMethodParams(respond, "agents.list", validateAgentsListParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const modelCatalog = await loadOptionalServerMethodModelCatalog(context, "agents.list", {
      logOnceKey: "agents.list",
    });
    const result = listAgentsForGateway(cfg, modelCatalog);
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
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    let committed: Awaited<ReturnType<typeof deleteAgentConfigEntry>>;
    try {
      committed = await deleteAgentConfigEntry({ agentId });
    } catch (error) {
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }
    const deleteResult = committed.result;
    if (!deleteResult) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "agent delete did not commit"));
      return;
    }

    // Purge session store entries so orphaned sessions cannot be targeted (#65524).
    await purgeAgentSessionStoreEntries(cfg, agentId);

    const removed: AgentDeleteRemovedPath[] = [];
    const failed: AgentDeleteFailedPath[] = [];
    const recordOutcome = (outcome: AgentDeletePathOutcome) => {
      if ("removed" in outcome) {
        removed.push(outcome.removed);
      } else {
        failed.push(outcome.failed);
      }
    };

    if (deleteFiles) {
      const workspaceSharedWith = findOverlappingWorkspaceAgentIds(
        committed.nextConfig,
        agentId,
        deleteResult.workspaceDir,
      );
      const deleteWorkspace = workspaceSharedWith.length === 0;
      if (deleteWorkspace) {
        const legacyPlan = prepareLegacyWorkspaceStateReset(deleteResult.workspaceDir);
        const statePlan = prepareWorkspaceStateDeletion(deleteResult.workspaceDir);
        const workspaceOutcome = await removeAgentPath(deleteResult.workspaceDir);
        recordOutcome(workspaceOutcome);
        if ("removed" in workspaceOutcome) {
          try {
            await removeLegacyWorkspaceStateForReset(legacyPlan);
            deleteWorkspaceState(statePlan);
          } catch {
            // Best-effort cleanup. A later explicit reset can remove stale rows.
          }
        }
      }
      const stateOutcomes = await Promise.all(
        [deleteResult.agentDir, deleteResult.sessionsDir].map(removeAgentPath),
      );
      stateOutcomes.forEach(recordOutcome);
    }

    respond(
      true,
      { ok: true, agentId, removedBindings: deleteResult.removedBindings, removed, failed },
      undefined,
    );
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
