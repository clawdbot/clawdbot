import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import {
  assertInsideWorkspace,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import { listWorkshopOwnedSkillDirs } from "./ownership.js";

const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);

export function assertWritableSkillTarget(workspaceDir: string, skill: SkillStatusEntry): void {
  if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${skill.source}`);
  }
  assertInsideWorkspace(workspaceDir, skill.filePath, "skill file");
  assertInsideWorkspace(workspaceDir, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

export function isWorkspaceOwnedSkillTarget(
  workspaceDir: string,
  skill: Pick<SkillStatusEntry, "baseDir">,
): boolean {
  const workspaceRealPath = tryRealpath(path.resolve(workspaceDir));
  const skillRealPath = tryRealpath(path.resolve(skill.baseDir));
  return Boolean(
    workspaceRealPath && skillRealPath && isPathInside(workspaceRealPath, skillRealPath),
  );
}

type WritableWorkspaceSkillSummary = {
  name: string;
  description?: string;
  filePath: string;
};

/**
 * Lists the workspace skills the workshop can target with update proposals, using the same
 * status discovery as `proposeUpdateSkill` so callers that route learnings to existing
 * skills stay in lockstep with what an update can actually write.
 */
export function listWritableWorkspaceSkillSummaries(
  workspaceDir: string,
  opts?: { config?: OpenClawConfig; agentId?: string; env?: NodeJS.ProcessEnv },
): WritableWorkspaceSkillSummary[] {
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const ownedDirs = listWorkshopOwnedSkillDirs(workspaceDir, opts?.env ? { env: opts.env } : {});
  const summaries: WritableWorkspaceSkillSummary[] = [];
  for (const skill of status.skills) {
    if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
      continue;
    }
    if (!ownedDirs.has(path.resolve(skill.baseDir))) {
      continue;
    }
    summaries.push(
      skill.description
        ? { name: skill.skillKey, description: skill.description, filePath: skill.filePath }
        : { name: skill.skillKey, filePath: skill.filePath },
    );
  }
  return summaries;
}

/** Reads the live SKILL.md of a writable workspace skill, resolved like an update target. */
export async function readWritableWorkspaceSkill(
  workspaceDir: string,
  skillName: string,
  opts?: { config?: OpenClawConfig; agentId?: string },
): Promise<{ skillKey: string; skillFile: string; content: string }> {
  const name = normalizeOptionalString(skillName);
  if (!name) {
    throw new Error("Skill name is required.");
  }
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const targetSkill = resolveSkillStatusEntry(status.skills, name);
  if (!targetSkill) {
    throw new Error(`Skill not found: ${name}`);
  }
  assertWritableSkillTarget(workspaceDir, targetSkill);
  const content = await readWorkspaceSkillFile(targetSkill.filePath);
  if (content === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  return { skillKey: targetSkill.skillKey, skillFile: targetSkill.filePath, content };
}
