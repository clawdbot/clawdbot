import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import { isWritableSkillStatusEntry, resolveWritableSkillTarget } from "./target.js";

export function assertWritableSkillTarget(
  workspaceDir: string,
  skill: SkillStatusEntry,
  config?: OpenClawConfig,
): void {
  resolveWritableSkillTarget({ workspaceDir, skill, config });
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
  opts?: { config?: OpenClawConfig; agentId?: string },
): WritableWorkspaceSkillSummary[] {
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const summaries: WritableWorkspaceSkillSummary[] = [];
  for (const skill of status.skills) {
    if (!isWritableSkillStatusEntry({ workspaceDir, skill, config: opts?.config })) {
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
  assertWritableSkillTarget(workspaceDir, targetSkill, opts?.config);
  const content = await readWorkspaceSkillFile(targetSkill.filePath);
  if (content === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  return { skillKey: targetSkill.skillKey, skillFile: targetSkill.filePath, content };
}
