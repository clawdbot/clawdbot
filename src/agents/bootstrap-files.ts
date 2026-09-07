/**
 * Resolves workspace bootstrap files for agent runs and converts them into
 * bounded context files.
 */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import { readRecentSessionTranscriptActiveEvents } from "../config/sessions/session-accessor.js";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMemoryOriginEligibleForAutomaticInjection } from "../memory-host-sdk/host/types.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { BootstrapContextRunKind } from "./bootstrap-mode.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession,
  isWorkspaceSetupCompleted,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";

const CONTINUATION_SCAN_MAX_RECORDS = 500;
export const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const BOOTSTRAP_WARNING_DEDUPE_LIMIT = 1024;
const seenBootstrapWarnings = new Set<string>();
const bootstrapWarningOrder: string[] = [];

function rememberBootstrapWarning(key: string): boolean {
  // Warning keys include workspace/session/message so repeated setup failures
  // stay quiet without hiding distinct bootstrap problems.
  if (seenBootstrapWarnings.has(key)) {
    return false;
  }
  if (seenBootstrapWarnings.size >= BOOTSTRAP_WARNING_DEDUPE_LIMIT) {
    const oldest = bootstrapWarningOrder.shift();
    if (oldest) {
      seenBootstrapWarnings.delete(oldest);
    }
  }
  seenBootstrapWarnings.add(key);
  bootstrapWarningOrder.push(key);
  return true;
}

/** Resolves the effective bootstrap injection mode for a session agent. */
export function resolveContextInjectionMode(
  config?: OpenClawConfig,
  agentId?: string | null,
): AgentContextInjection {
  const agentMode =
    config && agentId ? resolveAgentConfig(config, agentId)?.contextInjection : undefined;
  if (agentMode === "always" || agentMode === "continuation-skip" || agentMode === "never") {
    return agentMode;
  }
  return config?.agents?.defaults?.contextInjection ?? "always";
}

