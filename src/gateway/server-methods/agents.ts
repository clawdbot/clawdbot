import fs from "node:fs/promises";
import path from "node:path";
import { findOverlappingWorkspaceAgentIds } from "../../agents/agent-delete-safety.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { mergeIdentityMarkdownContent } from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
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
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { replaceConfigFile } from "../../config/config.js";
import {
  purgeAgentSessionStoreEntries,
  resolveSessionTranscriptsDirForAgent,
} from "../../config/sessions.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sameFileIdentity } from "../../infra/file-identity.js";
import {
  openFileWithinRoot,
  readFileWithinRoot,
  SafeOpenError,
  writeFileWithinRoot,
} from "../../infra/fs-safe.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
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
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
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
  isWorkspaceSetupCompleted,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
};

export const __testing = {
  setDepsForTests(
    overrides: Partial<{
      isWorkspaceSetupCompleted: typeof isWorkspaceSetupCompleted;
      openFileWithinRoot: typeof openFileWithinRoot;
      readFileWithinRoot: typeof readFileWithinRoot;
      writeFileWithinRoot: typeof writeFileWithinRoot;
    }>,
  ) {
    Object.assign(agentsHandlerDeps, overrides);
  },
  resetDepsForTests() {
    agentsHandlerDeps.isWorkspaceSetupCompleted = isWorkspaceSetupCompleted;
    agentsHandlerDeps.openFileWithinRoot = openFileWithinRoot;
    agentsHandlerDeps.readFileWithinRoot = readFileWithinRoot;
    agentsHandlerDeps.writeFileWithinRoot = writeFileWithinRoot;
  },
};

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME] as const;

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

function isPathInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function statWorkspaceFileSafely(
  workspaceDir: string,
  name: string,
): Promise<FileMeta | null> {
  try {
    const workspaceReal = await fs.realpath(workspaceDir);
    const candidatePath = path.resolve(workspaceReal, name);
    if (!isPathInsideDirectory(workspaceReal, candidatePath)) {
      return null;
    }

    const pathStat = await fs.lstat(candidatePath);
    if (!pathStat.isFile() || pathStat.nlink > 1) {
      return null;
    }

    const realPath = await fs.realpath(candidatePath);
    if (!isPathInsideDirectory(workspaceReal, realPath)) {
      return null;
    }

    const realStat = await fs.stat(realPath);
    if (!realStat.isFile() || realStat.nlink > 1 || !sameFileIdentity(pathStat, realStat)) {
      return null;
    }

    return {
      size: realStat.size,
      updatedAtMs: Math.floor(realStat.mtimeMs),
    };
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

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statWorkspaceFileSafely(workspaceDir, name);
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

  const primaryMeta = await statWorkspaceFileSafely(workspaceDir, DEFAULT_MEMORY_FILENAME);
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

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOptionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

async function moveToTrashBestEffort(pathname: string): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await movePathToTrash(pathname);
  } catch {
    // Best-effort: path may already be gone or trash unavailable.
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
    await agentsHandlerDeps.writeFileWithinRoot({
      rootDir: params.workspaceDir,
      relativePath: params.name,
      data: params.content,
      encoding: "utf8",
    });
  } catch (err) {
    if (err instanceof SafeOpenError) {
      respondWorkspaceFileUnsafe(params.respond, params.name);
      return false;
    }
    throw err;
  }
  return true;
}

function normalizeIdentityForFile(
  identity: IdentityConfig | undefined,
): IdentityConfig | undefined {
  if (!identity) {
    return undefined;
  }
  const resolved = {
    name: identity.name?.trim() || undefined,
    theme: identity.theme?.trim() || undefined,
    emoji: identity.emoji?.trim() || undefined,
    avatar: identity.avatar?.trim() || undefined,
  } satisfies IdentityConfig;
  if (!resolved.name && !resolved.theme && !resolved.emoji && !resolved.avatar) {
    return undefined;
  }
  return resolved;
}

