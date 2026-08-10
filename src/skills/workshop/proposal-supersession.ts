import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { buildWorkspaceSkillStatus, resolveSkillStatusEntry } from "../discovery/status.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { inspectSkillProposalTargetTree } from "./proposal-bundle.js";
import {
  SkillProposalStaleTargetError,
  SkillProposalSupersessionIneligibleError,
} from "./proposal-lifecycle.js";
import { readSkillLifecycleRecord } from "./store-sqlite-lifecycle.js";
import {
  MAX_SKILL_PROPOSAL_SUPERSESSIONS,
  type SkillProposalSupersession,
  type SkillProposalSupersedeInput,
} from "./types.js";
import { assertWritableSkillTarget } from "./workspace-skill-read.js";

export { SkillProposalStaleTargetError, SkillProposalSupersessionIneligibleError };

export async function resolveSkillProposalSupersessions(params: {
  workspaceDir: string;
  targetSkillFile: string;
  requested?: SkillProposalSupersedeInput[];
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillProposalSupersession[] | undefined> {
  if (!params.requested?.length) {
    return undefined;
  }
  if (params.requested.length > MAX_SKILL_PROPOSAL_SUPERSESSIONS) {
    throw new Error(
      `A skill proposal can supersede at most ${MAX_SKILL_PROPOSAL_SUPERSESSIONS} skills.`,
    );
  }
  const status = buildWorkspaceSkillStatus(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
  });
  const targetSkillFile = canonicalizePath(path.resolve(params.targetSkillFile));
  const seen = new Set<string>();
  const supersessions: SkillProposalSupersession[] = [];
  for (const requested of params.requested) {
    const source = resolveSkillStatusEntry(status.skills, requested.skillName);
    if (!source) {
      throw new Error(`Skill not found: ${requested.skillName}`);
    }
    assertWritableSkillTarget(params.workspaceDir, source);
    const sourceSkillFile = canonicalizePath(path.resolve(source.filePath));
    if (sourceSkillFile === targetSkillFile) {
      throw new SkillProposalSupersessionIneligibleError(
        `A skill cannot supersede itself: ${source.skillKey}`,
      );
    }
    if (seen.has(sourceSkillFile)) {
      throw new SkillProposalSupersessionIneligibleError(
        `Duplicate superseded skill: ${source.skillKey}`,
      );
    }
    const content = await readWorkspaceSkillFile(source.filePath);
    if (content === null) {
      throw new Error(`Skill file is missing: ${source.filePath}`);
    }
    if (sha256Hex(content) !== requested.expectedCurrentContentHash) {
      throw new SkillProposalStaleTargetError(
        `Superseded skill changed since the reviewer's read: ${source.skillKey}`,
      );
    }
    const lifecycle = readSkillLifecycleRecord(
      source.filePath,
      params.env ? { env: params.env } : {},
    );
    if (!lifecycle || lifecycle.pinned || lifecycle.state === "archived") {
      throw new SkillProposalSupersessionIneligibleError(
        `Skill is not eligible for automatic supersession: ${source.skillKey}`,
      );
    }
    const tree = await inspectSkillProposalTargetTree(source.baseDir);
    if (tree.filePaths.some((filePath) => filePath !== "SKILL.md")) {
      throw new SkillProposalSupersessionIneligibleError(
        `Skill has support files and cannot be superseded automatically: ${source.skillKey}`,
      );
    }
    seen.add(sourceSkillFile);
    supersessions.push({
      skillName: source.name,
      skillKey: source.skillKey,
      skillDir: source.baseDir,
      skillFile: source.filePath,
      source: source.source,
      treeSha256: tree.treeSha256,
    });
  }
  return supersessions.toSorted((left, right) => left.skillFile.localeCompare(right.skillFile));
}
