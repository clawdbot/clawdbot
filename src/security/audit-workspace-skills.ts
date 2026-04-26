import fs from "node:fs/promises";
import path from "node:path";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { isPathInside } from "./scan-paths.js";

type WorkspaceSkillScanLimits = {
  maxFiles?: number;
  maxDirVisits?: number;
};

const MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE = 2_000;
const MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS = 12;

async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isDir: boolean;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      ok: true,
      isDir: lst.isDirectory(),
    };
  } catch {
    return {
      ok: false,
      isDir: false,
    };
  }
}

function realpathWithTimeout(p: string, timeoutMs = 2000): Promise<string | null> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const realpathPromise = fs
    .realpath(p)
    .catch(() => null)
    .then((result) => {
      clearTimeout(timerHandle);
      return result;
    });

  const timeoutPromise = new Promise<null>((resolve) => {
    timerHandle = setTimeout(() => resolve(null), timeoutMs);
    timerHandle.unref?.();
  });

  return Promise.race([realpathPromise, timeoutPromise]);
}

async function listWorkspaceSkillMarkdownFiles(
  workspaceDir: string,
  limits: WorkspaceSkillScanLimits = {},
): Promise<{ skillFilePaths: string[]; truncated: boolean }> {
  const skillsRoot = path.join(workspaceDir, "skills");
  const rootStat = await safeStat(skillsRoot);
  if (!rootStat.ok || !rootStat.isDir) {
    return { skillFilePaths: [], truncated: false };
  }

  const maxFiles = limits.maxFiles ?? MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE;
  const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
  const skillFiles: string[] = [];
  const queue: string[] = [skillsRoot];
  const visitedDirs = new Set<string>();
  let totalDirVisits = 0;

  while (queue.length > 0 && skillFiles.length < maxFiles && totalDirVisits++ < maxTotalDirVisits) {
    const dir = queue.shift()!;
    const dirRealPath = (await realpathWithTimeout(dir)) ?? path.resolve(dir);
    if (visitedDirs.has(dirRealPath)) {
      continue;
    }
    visitedDirs.add(dirRealPath);

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) {
          continue;
        }
        if (stat.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (stat.isFile() && entry.name === "SKILL.md") {
          skillFiles.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(fullPath);
      }
    }
  }

  return { skillFilePaths: skillFiles, truncated: queue.length > 0 };
}

export async function collectWorkspaceSkillSymlinkEscapeFindings(params: {
  cfg: OpenClawConfig;
  skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
  if (workspaceDirs.length === 0) {
    return findings;
  }

  const escapedSkillFiles: Array<{
    workspaceDir: string;
    skillFilePath: string;
    skillRealPath: string;
  }> = [];
  const seenSkillPaths = new Set<string>();

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.resolve(workspaceDir);
    const workspaceRealPath = (await realpathWithTimeout(workspacePath)) ?? workspacePath;
    const { skillFilePaths, truncated } = await listWorkspaceSkillMarkdownFiles(
      workspacePath,
      params.skillScanLimits,
    );

    if (truncated) {
      findings.push({
        checkId: "skills.workspace.scan_truncated",
        severity: "warn",
        title: "Workspace skill scan reached the directory visit limit",
        detail:
          `The skills/ directory scan in ${workspacePath} stopped early after reaching the ` +
          `BFS visit cap. Skill files in the unscanned portion of the tree were not checked ` +
          "for symlink escapes.",
        remediation:
          "Flatten or simplify the skills/ directory hierarchy to stay within the scan budget, " +
          "or move deeply-nested skill collections to a managed skill location.",
      });
    }

    for (const skillFilePath of skillFilePaths) {
      const canonicalSkillPath = path.resolve(skillFilePath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);

      const skillRealPath = await realpathWithTimeout(canonicalSkillPath);
      if (!skillRealPath) {
        escapedSkillFiles.push({
          workspaceDir: workspacePath,
          skillFilePath: canonicalSkillPath,
          skillRealPath: "(realpath timed out - symlink target unverifiable)",
        });
        continue;
      }
      if (isPathInside(workspaceRealPath, skillRealPath)) {
        continue;
      }
      escapedSkillFiles.push({
        workspaceDir: workspacePath,
        skillFilePath: canonicalSkillPath,
        skillRealPath,
      });
    }
  }

  if (escapedSkillFiles.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "skills.workspace.symlink_escape",
    severity: "warn",
    title: "Workspace skill files resolve outside the workspace root",
    detail:
      "Detected workspace `skills/**/SKILL.md` paths whose realpath escapes their workspace root:\n" +
      escapedSkillFiles
        .slice(0, MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS)
        .map(
          (entry) =>
            `- workspace=${entry.workspaceDir}\n` +
            `  skill=${entry.skillFilePath}\n` +
            `  realpath=${entry.skillRealPath}`,
        )
        .join("\n") +
      (escapedSkillFiles.length > MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS
        ? `\n- +${escapedSkillFiles.length - MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS} more`
        : ""),
    remediation:
      "Keep workspace skills inside the workspace root (replace symlinked escapes with real in-workspace files), or move trusted shared skills to managed/bundled skill locations.",
  });

  return findings;
}
