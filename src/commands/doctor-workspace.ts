import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  LEGACY_ROOT_MEMORY_FILENAME,
  resolveCanonicalRootMemoryPath,
  resolveLegacyRootMemoryPath,
  resolveRootMemoryRepairDir,
} from "../memory/root-memory-files.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const entries = await listWorkspaceEntries(workspaceDir);
  if (entries.has(CANONICAL_ROOT_MEMORY_FILENAME)) {
    try {
      const stat = await fs.promises.stat(resolveCanonicalRootMemoryPath(workspaceDir));
      if (stat.isFile()) {
        return false;
      }
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    const content = await fs.promises.readFile(agentsPath, "utf-8");
    if (new RegExp(`\\b${CANONICAL_ROOT_MEMORY_FILENAME.replace(".", "\\.")}\\b`).test(content)) {
      return false;
    }
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

export type LegacyWorkspaceDetection = {
  activeWorkspace: string;
  legacyDirs: string[];
};

export function detectLegacyWorkspaceDirs(params: {
  workspaceDir: string;
}): LegacyWorkspaceDetection {
  const activeWorkspace = path.resolve(params.workspaceDir);
  const legacyDirs: string[] = [];
  return { activeWorkspace, legacyDirs };
}

export function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string {
  return [
    "Extra workspace directories detected (may contain old agent files):",
    ...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
    `Active workspace: ${shortenHomePath(detection.activeWorkspace)}`,
    "If unused, archive or move to Trash.",
  ].join("\n");
}

export type RootMemoryFilesDetection = {
  workspaceDir: string;
  canonicalPath: string;
  legacyPath: string;
  canonicalExists: boolean;
  legacyExists: boolean;
  canonicalBytes?: number;
  legacyBytes?: number;
};

type RootMemoryStatResult = {
  exists: boolean;
  bytes?: number;
};

async function statIfExists(filePath: string): Promise<RootMemoryStatResult> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return { exists: false };
    }
    return { exists: true, bytes: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function listWorkspaceEntries(workspaceDir: string): Promise<Set<string>> {
  try {
    return new Set(await fs.promises.readdir(workspaceDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new Set<string>();
    }
    throw err;
  }
}

export async function detectRootMemoryFiles(
  workspaceDir: string,
): Promise<RootMemoryFilesDetection> {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const canonicalPath = resolveCanonicalRootMemoryPath(resolvedWorkspace);
  const legacyPath = resolveLegacyRootMemoryPath(resolvedWorkspace);
  const entries = await listWorkspaceEntries(resolvedWorkspace);
  const [canonical, legacy] = await Promise.all([
    entries.has(CANONICAL_ROOT_MEMORY_FILENAME)
      ? statIfExists(canonicalPath)
      : Promise.resolve<RootMemoryStatResult>({ exists: false }),
    entries.has(LEGACY_ROOT_MEMORY_FILENAME)
      ? statIfExists(legacyPath)
      : Promise.resolve<RootMemoryStatResult>({ exists: false }),
  ]);
  return {
    workspaceDir: resolvedWorkspace,
    canonicalPath,
    legacyPath,
    canonicalExists: canonical.exists,
    legacyExists: legacy.exists,
    ...(typeof canonical.bytes === "number" ? { canonicalBytes: canonical.bytes } : {}),
    ...(typeof legacy.bytes === "number" ? { legacyBytes: legacy.bytes } : {}),
  };
}

function formatBytes(bytes?: number): string {
  return typeof bytes === "number" ? `${bytes} bytes` : "size unknown";
}

export function formatRootMemoryFilesWarning(detection: RootMemoryFilesDetection): string | null {
  if (detection.canonicalExists && detection.legacyExists) {
    return [
      "Split root durable memory files detected:",
      `- canonical: ${shortenHomePath(detection.canonicalPath)} (${formatBytes(detection.canonicalBytes)})`,
      `- legacy: ${shortenHomePath(detection.legacyPath)} (${formatBytes(detection.legacyBytes)})`,
      `OpenClaw uses ${CANONICAL_ROOT_MEMORY_FILENAME} as the canonical durable memory file.`,
      `Dreaming writes durable promotions to ${CANONICAL_ROOT_MEMORY_FILENAME}, so older facts in ${LEGACY_ROOT_MEMORY_FILENAME} can be shadowed.`,
      `Run "openclaw doctor --fix" to merge the legacy file into ${CANONICAL_ROOT_MEMORY_FILENAME} with a backup.`,
    ].join("\n");
  }
  return null;
}

export type RootMemoryMigrationResult = {
  changed: boolean;
  canonicalPath: string;
  legacyPath: string;
  removedLegacy: boolean;
  mergedLegacy: boolean;
  archivedLegacyPath?: string;
  copiedBytes?: number;
};

async function moveLegacyRootMemoryFileToArchive(params: {
  workspaceDir: string;
  legacyPath: string;
}): Promise<string> {
  const repairDir = resolveRootMemoryRepairDir(params.workspaceDir);
  await fs.promises.mkdir(repairDir, { recursive: true });
  const archiveDir = path.join(
    repairDir,
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, LEGACY_ROOT_MEMORY_FILENAME);
  try {
    await fs.promises.rename(params.legacyPath, archivePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      throw err;
    }
    await fs.promises.copyFile(params.legacyPath, archivePath);
    await fs.promises.unlink(params.legacyPath);
  }
  return archivePath;
}

function buildMergedLegacyRootMemorySection(params: {
  legacyText: string;
  archivedLegacyPath: string;
}): string {
  return [
    "",
    `## Imported From Legacy Root ${LEGACY_ROOT_MEMORY_FILENAME}`,
    "",
    `<!-- openclaw-root-memory-merge source=${LEGACY_ROOT_MEMORY_FILENAME} archived=${params.archivedLegacyPath} -->`,
    `This content came from legacy root \`${LEGACY_ROOT_MEMORY_FILENAME}\`, which was shadowed by \`${CANONICAL_ROOT_MEMORY_FILENAME}\`.`,
    "",
    params.legacyText.trim(),
    "",
  ].join("\n");
}

export async function migrateLegacyRootMemoryFile(
  workspaceDir: string,
): Promise<RootMemoryMigrationResult> {
  const detection = await detectRootMemoryFiles(workspaceDir);
  if (!detection.canonicalExists || !detection.legacyExists) {
    return {
      changed: false,
      canonicalPath: detection.canonicalPath,
      legacyPath: detection.legacyPath,
      removedLegacy: false,
      mergedLegacy: false,
    };
  }
  const archivedLegacyPath = await moveLegacyRootMemoryFileToArchive({
    workspaceDir: detection.workspaceDir,
    legacyPath: detection.legacyPath,
  });
  const [canonicalText, legacyText] = await Promise.all([
    fs.promises.readFile(detection.canonicalPath, "utf-8"),
    fs.promises.readFile(archivedLegacyPath, "utf-8"),
  ]);
  if (canonicalText !== legacyText) {
    const merged = `${canonicalText.trimEnd()}\n${buildMergedLegacyRootMemorySection({
      legacyText,
      archivedLegacyPath: shortenHomePath(archivedLegacyPath),
    })}`;
    await fs.promises.writeFile(detection.canonicalPath, merged, "utf-8");
  }
  return {
    changed: true,
    canonicalPath: detection.canonicalPath,
    legacyPath: detection.legacyPath,
    removedLegacy: true,
    mergedLegacy: canonicalText !== legacyText,
    archivedLegacyPath,
    ...(typeof detection.legacyBytes === "number" ? { copiedBytes: detection.legacyBytes } : {}),
  };
}

export async function noteWorkspaceMemoryHealth(cfg: OpenClawConfig): Promise<void> {
  try {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const rootMemoryWarning = formatRootMemoryFilesWarning(
      await detectRootMemoryFiles(workspaceDir),
    );
    if (rootMemoryWarning) {
      note(rootMemoryWarning, "Workspace memory");
    }
  } catch (err) {
    note(`Workspace memory audit could not be completed: ${formatErrorMessage(err)}`, "Doctor");
  }
}

export async function maybeRepairWorkspaceMemoryHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const configuredWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const rootMemoryFiles = await detectRootMemoryFiles(configuredWorkspaceDir);
    if (!rootMemoryFiles.canonicalExists || !rootMemoryFiles.legacyExists) {
      return;
    }
    const approvedLegacyMigration = await params.prompter.confirmRuntimeRepair({
      message: `Merge legacy root ${LEGACY_ROOT_MEMORY_FILENAME} into canonical ${CANONICAL_ROOT_MEMORY_FILENAME} and remove the shadowed file?`,
      initialValue: true,
    });
    if (!approvedLegacyMigration) {
      return;
    }
    const migration = await migrateLegacyRootMemoryFile(configuredWorkspaceDir);
    if (!migration.changed) {
      return;
    }
    const lines = [
      "Workspace memory root merged:",
      `- canonical: ${migration.canonicalPath}`,
      migration.archivedLegacyPath ? `- backup: ${migration.archivedLegacyPath}` : null,
      migration.mergedLegacy ? `- merged legacy content from: ${migration.legacyPath}` : null,
      migration.removedLegacy
        ? `- removed legacy file: ${migration.legacyPath}`
        : `- legacy file still present: ${migration.legacyPath}`,
    ].filter(Boolean);
    note(lines.join("\n"), "Doctor changes");
  } catch (err) {
    note(`Workspace memory repair could not be completed: ${formatErrorMessage(err)}`, "Doctor");
  }
}
