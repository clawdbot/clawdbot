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
  const unread = current.map((skill) => skill.name).filter((name) => !readSkillHashes.has(name));
  if (unread.length > 0) {
    throw new Error(`Read every current skill before reconciling: ${unread.join(", ")}`);
  }
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
    if (entry.action === "drop" && !entry.reason.trim()) {
      throw new Error(`Drop reason required: ${entry.name}`);
    }
    if (entry.action === "write" && (!entry.description.trim() || !entry.content.trim())) {
      throw new Error(`Complete description and content required: ${entry.name}`);
    }
  }
  const missing = current.map((skill) => skill.name).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`Every current skill needs one decision: ${missing.join(", ")}`);
  }
  for (const approvedNames of approvedSkillNamesByAgent ?? []) {
    if (
      approvedNames.size > 0 &&
      !input.some((entry) => entry.action !== "drop" && approvedNames.has(entry.name))
    ) {
      throw new Error("Every sharing agent must retain a visible skill after reconciliation.");
    }
  }
  return [...input];
}
