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
): SkillCollectionPlanEntry[] {
  if (input.length > maxDecisions) {
    throw new Error(`A skill collection can contain at most ${maxDecisions} decisions.`);
  }
  const currentSkillKeys = new Set(current.map((skill) => skill.skillKey));
  const seen = new Set<string>();
  for (const entry of input) {
    const normalized = normalizeSkillIndexName(entry.skillKey);
    if (!normalized || normalized !== entry.skillKey) {
      throw new Error(`Invalid skill key: ${entry.skillKey}`);
    }
    if (seen.has(entry.skillKey)) {
      throw new Error(`Duplicate skill decision: ${entry.skillKey}`);
    }
    seen.add(entry.skillKey);
    if (entry.action !== "write" && !currentSkillKeys.has(entry.skillKey)) {
      throw new Error(`Cannot ${entry.action} a skill that does not exist: ${entry.skillKey}`);
    }
    if (currentSkillKeys.has(entry.skillKey) && !readSkillHashes.has(entry.skillKey)) {
      throw new Error(`Read the skill before changing it: ${entry.skillKey}`);
    }
    if (entry.action === "drop" && !entry.reason.trim()) {
      throw new Error(`Drop reason required: ${entry.skillKey}`);
    }
    if (entry.action === "write" && (!entry.description.trim() || !entry.content.trim())) {
      throw new Error(`Complete description and content required: ${entry.skillKey}`);
    }
  }
  return [...input];
}
