import fs from "node:fs/promises";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PreparedWorkspaceSkillMutation } from "../lifecycle/workspace-skill-write.js";
import type {
  SkillCollectionPlanEntry,
  WritableSkillCollectionEntry,
} from "./collection-contracts.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";

export async function assertCollectionReadsCurrent(
  current: readonly WritableSkillCollectionEntry[],
  readSkillHashes: ReadonlyMap<string, string>,
  plannedNames: ReadonlySet<string>,
  maxBytes: number,
): Promise<void> {
  let totalBytes = 0;
  for (const skill of current) {
    const content = await fs.readFile(skill.filePath, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > maxBytes) {
      throw new Error(`Writable skill collection exceeds the ${maxBytes}-byte review limit.`);
    }
    if (plannedNames.has(skill.name) && readSkillHashes.get(skill.name) !== sha256Hex(content)) {
      throw new Error(`Skill changed after it was read: ${skill.name}`);
    }
  }
}

export async function assertResultCollectionBytes(
  current: readonly WritableSkillCollectionEntry[],
  plan: readonly SkillCollectionPlanEntry[],
  prepared: readonly PreparedWorkspaceSkillMutation[],
  maxBytes: number,
): Promise<void> {
  // Unlisted skills keep their current bytes; listed ones are dropped or replaced by `prepared`.
  const plannedNames = new Set(plan.map((entry) => entry.name));
  let totalBytes = 0;
  for (const skill of current) {
    if (!plannedNames.has(skill.name)) {
      totalBytes += (await fs.stat(skill.filePath)).size;
    }
  }
  for (const mutation of prepared) {
    totalBytes += Buffer.byteLength(mutation.skillFile.content);
  }
  if (totalBytes > maxBytes) {
    throw new Error(`Resulting skill collection exceeds the ${maxBytes}-byte review limit.`);
  }
}

export async function assertCollectionMutationCurrent(
  current: readonly WritableSkillCollectionEntry[],
  expectedTreeHashes: ReadonlyMap<string, string>,
  plannedNames: ReadonlySet<string>,
  prepared: readonly PreparedWorkspaceSkillMutation[],
): Promise<void> {
  for (const skill of current) {
    if (!plannedNames.has(skill.name)) {
      continue;
    }
    const expectedTreeHash = expectedTreeHashes.get(skill.name);
    if (
      !expectedTreeHash ||
      (await readSkillProposalTargetTreeSha256(skill.baseDir)) !== expectedTreeHash
    ) {
      throw new Error(`Skill tree changed before collection mutation: ${skill.name}`);
    }
  }
  for (const mutation of prepared) {
    if (mutation.mode === "create" && (await pathExists(mutation.skillDir))) {
      throw new Error(
        `New skill directory changed before collection mutation: ${mutation.skillDir}`,
      );
    }
  }
}
