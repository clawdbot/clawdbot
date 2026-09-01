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
  const currentNames = new Set(current.map((skill) => skill.name));
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
  }
  return [...input];
}
