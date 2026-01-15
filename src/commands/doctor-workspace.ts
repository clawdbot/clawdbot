import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
} from "../agents/workspace.js";

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/clawdbot/clawdbot/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/clawdbot/clawdbot/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const memoryPaths = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];

  for (const memoryPath of memoryPaths) {
    try {
      await fs.promises.access(memoryPath);
      return false;
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    const content = await fs.promises.readFile(agentsPath, "utf-8");
    if (/memory\.md/i.test(content)) return false;
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

export type LegacyWorkspaceDetection = {
  activeWorkspace: string;
  legacyDirs: string[];
};

function looksLikeWorkspaceDir(dir: string, exists: (value: string) => boolean) {
  const markers = [
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
  ];
  return markers.some((name) => exists(path.join(dir, name)));
}

export function detectLegacyWorkspaceDirs(params: {
  workspaceDir: string;
  homedir?: () => string;
  exists?: (value: string) => boolean;
}): LegacyWorkspaceDetection {
  const homedir = params.homedir ?? os.homedir;
  const exists = params.exists ?? fs.existsSync;
  const home = homedir();
  const activeWorkspace = path.resolve(params.workspaceDir);
  const candidates = [path.join(home, "clawdbot")];
  const legacyDirs = candidates
    .filter((candidate) => {
      if (!exists(candidate)) return false;
      return path.resolve(candidate) !== activeWorkspace;
    })
    .filter((candidate) => {
      return looksLikeWorkspaceDir(candidate, exists);
    });
  return { activeWorkspace, legacyDirs };
}

export function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string {
  return [
    "Extra workspace directories detected (may contain old agent files):",
    ...detection.legacyDirs.map((dir) => `- ${dir}`),
    `Active workspace: ${detection.activeWorkspace}`,
    "If unused, archive or move to Trash (e.g. trash ~/clawdbot).",
  ].join("\n");
}
