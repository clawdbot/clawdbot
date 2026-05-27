import { accessSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { SkillSnapshot } from "../skills.js";
import { cliBackendLog } from "./log.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const OPENCLAW_CLAUDE_PLUGIN_NAME = "openclaw-skills";

type MaterializedSkill = {
  name: string;
  sourceDir: string;
  targetDirName: string;
};

function sanitizeSkillDirName(name: string, used: Set<string>): string {
  const base =
    name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  const safeBase = base.startsWith(".") ? `skill-${base.replace(/^\.+/, "") || "skill"}` : base;
  let candidate = safeBase;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${safeBase}-${index}`;
  }
  used.add(candidate);
  return candidate;
}

export function isClaudeCliSkillFileAccessible(skillFilePath: string): boolean {
  try {
    accessSync(skillFilePath);
    return true;
  } catch {
    return false;
  }
}

async function collectClaudePluginSkills(snapshot?: SkillSnapshot): Promise<MaterializedSkill[]> {
  const skills = snapshot?.resolvedSkills ?? [];
  if (skills.length === 0) {
    return [];
  }

  const usedTargetNames = new Set<string>();
  const materialized: MaterializedSkill[] = [];
  for (const skill of skills) {
    const name = skill.name?.trim();
    const skillFilePath = skill.filePath?.trim();
    if (!name || !skillFilePath) {
      continue;
    }
    if (!isClaudeCliSkillFileAccessible(skillFilePath)) {
      cliBackendLog.warn(`claude skill plugin skipped missing skill file: ${skillFilePath}`);
      continue;
    }
    materialized.push({
      name,
      sourceDir: path.dirname(skillFilePath),
      targetDirName: sanitizeSkillDirName(name, usedTargetNames),
    });
  }
  return materialized;
}

async function linkOrCopySkillDir(params: { sourceDir: string; targetDir: string }) {
  try {
    await fs.symlink(
      params.sourceDir,
      params.targetDir,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    await fs.cp(params.sourceDir, params.targetDir, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
}

export async function prepareClaudeCliSkillsPlugin(params: {
  backendId: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<{ args: string[]; cleanup: () => Promise<void>; pluginDir?: string }> {
  if (normalizeLowercaseStringOrEmpty(params.backendId) !== CLAUDE_CLI_BACKEND_ID) {
    return { args: [], cleanup: async () => {} };
  }

  const skills = await collectClaudePluginSkills(params.skillsSnapshot);
  if (skills.length === 0) {
    return { args: [], cleanup: async () => {} };
  }

  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-claude-skills-"),
  );
  const pluginDir = path.join(tempDir, OPENCLAW_CLAUDE_PLUGIN_NAME);
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  const skillsDir = path.join(pluginDir, "skills");
  await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });

  const manifest = {
    name: OPENCLAW_CLAUDE_PLUGIN_NAME,
    version: "0.0.0",
    description: "Session-scoped OpenClaw skills selected for this agent run.",
    skills: "./skills",
  };
  await fs.writeFile(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf-8",
      mode: 0o600,
    },
  );

  let linkedSkillCount = 0;
  for (const skill of skills) {
    try {
      await linkOrCopySkillDir({
        sourceDir: skill.sourceDir,
        targetDir: path.join(skillsDir, skill.targetDirName),
      });
      linkedSkillCount += 1;
    } catch (error) {
      cliBackendLog.warn(
        `claude skill plugin skipped ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (linkedSkillCount === 0) {
    await fs.rm(tempDir, { recursive: true, force: true });
    return { args: [], cleanup: async () => {} };
  }

  return {
    args: ["--plugin-dir", pluginDir],
    pluginDir,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
