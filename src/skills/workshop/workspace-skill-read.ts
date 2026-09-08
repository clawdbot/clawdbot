import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillStatusEntry } from "../discovery/status.js";
import {
  assertInsideSkillsRoot,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { resolveSkillManifestMetadata } from "../loading/frontmatter.js";
import type { Skill } from "../loading/skill-contract.js";
import { loadSkillRootRecords, warnInvalidSkill } from "../loading/skill-root-loader.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

function assertWritableSkillTarget(
  skill: Pick<Skill, "baseDir" | "filePath" | "name">,
  options: WorkshopSkillReadOptions,
): void {
  const skillsRoot = workshopSkillsDir(options);
  assertInsideSkillsRoot(skillsRoot, skill.filePath, "skill file");
  assertInsideSkillsRoot(skillsRoot, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

export type WritableWorkshopSkillSummary = {
  name: string;
  skillKey: string;
  description: string;
  baseDir: string;
  filePath: string;
};

export type WorkshopSkillReadOptions = {
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
};

function workshopSkillsDir(options: WorkshopSkillReadOptions): string {
  if (!options.agentId) {
    throw new Error("Skill Workshop requires the active agent id.");
  }
  return resolveWorkshopSkillsDir(options.config, options.agentId, options.env);
}

export function listWritableWorkshopSkillSummaries(
  options: WorkshopSkillReadOptions,
): WritableWorkshopSkillSummary[] {
  // The inventory is model-visible and reviewer-iterated, so it shares the loader's
  // per-source count, file-size, symlink, and hardlink limits instead of an unbounded read.
  const records = loadSkillRootRecords({
    dir: workshopSkillsDir(options),
    source: "openclaw-workshop",
    config: options.config,
    onDiagnostic: (diagnostic) => {
      warnInvalidSkill("openclaw-workshop", diagnostic);
      // A failed read is not an empty collection. Keep intentional loader
      // exclusions, but never use an unreadable inventory for review or display.
      if (diagnostic.kind === "read") {
        throw new Error(
          "Workshop skills could not be read. Check access to the skill files, then retry.",
        );
      }
    },
  });
  return records
    .map(({ skill, frontmatter }) => ({
      name: skill.name,
      skillKey: resolveSkillManifestMetadata(frontmatter)?.skillKey ?? skill.name,
      description: skill.description,
      baseDir: skill.baseDir,
      filePath: skill.filePath,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function resolveWritableWorkshopSkillSummary(
  skillName: string,
  options: WorkshopSkillReadOptions,
): WritableWorkshopSkillSummary | undefined {
  return (
    resolveSkillStatusEntry(listWritableWorkshopSkillSummaries(options), skillName) ?? undefined
  );
}

export async function readWritableWorkshopSkill(
  skillName: string,
  options: WorkshopSkillReadOptions,
): Promise<{
  skillName: string;
  skillKey: string;
  skillFile: string;
  content: string;
  baseDir: string;
  description: string;
}> {
  const name = normalizeOptionalString(skillName);
  if (!name) {
    throw new Error("Skill name is required.");
  }
  const targetSkill = resolveWritableWorkshopSkillSummary(name, options);
  if (!targetSkill) {
    throw new Error(
      `Skill Workshop can only update skills it generated. No Workshop-generated skill matched: ${name}. Create it as a new skill, or edit the file directly.`,
    );
  }
  assertWritableSkillTarget(targetSkill, options);
  const content = await readWorkspaceSkillFile(targetSkill.filePath);
  if (content === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  return {
    skillName: targetSkill.name,
    skillKey: targetSkill.skillKey,
    skillFile: targetSkill.filePath,
    content,
    baseDir: targetSkill.baseDir,
    description: targetSkill.description,
  };
}
