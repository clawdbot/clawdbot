import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";

export const MAX_RECONCILED_SKILLS = 200;
export const MAX_RECONCILED_SKILL_BYTES = 240_000;
export const AUTONOMOUS_SKILL_MAX_CHARS = 10_000;

export function autonomousSkillSizeError(
  name: string,
  currentChars: number,
  resultChars: number,
): string | undefined {
  if (
    resultChars <= AUTONOMOUS_SKILL_MAX_CHARS ||
    (currentChars > AUTONOMOUS_SKILL_MAX_CHARS && resultChars < currentChars)
  ) {
    return undefined;
  }
  return `skill "${name}" would be ${resultChars} characters; autonomous limit is 10,000. Prune stale steps; move reference and examples into a bundled file.`;
}

export type SkillCollectionPlanEntry =
  | { action: "drop"; name: string; reason: string }
  | { action: "write"; name: string; description: string; content: string };

export type SkillCollectionReconcileResult = {
  backupId: string;
  kept: string[];
  written: string[];
  dropped: Array<{ name: string; reason: string }>;
};

export type SkillCollectionRestoreResult = {
  backupId: string;
  restored: string[];
  removed: string[];
};

export type SkillCollectionReconcileContext = {
  agentIds?: string[];
  approvedSkillNames?: Set<string>;
  approvedSkillNamesByAgent?: Array<Set<string>>;
  readSkillHashes?: Map<string, string>;
  readSkillTreeHashes?: Map<string, string>;
  readSkillBytes?: Map<string, number>;
  readByteCount?: number;
  reconciling?: boolean;
  result?: SkillCollectionReconcileResult;
};

export type WritableSkillCollectionEntry = {
  name: string;
  description?: string;
  baseDir: string;
  filePath: string;
  workshopOwned: boolean;
};

export type SkillCollectionChange = {
  action: "created" | "updated" | "removed";
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};
