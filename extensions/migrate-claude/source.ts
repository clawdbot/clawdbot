import os from "node:os";
import path from "node:path";
import { exists, isDirectory, readJsonObject, resolveHomePath } from "./helpers.js";

type ClaudeArchivePath = {
  id: string;
  path: string;
  relativePath: string;
};

export type ClaudeSource = {
  root: string;
  confidence: "low" | "medium" | "high";
  homeDir?: string;
  projectDir?: string;
  homeProjectsDir?: string;
  userSettingsPath?: string;
  userLocalSettingsPath?: string;
  userClaudeJsonPath?: string;
  userMemoryPath?: string;
  projectSettingsPath?: string;
  projectLocalSettingsPath?: string;
  projectMcpPath?: string;
  projectMemoryPath?: string;
  projectDotClaudeMemoryPath?: string;
  projectLocalMemoryPath?: string;
  projectRulesDir?: string;
  userSkillsDir?: string;
  projectSkillsDir?: string;
  userCommandsDir?: string;
  projectCommandsDir?: string;
  userAgentsDir?: string;
  projectAgentsDir?: string;
  desktopConfigPath?: string;
  archivePaths: ClaudeArchivePath[];
};

const HOME_ARCHIVE_DIRS = ["projects", "cache", "plans"] as const;
const PROJECT_ARCHIVE_FILES = [".claude/scheduled_tasks.json"] as const;

function defaultClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

