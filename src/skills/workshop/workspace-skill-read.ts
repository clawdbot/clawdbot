import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import {
  assertInsideWorkspace,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { readArchivedSkillFiles, readSkillLifecycleRecords } from "./store-sqlite-lifecycle.js";

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

type WritableWorkspaceSkillSummary = {
  name: string;
  description?: string;
  filePath: string;
  consolidationEligible: boolean;
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
  const summaries: WritableWorkspaceSkillSummary[] = [];
  const lifecycle = readSkillLifecycleRecords(opts?.env ? { env: opts.env } : {});
  for (const skill of status.skills) {
    if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
      continue;
    }
    const record = lifecycle.get(canonicalizePath(path.resolve(skill.filePath)));
    if (record?.state === "archived") {
      continue;
    }
    summaries.push(
      skill.description
        ? {
            name: skill.skillKey,
            description: skill.description,
            filePath: skill.filePath,
            consolidationEligible: Boolean(record && !record.pinned),
          }
        : {
            name: skill.skillKey,
            filePath: skill.filePath,
            consolidationEligible: Boolean(record && !record.pinned),
          },
    );
  }
  return summaries;
}

/** Reads the live SKILL.md of a writable workspace skill, resolved like an update target. */
export async function readWritableWorkspaceSkill(
  workspaceDir: string,
  skillName: string,
  opts?: { config?: OpenClawConfig; agentId?: string; env?: NodeJS.ProcessEnv },
): Promise<{ skillKey: string; skillFile: string; content: string }> {
  const skill = (await readWritableWorkspaceSkills(workspaceDir, [skillName], opts))[0];
  if (!skill) {
    throw new Error("Skill name is required.");
  }
  return skill;
}

export async function readWritableWorkspaceSkills(
  workspaceDir: string,
  skillNames: readonly string[],
  opts?: { config?: OpenClawConfig; agentId?: string; env?: NodeJS.ProcessEnv },
): Promise<Array<{ skillKey: string; skillFile: string; content: string }>> {
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const archivedSkillFiles = readArchivedSkillFiles(opts?.env ? { env: opts.env } : {});
  const skills = [];
  for (const skillName of skillNames) {
    const name = normalizeOptionalString(skillName);
    if (!name) {
      throw new Error("Skill name is required.");
    }
    const targetSkill = resolveSkillStatusEntry(status.skills, name);
    if (!targetSkill) {
      throw new Error(`Skill not found: ${name}`);
    }
    assertWritableSkillTarget(workspaceDir, targetSkill);
    if (archivedSkillFiles.has(canonicalizePath(path.resolve(targetSkill.filePath)))) {
      throw new Error(`Archived skill cannot be updated: ${targetSkill.skillKey}`);
    }
    const content = await readWorkspaceSkillFile(targetSkill.filePath);
    if (content === null) {
      throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
    }
    skills.push({ skillKey: targetSkill.skillKey, skillFile: targetSkill.filePath, content });
  }
  return skills;
}
