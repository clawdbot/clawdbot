/**
 * Resolves workspace bootstrap files for agent runs and converts them into
 * bounded context files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { BootstrapContextRunKind } from "./bootstrap-mode.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  filterBootstrapFilesForSession,
  isWorkspaceSetupCompleted,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";

const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
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

/** Checks whether the session transcript still has a valid full-bootstrap marker. */
export async function hasCompletedBootstrapTurn(sessionFile: string): Promise<boolean> {
  if (!path.isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) {
    return false;
  }
  try {
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const bytesToRead = Math.min(stat.size, CONTINUATION_SCAN_MAX_TAIL_BYTES);
      if (bytesToRead <= 0) {
        return false;
      }
      const start = stat.size - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = await readFileWindowFully(fh, buffer, start);
      let text = buffer.toString("utf-8", 0, bytesRead);
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) {
          return false;
        }
        text = text.slice(firstNewline + 1);
      }

      const records = text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .slice(-CONTINUATION_SCAN_MAX_RECORDS);
      let compactedAfterLatestAssistant = false;

      for (let i = records.length - 1; i >= 0; i--) {
        // Only the tail matters: compaction after the marker makes earlier
        // bootstrap context unreliable for continuation prompts.
        const line = records[i];
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as
          | {
              type?: string;
              customType?: string;
              message?: { role?: string };
            }
          | null
          | undefined;
        if (record?.type === "compaction" || record?.type === "reset") {
          compactedAfterLatestAssistant = true;
          continue;
        }
        if (
          record?.type === "custom" &&
          record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE
        ) {
          return !compactedAfterLatestAssistant;
        }
      }

      return false;
    } finally {
      await fh.close();
    }
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

async function isWorkspaceSetupCompletedForContext(workspaceDir: string): Promise<boolean> {
  try {
    return await isWorkspaceSetupCompleted(workspaceDir);
  } catch {
    return false;
  }
}

/** Resolves hook-adjusted, session-filtered bootstrap files for a run. */
export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const workspaceSetupCompleted = await isWorkspaceSetupCompletedForContext(params.workspaceDir);
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = applyContextModeFilter({
    files: filterCompletedWorkspaceBootstrapFile(
      filterBootstrapFilesForSession(rawFiles, sessionKey),
      workspaceSetupCompleted,
      params.workspaceDir,
    ),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  const filteredUpdated = filterCompletedWorkspaceBootstrapFile(
    updated,
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
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
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