function defaultDesktopConfig(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

async function addArchivePath(
  archivePaths: ClaudeArchivePath[],
  id: string,
  candidate: string,
  relativePath: string,
): Promise<void> {
  if ((await exists(candidate)) || (await isDirectory(candidate))) {
    archivePaths.push({ id, path: candidate, relativePath });
  }
}

export async function discoverClaudeSource(input?: string): Promise<ClaudeSource> {
  const explicitInput = Boolean(input?.trim());
  const root = resolveHomePath(input?.trim() || defaultClaudeHome());
  const rootIsHome = path.basename(root) === ".claude";
  const inspectGlobal = !explicitInput || rootIsHome;
  const homeDir = inspectGlobal ? (rootIsHome ? root : defaultClaudeHome()) : undefined;
  const projectDir = rootIsHome ? undefined : root;
  const archivePaths: ClaudeArchivePath[] = [];

  const userSettingsPath = homeDir ? path.join(homeDir, "settings.json") : undefined;
  const userLocalSettingsPath = homeDir ? path.join(homeDir, "settings.local.json") : undefined;
  const userClaudeJsonPath = inspectGlobal ? path.join(os.homedir(), ".claude.json") : undefined;
  const userMemoryPath = homeDir ? path.join(homeDir, "CLAUDE.md") : undefined;
  const desktopConfigPath = inspectGlobal ? defaultDesktopConfig() : undefined;
  const homeProjectsDir = homeDir ? path.join(homeDir, "projects") : undefined;
  const userSkillsDir = homeDir ? path.join(homeDir, "skills") : undefined;
  const userCommandsDir = homeDir ? path.join(homeDir, "commands") : undefined;
  const userAgentsDir = homeDir ? path.join(homeDir, "agents") : undefined;

  if (homeDir) {
    for (const dir of HOME_ARCHIVE_DIRS) {
      await addArchivePath(archivePaths, `archive:home:${dir}`, path.join(homeDir, dir), dir);
    }
  }

  const source: ClaudeSource = {
    root,
    confidence: "low",
    archivePaths,
    ...(homeDir && (await isDirectory(homeDir)) ? { homeDir } : {}),
    ...(homeProjectsDir && (await isDirectory(homeProjectsDir)) ? { homeProjectsDir } : {}),
    ...(projectDir ? { projectDir } : {}),
    ...(userSettingsPath && (await exists(userSettingsPath)) ? { userSettingsPath } : {}),
    ...(userLocalSettingsPath && (await exists(userLocalSettingsPath))
      ? { userLocalSettingsPath }
      : {}),
    ...(userClaudeJsonPath && (await exists(userClaudeJsonPath)) ? { userClaudeJsonPath } : {}),
    ...(userMemoryPath && (await exists(userMemoryPath)) ? { userMemoryPath } : {}),
    ...(userSkillsDir && (await isDirectory(userSkillsDir)) ? { userSkillsDir } : {}),
    ...(userCommandsDir && (await isDirectory(userCommandsDir)) ? { userCommandsDir } : {}),
    ...(userAgentsDir && (await isDirectory(userAgentsDir)) ? { userAgentsDir } : {}),
    ...(desktopConfigPath && (await exists(desktopConfigPath)) ? { desktopConfigPath } : {}),
  };

  if (projectDir) {
    const projectSettingsPath = path.join(projectDir, ".claude", "settings.json");
    const projectLocalSettingsPath = path.join(projectDir, ".claude", "settings.local.json");
    const projectMcpPath = path.join(projectDir, ".mcp.json");
    const projectMemoryPath = path.join(projectDir, "CLAUDE.md");
    const projectDotClaudeMemoryPath = path.join(projectDir, ".claude", "CLAUDE.md");
    const projectLocalMemoryPath = path.join(projectDir, "CLAUDE.local.md");
    const projectRulesDir = path.join(projectDir, ".claude", "rules");
    const projectSkillsDir = path.join(projectDir, ".claude", "skills");
    const projectCommandsDir = path.join(projectDir, ".claude", "commands");
    const projectAgentsDir = path.join(projectDir, ".claude", "agents");
    Object.assign(source, {
      ...((await exists(projectSettingsPath)) ? { projectSettingsPath } : {}),
      ...((await exists(projectLocalSettingsPath)) ? { projectLocalSettingsPath } : {}),
      ...((await exists(projectMcpPath)) ? { projectMcpPath } : {}),
      ...((await exists(projectMemoryPath)) ? { projectMemoryPath } : {}),
      ...((await exists(projectDotClaudeMemoryPath)) ? { projectDotClaudeMemoryPath } : {}),
      ...((await exists(projectLocalMemoryPath)) ? { projectLocalMemoryPath } : {}),
      ...((await isDirectory(projectRulesDir)) ? { projectRulesDir } : {}),
      ...((await isDirectory(projectSkillsDir)) ? { projectSkillsDir } : {}),
      ...((await isDirectory(projectCommandsDir)) ? { projectCommandsDir } : {}),
      ...((await isDirectory(projectAgentsDir)) ? { projectAgentsDir } : {}),
    });
    for (const file of PROJECT_ARCHIVE_FILES) {
      await addArchivePath(
        archivePaths,
        `archive:project:${file}`,
        path.join(projectDir, file),
        file,
      );
    }
  }

  const claudeJson = await readJsonObject(source.userClaudeJsonPath);
  const hasClaudeJsonState = Boolean(claudeJson.mcpServers || claudeJson.projects);
  const desktopConfig = await readJsonObject(source.desktopConfigPath);
  const hasDesktopMcp = Boolean(desktopConfig.mcpServers);
  const high = Boolean(
    source.userSettingsPath ||
    source.userMemoryPath ||
    source.projectSettingsPath ||
    source.projectMcpPath ||
    source.projectMemoryPath ||
    source.projectDotClaudeMemoryPath ||
    hasClaudeJsonState ||
    hasDesktopMcp,
  );
  const medium = Boolean(
    source.userSkillsDir ||
    source.projectSkillsDir ||
    source.userCommandsDir ||
    source.projectCommandsDir ||
    source.userAgentsDir ||
    source.projectAgentsDir ||
    source.projectRulesDir ||
    source.projectLocalMemoryPath ||
    source.homeProjectsDir,
  );
  source.confidence = high ? "high" : medium ? "medium" : "low";
  return source;
}

export function hasClaudeSource(source: ClaudeSource): boolean {
  return source.confidence !== "low";
}
