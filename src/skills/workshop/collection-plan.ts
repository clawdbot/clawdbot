import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import type {
  SkillCollectionPlanEntry,
  WritableSkillCollectionEntry,
} from "./collection-contracts.js";

export function validateSkillCollectionPlan(
  input: readonly SkillCollectionPlanEntry[],
  current: readonly WritableSkillCollectionEntry[],
  readSkillHashes: ReadonlyMap<string, string>,
  maxDecisions: number,
  approvedSkillNamesByAgent?: readonly ReadonlySet<string>[],
): SkillCollectionPlanEntry[] {
  if (input.length > maxDecisions) {
    throw new Error(`A skill collection can contain at most ${maxDecisions} decisions.`);
  }
  const currentNames = new Set(current.map((skill) => skill.name));
  const currentByName = new Map(current.map((skill) => [skill.name, skill]));
  const seen = new Set<string>();
  for (const entry of input) {
    const normalized = normalizeSkillIndexName(entry.name);
    if (!normalized || normalized !== entry.name) {
      throw new Error(`Invalid skill name: ${entry.name}`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate skill decision: ${entry.name}`);
    }
    seen.add(entry.name);
    if (entry.action !== "write" && !currentNames.has(entry.name)) {
      throw new Error(`Cannot ${entry.action} a skill that does not exist: ${entry.name}`);
    }
    if (currentNames.has(entry.name) && !readSkillHashes.has(entry.name)) {
      throw new Error(`Read the skill before changing it: ${entry.name}`);
    }
    if (entry.action === "drop" && !entry.reason.trim()) {
      throw new Error(`Drop reason required: ${entry.name}`);
    }
    if (entry.action === "write" && (!entry.description.trim() || !entry.content.trim())) {
      throw new Error(`Complete description and content required: ${entry.name}`);
    }
    if (currentByName.has(entry.name) && !currentByName.get(entry.name)!.workshopOwned) {
      throw new Error(`User-authored skill must stay unchanged: ${entry.name}`);
    }
  }
  const dropped = new Set(
    input.filter((entry) => entry.action === "drop").map((entry) => entry.name),
  );
  for (const approvedNames of approvedSkillNamesByAgent ?? []) {
    if (approvedNames.size > 0 && ![...approvedNames].some((name) => !dropped.has(name))) {
      throw new Error("Every sharing agent must retain a visible skill after reconciliation.");
    }
  }
  return [...input];
}