/** Checks the active SQLite transcript branch for a valid full-bootstrap marker. */
export async function hasCompletedBootstrapTurn(
  sessionTarget?: AgentRunSessionTarget,
): Promise<boolean> {
  const { agentId, sessionId, sessionKey, storePath } = sessionTarget ?? {};
  if (!agentId || !sessionId || !sessionKey || !storePath) {
    return false;
  }
  try {
    const records = readRecentSessionTranscriptActiveEvents(
      { agentId, sessionId, sessionKey, storePath },
      CONTINUATION_SCAN_MAX_RECORDS,
    );
    for (const entry of records.toReversed()) {
      const record = entry as { type?: string; customType?: string } | null | undefined;
      // Context before compaction/reset is not reusable on the active branch.
      if (record?.type === "compaction" || record?.type === "reset") {
        return false;
      }
      if (record?.type === "custom" && record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Builds a session-scoped warning sink that dedupes repeated bootstrap warnings. */
export function makeBootstrapWarn(params: {
  sessionLabel: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  const warn = params.warn;
  if (!warn) {
    return undefined;
  }
  const workspacePrefix = params.workspaceDir ?? "";
  return (message: string) => {
    const key = `${workspacePrefix}\u0000${params.sessionLabel}\u0000${message}`;
    if (!rememberBootstrapWarning(key)) {
      return;
    }
    warn(`${message} (sessionKey=${params.sessionLabel})`);
  };
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  workspaceDir: string,
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const workspaceRoot = resolveUserPath(workspaceDir);
  const seenPaths = new Set<string>();
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    const resolvedPath = path.isAbsolute(pathValue)
      ? path.resolve(pathValue)
      : pathValue.startsWith("~")
        ? resolveUserPath(pathValue)
        : path.resolve(workspaceRoot, pathValue);
    const dedupeKey = path.normalize(path.relative(workspaceRoot, resolvedPath));
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);
    sanitized.push({ ...file, path: resolvedPath });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  if (contextMode !== "lightweight") {
    return params.files;
  }
  // Heartbeat scratch is injected by the heartbeat runner, not bootstrap files.
  // Cron/default lightweight mode also keeps bootstrap context empty on purpose.
  return [];
}

function filterCompletedWorkspaceBootstrapFile(
  files: WorkspaceBootstrapFile[],
  setupCompleted: boolean,
  workspaceDir: string,
): WorkspaceBootstrapFile[] {
  if (!setupCompleted) {
    return files;
  }
  const workspaceRoot = resolveUserPath(workspaceDir);
  const rootBootstrapPath = path.join(workspaceRoot, DEFAULT_BOOTSTRAP_FILENAME);
  return files.filter((file) => {
    if (file.name !== DEFAULT_BOOTSTRAP_FILENAME) {
      return true;
    }
    const pathValue = normalizeOptionalString(file.path);
    if (!pathValue) {
      return true;
    }
    const resolvedPath = path.isAbsolute(pathValue)
      ? path.resolve(pathValue)
      : pathValue.startsWith("~")
        ? resolveUserPath(pathValue)
        : path.resolve(workspaceRoot, pathValue);
    return resolvedPath !== rootBootstrapPath;
  });
}

async function isWorkspaceSetupCompletedForContext(
  workspaceDir: string,
  readOnlyState = false,
): Promise<boolean> {
  try {
    return await isWorkspaceSetupCompleted(workspaceDir, readOnlyState ? { readOnly: true } : {});
  } catch {
    return false;
  }
}

function filterBootstrapFilesAfterHooks(params: {
  files: WorkspaceBootstrapFile[];
  session: {
    sessionKey?: string;
    chatType?: ChatType;
    workspaceDir: string;
  };
  protectedFiles?: WorkspaceBootstrapFile[];
}): WorkspaceBootstrapFile[] {
  const sessionFiltered = filterBootstrapFilesForSession(params.files, params.session);
  const protectedFiles = params.protectedFiles ?? [];
  if (protectedFiles.length === 0) {
    return sessionFiltered;
  }
  // Hooks can relabel or alias loader-produced records. Reapply lexical/session
  // policy first, then enforce protected sources captured by the pinned opens.
  return sessionFiltered.filter(
    (file) =>
      !protectedFiles.some((protectedFile) => {
        if (workspaceFilesShareSourceIdentity(file, protectedFile)) {
          return true;
        }
        const filePath = normalizeOptionalString(file.path);
        const protectedPath = normalizeOptionalString(protectedFile.path);
        return Boolean(
          filePath && protectedPath && path.resolve(filePath) === path.resolve(protectedPath),
        );
      }),
  );
}

async function resolveIneligibleAutomaticMemoryFiles(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]> {
  const candidates = params.files.filter(
    (file) =>
      !file.missing &&
      (file.name === DEFAULT_MEMORY_FILENAME || file.name === DEFAULT_USER_FILENAME),
  );
  if (candidates.length === 0 || !params.config) {
    return [];
  }
  let agentId: string;
  try {
    agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  } catch (error) {
    params.warn?.(`excluding automatic memory context: ${String(error)}`);
    return candidates;
  }
  const relativePaths = candidates.map((file) =>
    path.relative(resolveUserPath(params.workspaceDir), file.path).replaceAll(path.sep, "/"),
  );
  let classificationResult: Awaited<ReturnType<typeof classifyActiveMemoryWorkspacePaths>>;
  try {
    classificationResult = await classifyActiveMemoryWorkspacePaths({
      cfg: params.config,
      agentId,
      workspaceDir: params.workspaceDir,
      relativePaths,
    });
  } catch (error) {
    params.warn?.(`excluding automatic memory context: ${String(error)}`);
    return candidates;
  }
  if (classificationResult.status === "unavailable") {
    return [];
  }
  if (classificationResult.status === "unsupported") {
    params.warn?.(
      "excluding automatic memory context: selected memory runtime does not support provenance classification",
    );
    return candidates;
  }
  const origins = new Map(
    classificationResult.classifications.map((entry) => [entry.relativePath, entry.originClass]),
  );
  return candidates.filter(
    (_file, index) =>
      !isMemoryOriginEligibleForAutomaticInjection(origins.get(relativePaths[index]!)),
  );
}

/** Resolves hook-adjusted, session-filtered bootstrap files for a run. */
type BootstrapFileResolutionParams = {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  chatType?: ChatType;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  readOnlyState?: boolean;
};

// Diagnostics project declared files without executing registered hook handlers.
type BootstrapHookApplication = "none" | "registered" | { projected: WorkspaceBootstrapFile[] };

/** Prepare the same bounded workspace facts without invoking run-owned bootstrap hooks. */
export async function resolveBootstrapFilesForPreparation(
  params: BootstrapFileResolutionParams,
): Promise<WorkspaceBootstrapFile[]> {
  return resolveBootstrapFiles({ ...params, readOnlyState: true }, "none");
}

export async function resolveBootstrapFilesForRun(
  params: BootstrapFileResolutionParams,
): Promise<WorkspaceBootstrapFile[]> {
  return resolveBootstrapFiles(params, "registered");
}

async function resolveBootstrapFiles(
  params: BootstrapFileResolutionParams,
  hooks: BootstrapHookApplication,
): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const session = {
    sessionKey,
    chatType: params.chatType,
    workspaceDir: params.workspaceDir,
  };
  const workspaceSetupCompleted = await isWorkspaceSetupCompletedForContext(
    params.workspaceDir,
    params.readOnlyState,
  );
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const ineligibleAutomaticMemoryFiles = await resolveIneligibleAutomaticMemoryFiles({
    files: rawFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    warn: params.warn,
  });
  const rootMemoryFile = rawFiles.find(
    (file) => file.name === DEFAULT_MEMORY_FILENAME && !file.missing,
  );
  const protectedRootMemoryFile =
    rootMemoryFile && filterBootstrapFilesForSession([rootMemoryFile], session).length === 0
      ? rootMemoryFile
      : undefined;
  const protectedFiles = [
    ...(protectedRootMemoryFile ? [protectedRootMemoryFile] : []),
    ...ineligibleAutomaticMemoryFiles,
  ];
  const bootstrapFiles = applyContextModeFilter({
    files: filterCompletedWorkspaceBootstrapFile(
      filterBootstrapFilesForSession(rawFiles, session).filter(
        (file) =>
          !ineligibleAutomaticMemoryFiles.some((ineligible) =>
            workspaceFilesShareSourceIdentity(file, ineligible),
          ),
      ),
      workspaceSetupCompleted,
      params.workspaceDir,
    ),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const hooked =
    hooks === "registered"
      ? await applyBootstrapHookOverrides({
          files: bootstrapFiles,
          workspaceDir: params.workspaceDir,
          config: params.config,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : bootstrapFiles;
  const updated = typeof hooks === "object" ? [...hooked, ...hooks.projected] : hooked;
  const filteredUpdated = filterCompletedWorkspaceBootstrapFile(
    filterBootstrapFilesAfterHooks({
      files: updated,
      session,
      protectedFiles,
    }),
    workspaceSetupCompleted,
    params.workspaceDir,
  );
  return sanitizeBootstrapFiles(filteredUpdated, params.workspaceDir, params.warn);
}

/** Resolves both raw bootstrap metadata and bounded context files for a run. */
export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  chatType?: ChatType;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  readOnlyState?: boolean;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, params);
  return { bootstrapFiles, contextFiles };
}

/** Applies declared additions through the normal bootstrap filters and budgets. */
export async function resolveBootstrapContextWithProjectedHookFiles(
  params: Pick<BootstrapFileResolutionParams, "workspaceDir" | "config" | "agentId">,
  projected: WorkspaceBootstrapFile[],
): ReturnType<typeof resolveBootstrapContextForRun> {
  const bootstrapFiles = await resolveBootstrapFiles(
    { ...params, readOnlyState: true },
    { projected },
  );
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, params);
  return { bootstrapFiles, contextFiles };
}

/** Builds bounded context files from already-resolved bootstrap file metadata. */
export function buildBootstrapContextForFiles(
  bootstrapFiles: WorkspaceBootstrapFile[],
  params: {
    config?: OpenClawConfig;
    agentId?: string | null;
    warn?: (message: string) => void;
  },
): EmbeddedContextFile[] {
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config, params.agentId),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config, params.agentId),
    warn: params.warn,
  });
  return contextFiles;
}
