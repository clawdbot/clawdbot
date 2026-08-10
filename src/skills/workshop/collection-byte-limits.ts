import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PreparedWorkspaceSkillMutation } from "../lifecycle/workspace-skill-write.js";
import type {
  SkillCollectionPlanEntry,
  WritableSkillCollectionEntry,
} from "./collection-reconcile.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";

export async function assertCollectionReadsCurrent(
  current: readonly WritableSkillCollectionEntry[],
  readSkillHashes: ReadonlyMap<string, string>,
  maxBytes: number,
): Promise<void> {
  let totalBytes = 0;
  for (const skill of current) {
    const content = await fs.readFile(skill.filePath, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > maxBytes) {
      throw new Error(`Writable skill collection exceeds the ${maxBytes}-byte review limit.`);
    }
    if (readSkillHashes.get(skill.name) !== sha256Hex(content)) {
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
  const currentByName = new Map(current.map((skill) => [skill.name, skill]));
  const preparedByName = new Map(
    prepared.map((mutation) => [path.basename(mutation.skillDir), mutation]),
  );
  let totalBytes = 0;
  for (const entry of plan) {
    if (entry.action === "drop") {
      continue;
    }
    const existing = currentByName.get(entry.name);
    const mutation = preparedByName.get(entry.name);
    if (mutation) {
      totalBytes += Buffer.byteLength(mutation.skillFile.content);
    } else if (existing) {
      totalBytes += (await fs.stat(existing.filePath)).size;
    } else {
      throw new Error(`Resulting skill is missing: ${entry.name}`);
    }
    if (totalBytes > maxBytes) {
      throw new Error(`Resulting skill collection exceeds the ${maxBytes}-byte review limit.`);
    }
  }
}

export async function assertCollectionMutationCurrent(
  current: readonly WritableSkillCollectionEntry[],
  expectedTreeHashes: ReadonlyMap<string, string>,
  prepared: readonly PreparedWorkspaceSkillMutation[],
): Promise<void> {
  for (const skill of current) {
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