async function readWorkspaceFileContent(
  workspaceDir: string,
  name: string,
): Promise<string | undefined> {
  try {
    const safeRead = await agentsHandlerDeps.readFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: name,
      rejectHardlinks: true,
      nonBlockingRead: true,
    });
    return safeRead.buffer.toString("utf-8");
  } catch (err) {
    if (err instanceof SafeOpenError && err.code === "not-found") {
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
    if (err instanceof SafeOpenError) {
      respondWorkspaceFileUnsafe(params.respond, DEFAULT_IDENTITY_FILENAME);
      return null;
    }
    throw err;
  }
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond, context }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "agents.create": async ({ params, respond, context }) => {
    if (!validateAgentsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.create params: ${formatValidationErrors(
            validateAgentsCreateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const rawName = params.name.trim();
    const agentId = normalizeAgentId(rawName);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    const workspaceDir = resolveUserPath(params.workspace.trim());

    const safeName = sanitizeIdentityLine(rawName);
    const model = resolveOptionalStringParam(params.model);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);

    const identity = {
      name: safeName,
      ...(emoji ? { emoji: sanitizeIdentityLine(emoji) } : {}),
      ...(avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}),
    };

    // Resolve agentDir against the config we're about to persist (vs the pre-write config),
    // so subsequent resolutions can't disagree about the agent's directory.
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: safeName,
      workspace: workspaceDir,
      model,
      identity,
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace & transcripts exist BEFORE writing config so a failure
    // here does not leave a broken config entry behind.
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({
      dir: workspaceDir,
      ensureBootstrapFiles: !skipBootstrap,
      skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
    });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
    if (persistedIdentity) {
      const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
        respond,
        workspaceDir,
        identity: persistedIdentity,
      });
      if (identityContent === null) {
        return;
      }
      if (
        !(await writeWorkspaceFileOrRespond({
          respond,
          workspaceDir,
          name: DEFAULT_IDENTITY_FILENAME,
          content: identityContent,
        }))
      ) {
        return;
      }
    }
    await replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
    });

    respond(true, { ok: true, agentId, name: safeName, workspace: workspaceDir, model }, undefined);
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

    const model = resolveOptionalStringParam(params.model);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);

    const safeName =
      typeof params.name === "string" && params.name.trim()
        ? sanitizeIdentityLine(params.name.trim())
        : undefined;

    const hasIdentityFields = Boolean(safeName || emoji || avatar);
    const identity = hasIdentityFields
      ? {
          ...(safeName ? { name: safeName } : {}),
          ...(emoji ? { emoji: sanitizeIdentityLine(emoji) } : {}),
          ...(avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}),
        }
      : undefined;

    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model ? { model } : {}),
      ...(identity ? { identity } : {}),
    });

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

    await replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
    });

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
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

    const result = pruneAgentConfig(cfg, agentId);
    await replaceConfigFile({
      nextConfig: result.config,
      afterWrite: { mode: "auto" },
    });

    // Purge session store entries so orphaned sessions cannot be targeted (#65524).
    await purgeAgentSessionStoreEntries(cfg, agentId);

    if (deleteFiles) {
      const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
      const deleteWorkspace = workspaceSharedWith.length === 0;
      await Promise.all([
        ...(deleteWorkspace ? [moveToTrashBestEffort(workspaceDir)] : []),
        moveToTrashBestEffort(agentDir),
        moveToTrashBestEffort(sessionsDir),
      ]);
    }

    respond(true, { ok: true, agentId, removedBindings: result.removedBindings }, undefined);
  },
  "agents.files.list": async ({ params, respond, context }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
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
    let safeRead: Awaited<ReturnType<typeof readFileWithinRoot>>;
    try {
      safeRead = await agentsHandlerDeps.readFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: name,
        rejectHardlinks: true,
        nonBlockingRead: true,
      });
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "not-found") {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      if (err instanceof SafeOpenError) {
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
    try {
      await agentsHandlerDeps.writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: name,
        data: content,
        encoding: "utf8",
      });
    } catch (err) {
      if (!(err instanceof SafeOpenError)) {
        throw err;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    const meta = await statWorkspaceFileSafely(workspaceDir, name);
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
